import {
  ActionResult as ActionResultSchema,
  type ActionResult,
  type CallConstraints,
  type ContextPacket,
  type CurrentTurnInput,
  type ExecutionConstraints,
  type LlmClient,
  type McpCallResult,
  type McpClientPort,
  type McpToolDescriptor,
  type PendingView,
  type PermissionSpec,
  type SourceRef,
  type SwarmTask,
  type WorkerExecutionSummary,
} from '@deskpet/contracts';
import type { McpGuideRegistry } from '../guide/BaseMcpGuide.js';
import type { FastPathToolDescriptor, FastPathToolHandler, McpGuide, PlannedToolCall, WorkerContext } from '../guide/McpGuide.js';
import type { Clock, IdGen } from '../runtime/clock.js';
import type { PipelinePermissionQueue } from './PipelinePermissionQueue.js';

export interface SwarmWorkerDeps {
  mcpManager: McpClientPort;
  guideRegistry: McpGuideRegistry;
  permissionQueue: PipelinePermissionQueue;
  clock: Clock;
  ids: IdGen;
  llm?: LlmClient;
  maxStepsPerWorker?: number;
}

export interface SwarmWorkerRunInput {
  requestId: string;
  task: SwarmTask;
  turn: CurrentTurnInput;
  context: ContextPacket;
  constraints: ExecutionConstraints;
  wikiExcerpts?: { text: string; ref: string }[];
  dependencyResults?: Record<string, WorkerExecutionSummary>;
  /** Coordinator가 미리 생성한 Worker ID (git worktree 매핑 시 전달) */
  workerId?: string;
  /** Worker에 격리 할당된 작업 디렉토리 (git worktree 경로) */
  workingDir?: string;
  signal?: AbortSignal;
  /** 개별 단계 LLM/도구 호출에 부여할 최소 호출 창(ms). 진행이 이어지는 한 총 경과 시간으로 끊지 않는다. */
  stepBudgetMs?: number;
  /** 진행 상황 heartbeat 콜백 (무진행 타임아웃 초기화 및 중단 작업 추적용) */
  onProgress?: (info: { activity: string; toolName?: string; stepCompleted?: number }) => void;
  /** 사용자 응답 대기 시작/종료 알림 (대기 중에는 무진행 타임아웃 정지) */
  onWaitingUser?: (waiting: boolean) => void;
}

export interface SwarmWorkerOutcome {
  summary: WorkerExecutionSummary;
  actionResults: ActionResult[];
  facts: Record<string, unknown>;
  sources: SourceRef[];
  pending?: PendingView;
}

const WORKER_STEP_SCHEMA = {
  name: 'deskpet_swarm_worker_step',
  schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['call_tool', 'need_user', 'finish'] },
      toolName: { type: 'string' },
      mcpId: { type: 'string' },
      argumentsJson: { type: 'string' },
      questionText: { type: 'string' },
      summary: { type: 'string' },
      displaySummary: { type: 'string' },
      reasoning: { type: 'string' },
    },
    required: ['kind', 'reasoning'],
    additionalProperties: false,
  },
} as const;

/**
 * 자율 실행형 Swarm Worker.
 *
 * - 중앙 소유 병목 없이 할당된 목표와 해당 MCP의 Guide를 기반으로 직접 MCP 도구를 호출한다.
 * - Guide에 명시된 가드(`evaluateGuards`) 및 허가 조건(`requiresPermission`) 외의 임의 제한을 두지 않는다.
 * - 사용자 허가나 추가 슬롯 입력이 필요할 때만 PipelinePermissionQueue에 요청을 넣고 응답 수신 시 즉시 재개한다.
 */
export class SwarmWorker {
  private readonly maxSteps: number;

  constructor(private readonly d: SwarmWorkerDeps) {
    this.maxSteps = d.maxStepsPerWorker ?? 25;
  }

  async run(input: SwarmWorkerRunInput): Promise<SwarmWorkerOutcome> {
    const workerId = input.workerId ?? this.d.ids.next('wrk');
    const inferredMcpId = input.task.mcpId ?? inferMcpId(input.context, this.d.mcpManager.listServerIds());
    const guide = this.d.guideRegistry.resolve(inferredMcpId);
    const stepBudgetMs = input.stepBudgetMs ?? 120_000;
    const baseDeadlineMs = Date.parse(input.constraints.deadlineAt);
    const stepConstraints = (): CallConstraints => {
      const targetMs = Math.max(Number.isFinite(baseDeadlineMs) ? baseDeadlineMs : 0, this.d.clock.nowMs() + stepBudgetMs);
      return {
        deadlineAt: new Date(targetMs).toISOString(),
        ...(input.signal ? { signal: input.signal } : {}),
      };
    };

    let lastActivity = '도구 목록 탐색';
    let lastToolName: string | undefined;
    const reportProgress = (activity: string, toolName?: string, stepCompleted?: number) => {
      lastActivity = activity;
      if (toolName) lastToolName = toolName;
      input.onProgress?.({ activity, ...(toolName ? { toolName } : {}), ...(stepCompleted !== undefined ? { stepCompleted } : {}) });
    };

    const awaitPermission = async (req: Parameters<PipelinePermissionQueue['requestPermission']>[1]) => {
      reportProgress('사용자 확인 대기');
      input.onWaitingUser?.(true);
      try {
        return await this.d.permissionQueue.requestPermission(input.requestId, req, input.signal);
      } finally {
        input.onWaitingUser?.(false);
        if (!input.signal?.aborted) reportProgress('사용자 응답 수신');
      }
    };

    reportProgress('도구 목록 탐색');
    const mcpTools = await this.discoverTools(stepConstraints());
    const fastPathMap = collectAllFastPaths(this.d.guideRegistry, guide);
    const fastPathDescriptors: FastPathToolDescriptor[] = Object.values(fastPathMap).map((h) => h.descriptor);

    const workerCtx: WorkerContext = {
      requestId: input.requestId,
      conversationId: input.turn.conversationId,
      workerId,
      turn: input.turn,
      context: input.context,
      constraints: input.constraints,
      observations: {},
      ...(input.workingDir ? { workingDir: input.workingDir } : {}),
    };

    const instructions = guide.buildInstructions({
      goal: input.task.goal,
      mcpId: inferredMcpId,
      turn: input.turn,
      context: input.context,
      availableTools: mcpTools,
      fastPathTools: fastPathDescriptors,
      ...(input.wikiExcerpts?.length ? { wikiExcerpts: input.wikiExcerpts } : {}),
      workerId,
      ...(input.workingDir ? { workingDir: input.workingDir } : {}),
    });

    const history: Record<string, unknown>[] = [];
    const recordedCalls: WorkerExecutionSummary['toolCalls'] = [];
    const actionResults: ActionResult[] = [];
    const collectedFacts: Record<string, unknown> = {};
    const collectedSources: SourceRef[] = [];

    if (!this.d.llm) {
      return this.buildLlmUnavailableOutcome(workerId, input.task.taskId, inferredMcpId);
    }

    const interruptedOutcome = (): SwarmWorkerOutcome => {
      const reason = abortReasonCode(input.signal);
      const isIdleTimeout = reason === 'inactivity_timeout';
      const toolNote = lastToolName ? ` (마지막 도구: ${lastToolName})` : '';
      return this.finalize(
        guide,
        {
          workerId,
          taskId: input.task.taskId,
          mcpId: inferredMcpId,
          status: 'failed',
          interrupted: true,
          lastActivity,
          summary: isIdleTimeout
            ? `진행 상황이 없어 '${input.task.goal}' 작업을 중단했어요${toolNote}.`
            : `요청이 취소되어 '${input.task.goal}' 작업을 중단했어요${toolNote}.`,
          toolCalls: recordedCalls,
          error: reason,
        },
        actionResults,
        collectedFacts,
        collectedSources,
      );
    };

    for (let step = 0; step < this.maxSteps; step++) {
      if (input.signal?.aborted) return interruptedOutcome();

      const callConstraints = stepConstraints();
      reportProgress(`단계 ${step + 1} 계획 중`);
      let decision: {
        kind: 'call_tool' | 'need_user' | 'finish';
        toolName?: string;
        mcpId?: string;
        argumentsJson?: string;
        questionText?: string;
        summary?: string;
        displaySummary?: string;
        reasoning: string;
      };
      try {
        decision = await this.planNextStep(instructions, input, history, workerCtx.observations, callConstraints);
      } catch (e) {
        if (input.signal?.aborted) return interruptedOutcome();
        return this.finalize(
          guide,
          {
            workerId,
            taskId: input.task.taskId,
            mcpId: inferredMcpId,
            status: 'failed',
            lastActivity,
            summary: '작업을 계획하는 중 오류가 발생했어요.',
            toolCalls: recordedCalls,
            error: e instanceof Error ? e.message : String(e),
          },
          actionResults,
          collectedFacts,
          collectedSources,
        );
      }

      if (input.signal?.aborted) return interruptedOutcome();
      reportProgress(`단계 ${step + 1} 결정 (${decision.kind})`, decision.toolName);

      if (decision.kind === 'finish') {
        const summary = decision.summary?.trim() || '작업을 완료했어요.';
        return this.finalize(
          guide,
          {
            workerId,
            taskId: input.task.taskId,
            mcpId: inferredMcpId,
            status: 'completed',
            summary,
            ...(decision.displaySummary?.trim() ? { displaySummary: decision.displaySummary.trim() } : {}),
            toolCalls: recordedCalls,
            data: collectedFacts,
          },
          actionResults,
          collectedFacts,
          collectedSources,
        );
      }

      if (decision.kind === 'need_user') {
        const questionText = decision.questionText?.trim() || '진행을 위해 필요한 정보를 조금 더 알려주시겠어요?';
        const res = await awaitPermission({
          workerId,
          mcpId: inferredMcpId,
          toolName: 'worker_clarification',
          spec: {
            kind: 'clarification',
            purpose: 'worker_clarification',
            questionText,
          },
        });
        if (input.signal?.aborted) return interruptedOutcome();
        history.push({ step, action: 'need_user', question: questionText, resolution: res });
        if (res.updatedContext) {
          input.context = res.updatedContext;
          workerCtx.context = res.updatedContext;
        }
        if (res.updatedTurn) {
          input.turn = res.updatedTurn;
          workerCtx.turn = res.updatedTurn;
        }
        if (res.verdict === 'revoked' || res.verdict === 'expired') {
          return this.finalize(
            guide,
            {
              workerId,
              taskId: input.task.taskId,
              mcpId: inferredMcpId,
              status: 'failed',
              summary: '사용자 응답을 받지 못해 작업을 종료했어요.',
              toolCalls: recordedCalls,
              error: res.rationale,
            },
            actionResults,
            collectedFacts,
            collectedSources,
          );
        }
        continue;
      }

      // ---- call_tool
      const targetMcpId = decision.mcpId?.trim() || inferredMcpId;
      const toolName = decision.toolName?.trim() || '';
      if (!toolName) {
        history.push({ step, error: 'toolName is empty' });
        continue;
      }
      const parsedArgs = parseJsonArgs(decision.argumentsJson);
      const ownerGuide = !decision.mcpId ? guideForFastPath(this.d.guideRegistry, toolName) : undefined;
      const activeGuide = ownerGuide ?? (targetMcpId === inferredMcpId ? guide : this.d.guideRegistry.resolve(targetMcpId));
      const effectiveMcpId = ownerGuide ? ownerGuide.mcpId : targetMcpId;
      const plannedCall: PlannedToolCall = { mcpId: effectiveMcpId, toolName, arguments: parsedArgs };

      // Guide에 명시된 guard만 검사 (미구현 시 무조건 통과)
      if (activeGuide.evaluateGuards) {
        const guard = activeGuide.evaluateGuards({
          mcpId: effectiveMcpId,
          goal: input.task.goal,
          turn: input.turn,
          context: input.context,
          constraints: input.constraints,
          plannedCall,
          observations: workerCtx.observations,
        });
        if (!guard.allowed) {
          if (guard.clarifyPrompt) {
            const clarifyRes = await awaitPermission({
              workerId,
              mcpId: targetMcpId,
              toolName,
              spec: {
                kind: 'clarification',
                purpose: guard.clarifyPurpose ?? 'guide_guard_clarification',
                ...(guard.clarifySlots ? { requiredSlots: guard.clarifySlots } : {}),
                questionText: guard.clarifyPrompt,
              },
            });
            if (input.signal?.aborted) return interruptedOutcome();
            history.push({ step, guardBlocked: guard.reasons, userFollowUp: clarifyRes });
            if (clarifyRes.verdict === 'revoked' || clarifyRes.verdict === 'expired') {
              return this.finalize(
                activeGuide,
                {
                  workerId,
                  taskId: input.task.taskId,
                  mcpId: targetMcpId,
                  status: 'blocked',
                  summary: guard.clarifyPrompt,
                  toolCalls: recordedCalls,
                  blockedReasons: guard.reasons,
                },
                actionResults,
                collectedFacts,
                collectedSources,
              );
            }
            continue;
          }
          return this.finalize(
            activeGuide,
            {
              workerId,
              taskId: input.task.taskId,
              mcpId: targetMcpId,
              status: 'blocked',
              summary: `Guide 조건으로 차단되었습니다: ${guard.reasons.join(', ')}`,
              toolCalls: recordedCalls,
              blockedReasons: guard.reasons,
            },
            actionResults,
            collectedFacts,
            collectedSources,
          );
        }
      }

      // Guide가 명시적으로 사용자 허가를 요구할 때만 PipelinePermissionQueue 사용
      const permSpec: PermissionSpec | null = activeGuide.requiresPermission?.(plannedCall, workerCtx) ?? null;
      if (permSpec) {
        const permRes = await awaitPermission({
          workerId,
          mcpId: effectiveMcpId,
          toolName,
          spec: {
            ...permSpec,
            facts: { ...collectedFacts, ...(permSpec.facts ?? {}) },
          },
        });
        if (input.signal?.aborted) return interruptedOutcome();
        if (permSpec.kind === 'clarification') {
          history.push({ step, clarification: permSpec.questionText, resolution: permRes });
          if (permRes.updatedContext) {
            input.context = permRes.updatedContext;
            workerCtx.context = permRes.updatedContext;
          }
          if (permRes.updatedTurn) {
            input.turn = permRes.updatedTurn;
            workerCtx.turn = permRes.updatedTurn;
          }
          if (permRes.verdict === 'revoked' || permRes.verdict === 'expired') {
            return this.finalize(
              activeGuide,
              {
                workerId,
                taskId: input.task.taskId,
                mcpId: targetMcpId,
                status: 'failed',
                summary: '필요한 정보가 확인되지 않아 작업을 중단했어요.',
                toolCalls: recordedCalls,
                error: permRes.rationale,
              },
              actionResults,
              collectedFacts,
              collectedSources,
            );
          }
          continue;
        }
        if (!permRes.approved) {
          history.push({ step, tool: toolName, permissionDenied: permRes.verdict, reason: permRes.rationale });
          if (permRes.verdict === 'rejected') {
            if (permSpec.scope) {
              collectedFacts['declined'] = { action: permSpec.scope.action, target: permSpec.scope.target };
              collectedFacts['noExternalChanges'] = true;
            }
            return this.finalize(
              activeGuide,
              {
                workerId,
                taskId: input.task.taskId,
                mcpId: effectiveMcpId,
                status: 'completed',
                summary: '요청하신 작업을 실행하지 않고 취소했어요.',
                toolCalls: recordedCalls,
              },
              actionResults,
              collectedFacts,
              collectedSources,
            );
          }
          continue;
        }
      }

      // ---- 직접 실행 (Fast-Path 어댑터 우선 매칭, 없으면 McpClientManager.callTool 직접 실행)
      const fastPath = activeGuide.fastPathAdapters?.[toolName] ?? fastPathMap[toolName];
      reportProgress(`도구 실행 중 (${toolName})`, toolName);
      let callRes: McpCallResult;
      let providedActions: ActionResult[] | undefined;
      let followUpPending: PendingView | undefined;
      try {
        if (fastPath) {
          const fpOut = await fastPath.execute(parsedArgs, workerCtx, callConstraints);
          callRes = fpOut.result;
          if (fpOut.facts) Object.assign(collectedFacts, fpOut.facts);
          if (fpOut.sources?.length) collectedSources.push(...fpOut.sources);
          if (fpOut.actionResults !== undefined) providedActions = fpOut.actionResults;
          if (fpOut.pending) followUpPending = fpOut.pending;
        } else {
          callRes = await this.d.mcpManager.callTool(
            { mcpId: targetMcpId, toolName, arguments: parsedArgs, deadlineAt: callConstraints.deadlineAt },
            callConstraints,
          );
          collectedSources.push({
            kind: 'mcp',
            ref: `${targetMcpId}::${toolName}`,
            observedAt: callRes.observedAt,
          });
        }
      } catch (e) {
        if (input.signal?.aborted) return interruptedOutcome();
        throw e;
      }
      if (input.signal?.aborted) return interruptedOutcome();
      reportProgress(`도구 실행 완료 (${toolName})`, toolName, step + 1);

      recordedCalls.push({
        toolName,
        arguments: parsedArgs,
        ok: callRes.ok,
        ...(callRes.usedFastPath ? { usedFastPath: true } : {}),
        summary: summarizeCallResult(callRes, 500),
      });

      if (providedActions) {
        actionResults.push(...providedActions);
      } else {
        const ar = toMcpActionResult(
          this.d.ids.next('op'),
          effectiveMcpId,
          toolName,
          callRes,
          this.d.clock.nowIso(),
        );
        if (ar) actionResults.push(ar);
      }

      if (followUpPending) {
        const out = this.finalize(
          activeGuide,
          {
            workerId,
            taskId: input.task.taskId,
            mcpId: effectiveMcpId,
            status: 'completed',
            summary: summarizeCallResult(callRes, 180) || '후속 확인이 필요해요.',
            toolCalls: recordedCalls,
            data: collectedFacts,
          },
          actionResults,
          collectedFacts,
          collectedSources,
        );
        return { ...out, pending: followUpPending };
      }

      const fullObservation = summarizeCallResult(callRes, 6_000);
      workerCtx.observations['lastToolResult'] = {
        step,
        mcpId: effectiveMcpId,
        toolName,
        ok: callRes.ok,
        output: callRes.structuredContent ?? fullObservation,
        ...(callRes.error ? { error: callRes.error } : {}),
      };

      history.push({
        step,
        toolName,
        mcpId: effectiveMcpId,
        arguments: parsedArgs,
        ok: callRes.ok,
        ...(callRes.usedFastPath ? { usedFastPath: true } : {}),
        output: summarizeCallResult(callRes, 500),
        ...(callRes.error ? { error: callRes.error } : {}),
      });
    }

    return this.finalize(
      guide,
      {
        workerId,
        taskId: input.task.taskId,
        mcpId: inferredMcpId,
        status: 'failed',
        summary: `최대 실행 단계(${this.maxSteps})에 도달해 작업을 종료했어요.`,
        toolCalls: recordedCalls,
        error: 'max_worker_steps_reached',
      },
      actionResults,
      collectedFacts,
      collectedSources,
    );
  }

  /** 연결된 모든 MCP 서버의 도구를 제한 없이 탐색해 Worker가 자유롭게 조합·호출할 수 있게 한다 */
  private async discoverTools(c: CallConstraints): Promise<McpToolDescriptor[]> {
    try {
      return await this.d.mcpManager.listTools(undefined, c);
    } catch {
      return [];
    }
  }

  private async planNextStep(
    instructions: string,
    input: SwarmWorkerRunInput,
    history: Record<string, unknown>[],
    observations: Record<string, unknown>,
    c: CallConstraints,
  ): Promise<{
    kind: 'call_tool' | 'need_user' | 'finish';
    toolName?: string;
    mcpId?: string;
    argumentsJson?: string;
    questionText?: string;
    summary?: string;
    reasoning: string;
  }> {
    const res = await this.d.llm!.complete({
      purpose: 'guide',
      instructions,
      input: JSON.stringify({
        goal: input.task.goal,
        task: {
          taskId: input.task.taskId,
          ...(input.task.mcpId ? { mcpId: input.task.mcpId } : {}),
          goal: input.task.goal,
        },
        hints: input.task.hints ?? null,
        userText: input.turn.rawText,
        activeTarget: input.context.target ?? null,
        taskRefs: input.context.taskRefs,
        recentTurns: input.context.relatedTurns.slice(-4),
        dependencyResults: input.dependencyResults ?? null,
        observations,
        executionHistory: history,
      }),
      jsonSchema: WORKER_STEP_SCHEMA as { name: string; schema: Record<string, unknown> },
      maxOutputTokens: 1024,
      deadlineAt: c.deadlineAt,
      ...(c.signal ? { signal: c.signal } : {}),
    });
    const raw = (res.json ?? JSON.parse(res.text)) as Record<string, unknown>;
    const kind = raw['kind'];
    if (kind !== 'call_tool' && kind !== 'need_user' && kind !== 'finish') {
      throw new Error(`invalid worker step kind: ${String(kind)}`);
    }
    return {
      kind,
      ...(typeof raw['toolName'] === 'string' ? { toolName: raw['toolName'] } : {}),
      ...(typeof raw['mcpId'] === 'string' ? { mcpId: raw['mcpId'] } : {}),
      ...(typeof raw['argumentsJson'] === 'string' ? { argumentsJson: raw['argumentsJson'] } : {}),
      ...(typeof raw['questionText'] === 'string' ? { questionText: raw['questionText'] } : {}),
      ...(typeof raw['summary'] === 'string' ? { summary: raw['summary'] } : {}),
      ...(typeof raw['displaySummary'] === 'string' ? { displaySummary: raw['displaySummary'] } : {}),
      reasoning: typeof raw['reasoning'] === 'string' ? raw['reasoning'] : '',
    };
  }

  private finalize(
    guide: McpGuide,
    summary: WorkerExecutionSummary,
    actionResults: ActionResult[],
    facts: Record<string, unknown>,
    sources: SourceRef[],
  ): SwarmWorkerOutcome {
    const formatted = guide.formatOutcome?.(summary);
    if (formatted) {
      summary.summary = formatted.summary;
      if (formatted.facts) Object.assign(facts, formatted.facts);
      if (formatted.sources?.length) sources.push(...formatted.sources);
    }
    return { summary, actionResults, facts, sources };
  }

  private buildLlmUnavailableOutcome(workerId: string, taskId: string, mcpId: string): SwarmWorkerOutcome {
    return {
      summary: {
        workerId,
        taskId,
        mcpId,
        status: 'failed',
        summary: '추론 모델(LLM)이 설정되지 않아 자율 MCP 작업을 실행할 수 없어요.',
        toolCalls: [],
        error: 'llm_not_configured',
      },
      actionResults: [],
      facts: {},
      sources: [],
    };
  }
}

function abortReasonCode(signal?: AbortSignal): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message === 'inactivity_timeout') return 'inactivity_timeout';
  if (typeof reason === 'string' && reason === 'inactivity_timeout') return 'inactivity_timeout';
  return 'aborted';
}

function collectAllFastPaths(
  registry: McpGuideRegistry,
  preferredGuide: McpGuide,
): Record<string, FastPathToolHandler> {
  const merged: Record<string, FastPathToolHandler> = {};
  for (const g of registry.list()) {
    if (g.fastPathAdapters) {
      for (const [name, handler] of Object.entries(g.fastPathAdapters)) {
        if (!merged[name]) merged[name] = handler;
      }
    }
  }
  if (preferredGuide.fastPathAdapters) {
    for (const [name, handler] of Object.entries(preferredGuide.fastPathAdapters)) {
      merged[name] = handler;
    }
  }
  return merged;
}

function guideForFastPath(registry: McpGuideRegistry, toolName: string): McpGuide | undefined {
  return registry.list().find((g) => Boolean(g.fastPathAdapters?.[toolName]));
}

function inferMcpId(context: ContextPacket, registeredIds: string[]): string {
  if (context.target?.kind === 'mcp_tool') return context.target.mcpId;
  if (context.target?.kind === 'github_pr') return 'github';
  if (registeredIds.length === 1) return registeredIds[0]!;
  return '*';
}

function parseJsonArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function summarizeCallResult(r: McpCallResult, maxChars = 600): string {
  if (r.error) return r.error.slice(0, maxChars);
  const texts = r.content.map((b) => b.text).filter((t): t is string => Boolean(t));
  if (texts.length) return texts.join('\n').slice(0, maxChars);
  if (r.structuredContent) return JSON.stringify(r.structuredContent).slice(0, maxChars);
  return r.ok ? 'ok' : 'error';
}

function toMcpActionResult(
  operationId: string,
  mcpId: string,
  toolName: string,
  res: McpCallResult,
  observedAt: string,
): ActionResult | undefined {
  const candidate = ActionResultSchema.safeParse({
    operationId,
    action: 'mcp_tool_call',
    target: { kind: 'mcp_tool', mcpId, toolName },
    status: res.ok ? 'succeeded' : 'failed',
    dispatchState: 'sent',
    facts: res.structuredContent ?? { summary: summarizeCallResult(res) },
    externalRefs: [{ system: 'mcp', kind: 'tool_call', id: `${mcpId}::${toolName}` }],
    observedAt,
  });
  return candidate.success ? candidate.data : undefined;
}
