import {
  condenseTtsText,
  type ActionResult,
  type ContextPacket,
  type CurrentTurnInput,
  type ExecutionConstraints,
  type HarnessResult,
  type LlmClient,
  type McpClientPort,
  type SourceRef,
  type SwarmTask,
  type WorkerExecutionSummary,
  type WorktreeHandle,
  type WorktreeIsolatorPort,
} from '@deskpet/contracts';
import type { McpGuideRegistry } from '../guide/BaseMcpGuide.js';
import type { WikiReader } from '../ports.js';
import type { Clock, IdGen } from '../runtime/clock.js';
import type { PipelinePermissionQueue, QueuedPermissionEntry } from './PipelinePermissionQueue.js';
import { SwarmWorker, type SwarmWorkerOutcome } from './SwarmWorker.js';

export interface SwarmCoordinatorDeps {
  mcpManager: McpClientPort;
  guideRegistry: McpGuideRegistry;
  permissionQueue: PipelinePermissionQueue;
  clock: Clock;
  ids: IdGen;
  llm?: LlmClient;
  wiki?: WikiReader;
  worktreeManager?: WorktreeIsolatorPort;
  maxWorkersPerSession?: number;
}

export interface SwarmStartInput {
  requestId: string;
  goal: string;
  turn: CurrentTurnInput;
  context: ContextPacket;
  constraints: ExecutionConstraints;
  wikiExcerpts?: { text: string; ref: string }[];
  signal?: AbortSignal;
}

interface ActiveSwarmSession {
  requestId: string;
  promise: Promise<HarnessResult>;
  settled: boolean;
}

const PLAN_SCHEMA = {
  name: 'deskpet_swarm_plan',
  schema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['single', 'multi'] },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            goal: { type: 'string' },
            mcpId: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } },
          },
          required: ['taskId', 'goal', 'dependsOn'],
          additionalProperties: false,
        },
      },
    },
    required: ['mode', 'tasks'],
    additionalProperties: false,
  },
} as const;

const COORDINATOR_INSTRUCTIONS = [
  '당신은 헤드리스 바이브 코딩 플랫폼 DeskPet의 Agent Swarm Coordinator입니다.',
  '사용자 목표와 현재 사용 가능한 MCP 서버·Guide 목록을 보고, 작업을 1개의 Worker로 바로 처리할지(`single`), 여러 병렬/순차 Worker로 분해할지(`multi`) 결정하세요.',
  '- 단일 목표나 단일 파일/모듈 수정은 `single`(task 1개)로 두어 불필요한 병합 충돌을 피하세요.',
  '- 서로 독립적인 여러 MCP 작업(예: 서로 다른 모듈 코드 수정, 코드 분석+PR 확인)은 `multi`로 분해해 병렬 실행하세요. 각 Worker는 독립된 `git worktree`에서 실행된 뒤 병합됩니다.',
  '- 선행 파일 수정 결과를 후속 검증/리뷰/수정이 이어받아야 하면 반드시 `dependsOn`에 선행 `taskId`를 지정하세요.',
].join('\n');

/**
 * Agent Swarm Coordinator.
 *
 * - 작업을 분해하고 자율 실행형 `SwarmWorker`들을 단일 또는 의존성 Wave 단위 병렬로 실행한다.
 * - Worker가 직접 MCP를 호출하고, 허가가 필요한 경우에만 `PipelinePermissionQueue`를 통해 일시 대기한다.
 * - 세션을 보관해 `resume` 이후에도 동일한 실행 컨텍스트와 나머지 병렬 결과를 이어받는다.
 */
export class SwarmCoordinator {
  private readonly sessions = new Map<string, ActiveSwarmSession>();
  private readonly maxWorkers: number;

  constructor(private readonly d: SwarmCoordinatorDeps) {
    this.maxWorkers = d.maxWorkersPerSession ?? 5;
  }

  hasActiveSession(requestId: string): boolean {
    const s = this.sessions.get(requestId);
    return Boolean(s && !s.settled);
  }

  /**
   * Swarm 실행을 시작하고, 완료되거나 첫 사용자 허가 요청(`awaiting_user`)이 발생할 때까지 대기한다.
   */
  async startAndWait(input: SwarmStartInput): Promise<HarnessResult> {
    const existing = this.sessions.get(input.requestId);
    if (existing && !existing.settled) {
      return this.awaitNextSuspensionOrFinish(input.requestId, existing);
    }

    const session: ActiveSwarmSession = {
      requestId: input.requestId,
      settled: false,
      promise: Promise.resolve({
        requestId: input.requestId,
        disposition: 'completed',
        actionResults: [],
        facts: {},
        sources: [],
        processingErrors: [],
      }),
    };

    session.promise = this.executeSwarmPlan(input).finally(() => {
      session.settled = true;
      this.sessions.delete(input.requestId);
    });
    this.sessions.set(input.requestId, session);

    return this.awaitNextSuspensionOrFinish(input.requestId, session);
  }

  /**
   * Pipeline에서 `resume` 응답이 들어와 Worker가 재개된 뒤, Swarm 완료 또는 다음 허가 요청을 기다린다.
   */
  async continueSession(requestId: string): Promise<HarnessResult | undefined> {
    const session = this.sessions.get(requestId);
    if (!session) return undefined;
    return this.awaitNextSuspensionOrFinish(requestId, session);
  }

  private async awaitNextSuspensionOrFinish(
    requestId: string,
    session: ActiveSwarmSession,
  ): Promise<HarnessResult> {
    const nextPerm = this.d.permissionQueue.waitForNextPermission(requestId);
    const race = await Promise.race([
      session.promise.then((res) => {
        session.settled = true;
        this.sessions.delete(requestId);
        return { kind: 'finished' as const, res };
      }),
      nextPerm.promise.then((entry) => ({ kind: 'permission' as const, entry })),
    ]);

    if (race.kind === 'finished') {
      nextPerm.cancel();
      return race.res;
    }

    return permissionSuspendedResult(requestId, race.entry);
  }

  private async executeSwarmPlan(input: SwarmStartInput): Promise<HarnessResult> {
    const wikiExcerpts = input.wikiExcerpts ?? (await this.fetchWikiIfAllowed(input));
    const tasks = await this.decomposeTasks(input);
    const worker = new SwarmWorker({
      mcpManager: this.d.mcpManager,
      guideRegistry: this.d.guideRegistry,
      permissionQueue: this.d.permissionQueue,
      clock: this.d.clock,
      ids: this.d.ids,
      ...(this.d.llm ? { llm: this.d.llm } : {}),
    });

    const completed = new Map<string, SwarmWorkerOutcome>();
    const pendingTasks = [...tasks.slice(0, this.maxWorkers)];

    // Wave execution respecting optional `dependsOn` edges
    while (completed.size < pendingTasks.length) {
      const ready = pendingTasks.filter(
        (t) => !completed.has(t.taskId) && (t.dependsOn ?? []).every((dep) => completed.has(dep)),
      );
      if (ready.length === 0) break;

      const outcomes = await Promise.all(
        ready.map(async (task) => {
          const depResults: Record<string, WorkerExecutionSummary> = {};
          for (const depId of task.dependsOn ?? []) {
            const dep = completed.get(depId);
            if (dep) depResults[depId] = dep.summary;
          }
          const workerId = this.d.ids.next('wrk');
          const worktree: WorktreeHandle | null = this.d.worktreeManager
            ? await this.d.worktreeManager.createWorkerWorktree(input.requestId, workerId).catch(() => null)
            : null;

          try {
            const outcome = await worker.run({
              requestId: input.requestId,
              task,
              workerId,
              ...(worktree ? { workingDir: worktree.worktreePath } : {}),
              turn: input.turn,
              context: input.context,
              constraints: input.constraints,
              ...(wikiExcerpts.length ? { wikiExcerpts } : {}),
              ...(Object.keys(depResults).length ? { dependencyResults: depResults } : {}),
              ...(input.signal ? { signal: input.signal } : {}),
            });

            if (worktree && this.d.worktreeManager) {
              if (outcome.summary.status === 'completed') {
                const merge = await this.d.worktreeManager.mergeAndCleanup(worktree);
                if (merge.changedFiles.length > 0) {
                  outcome.summary.changedFiles = merge.changedFiles;
                }
                if (!merge.merged) {
                  outcome.summary.worktreeConflicts = merge.conflicts;
                  outcome.summary.status = 'failed';
                  outcome.summary.error = merge.error ?? 'worktree merge conflict';
                  outcome.summary.summary = `수정 내용 병합 중 충돌이 발생했어요: ${merge.conflicts.slice(0, 3).join(', ')}.`;
                } else if (merge.changedFiles.length > 0) {
                  const prevWs = (outcome.facts['workspace'] as Record<string, unknown> | undefined) ?? {};
                  outcome.facts['workspace'] = { ...prevWs, changedFiles: merge.changedFiles, worktreeIsolated: true };
                }
              } else {
                await this.d.worktreeManager.cleanupWorktree(worktree);
              }
            }

            return { taskId: task.taskId, outcome };
          } catch (err) {
            if (worktree && this.d.worktreeManager) {
              await this.d.worktreeManager.cleanupWorktree(worktree);
            }
            throw err;
          }
        }),
      );

      for (const { taskId, outcome } of outcomes) {
        completed.set(taskId, outcome);
      }
    }

    return this.aggregateOutcomes(input.requestId, [...completed.values()], wikiExcerpts, input.constraints.deadlineAt, input.signal);
  }

  private async decomposeTasks(input: SwarmStartInput): Promise<SwarmTask[]> {
    const serverIds = this.d.mcpManager.listServerIds();
    const defaultTask: SwarmTask = {
      taskId: 'task-1',
      goal: input.goal,
      ...(input.context.target?.kind === 'mcp_tool'
        ? { mcpId: input.context.target.mcpId }
        : input.context.target?.kind === 'github_pr'
          ? { mcpId: 'github' }
          : {}),
    };
    if (!this.d.llm) return [defaultTask];

    const nowMs = this.d.clock.nowMs();
    const planDeadline = new Date(Math.min(Date.parse(input.constraints.deadlineAt), nowMs + 6_000)).toISOString();
    try {
      const res = await this.d.llm.complete({
        purpose: 'guide',
        instructions: COORDINATOR_INSTRUCTIONS,
        input: JSON.stringify({
          goal: input.goal,
          activeTarget: input.context.target ?? null,
          availableMcpServers: serverIds,
          registeredGuides: this.d.guideRegistry.list().map((g) => ({ mcpId: g.mcpId, description: g.description ?? '' })),
        }),
        jsonSchema: PLAN_SCHEMA as { name: string; schema: Record<string, unknown> },
        maxOutputTokens: 512,
        deadlineAt: planDeadline,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const parsed = (res.json ?? JSON.parse(res.text)) as { tasks?: SwarmTask[] };
      if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
        return parsed.tasks.map((t, idx) => ({
          taskId: t.taskId || `task-${idx + 1}`,
          goal: t.goal || input.goal,
          ...(t.mcpId ? { mcpId: t.mcpId } : {}),
          ...(t.dependsOn?.length ? { dependsOn: t.dependsOn } : {}),
        }));
      }
    } catch {
      // Planning failure gracefully executes single direct worker without failing the user request
    }
    return [defaultTask];
  }

  private async fetchWikiIfAllowed(input: SwarmStartInput): Promise<{ text: string; ref: string }[]> {
    if (!this.d.wiki || input.constraints.wikiSearchAllowed === false || !input.turn.rawText.trim()) return [];
    try {
      const w = await this.d.wiki.search(input.turn.rawText, 'swarm', {
        deadlineAt: input.constraints.deadlineAt,
      });
      return w.excerpts.slice(0, 3).map((e) => ({ text: e.text.slice(0, 500), ref: e.source.ref }));
    } catch {
      return [];
    }
  }

  private async aggregateOutcomes(
    requestId: string,
    outcomes: SwarmWorkerOutcome[],
    wikiExcerpts: { text: string; ref: string }[],
    deadlineAt: string,
    signal?: AbortSignal,
  ): Promise<HarnessResult> {
    const actionResults: ActionResult[] = [];
    const sources: SourceRef[] = [];
    const mergedFacts: Record<string, unknown> = {};
    const workerSummaries: WorkerExecutionSummary[] = [];
    const allChangedFiles = new Set<string>();
    const allConflicts = new Set<string>();

    for (const o of outcomes) {
      workerSummaries.push(o.summary);
      actionResults.push(...o.actionResults);
      sources.push(...o.sources);
      Object.assign(mergedFacts, o.facts);
      for (const f of o.summary.changedFiles ?? []) allChangedFiles.add(f);
      for (const c of o.summary.worktreeConflicts ?? []) allConflicts.add(c);
    }
    if (wikiExcerpts.length) mergedFacts['wiki'] = { excerpts: wikiExcerpts };
    if (allChangedFiles.size > 0 || allConflicts.size > 0) {
      const prevWs = (mergedFacts['workspace'] as Record<string, unknown> | undefined) ?? {};
      mergedFacts['workspace'] = {
        ...prevWs,
        changedFiles: [...allChangedFiles],
        ...(allConflicts.size > 0 ? { conflicts: [...allConflicts] } : {}),
      };
    }

    const displaySummary =
      workerSummaries
        .map((w) => w.displaySummary || w.summary)
        .filter(Boolean)
        .join('\n')
        .trim() || '작업을 완료했어요.';

    const rawSpeech =
      workerSummaries
        .map((w) => w.summary)
        .filter(Boolean)
        .join(' ')
        .trim() || '작업을 완료했어요.';

    const summaryText = await this.buildConciseTtsSummary(rawSpeech, [...allChangedFiles], deadlineAt, signal);

    const blocked = workerSummaries.filter((w) => w.status === 'blocked');
    const failed = workerSummaries.filter((w) => w.status === 'failed');
    const pendingOutcome = outcomes.find((o) => o.pending);

    mergedFacts['swarm'] = {
      workerCount: workerSummaries.length,
      workers: workerSummaries,
      summaryText,
      displaySummary,
      ...(allChangedFiles.size > 0 ? { changedFiles: [...allChangedFiles] } : {}),
    };
    if (pendingOutcome?.pending) {
      const p = pendingOutcome.pending;
      if (!mergedFacts['question']) {
        mergedFacts['question'] = {
          purpose: p.purpose,
          kind: p.kind,
          requiredSlots: p.requiredSlots,
          ...(p.scope ? { scope: p.scope } : {}),
        };
      }
      return {
        requestId,
        disposition: 'awaiting_user',
        actionResults,
        pending: p,
        facts: mergedFacts,
        sources,
        processingErrors: [],
      };
    }
    if (blocked.length && blocked.length === workerSummaries.length) {
      mergedFacts['blocked'] = {
        reasons: blocked.flatMap((b) => b.blockedReasons ?? ['blocked']),
      };
    }

    const allFailed = workerSummaries.length > 0 && failed.length === workerSummaries.length;
    return {
      requestId,
      disposition: allFailed ? 'failed' : 'completed',
      actionResults,
      facts: mergedFacts,
      sources,
      processingErrors: allFailed
        ? failed.map((f) => ({
            stage: 'harness.swarm',
            provisionalCode: 'INTERNAL' as const,
            message: f.error ?? f.summary,
            nextAction: 'none' as const,
          }))
        : [],
    };
  }

  private async buildConciseTtsSummary(
    raw: string,
    changedFiles: string[],
    deadlineAt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const condensed = condenseTtsText(raw, 180);
    if (condensed === raw.replace(/\s+/g, ' ').trim() && condensed.length <= 180) return condensed;

    if (this.d.llm) {
      const nowMs = this.d.clock.nowMs();
      const summaryDeadline = new Date(Math.min(Date.parse(deadlineAt), nowMs + 4_000)).toISOString();
      if (Date.parse(summaryDeadline) > nowMs + 300) {
        try {
          const res = await this.d.llm.complete({
            purpose: 'guide',
            instructions:
              '다음 실행 결과를 음성 TTS 출력용으로 1~2문장(160자 이내)의 간결한 한국어 존댓말로 요약하세요. 코드, 파일 전체 내용, 마크다운 기호, diff 줄은 절대 넣지 마세요.',
            input: JSON.stringify({
              summary: raw.slice(0, 2000),
              changedFileCount: changedFiles.length,
              changedFiles: changedFiles.slice(0, 10),
            }),
            maxOutputTokens: 160,
            deadlineAt: summaryDeadline,
            ...(signal ? { signal } : {}),
          });
          const candidate = condenseTtsText(res.text, 200);
          if (candidate) return candidate;
        } catch {
          // Deterministic condensation fallback handles any LLM timeout/failure cleanly
        }
      }
    }

    return condensed;
  }
}

function permissionSuspendedResult(requestId: string, entry: QueuedPermissionEntry): HarnessResult {
  return {
    requestId,
    disposition: 'awaiting_user',
    actionResults: [],
    pending: entry.pending,
    facts: {
      ...(entry.facts ?? {}),
      question: {
        kind: entry.pending.kind,
        purpose: entry.pending.purpose,
        requiredSlots: entry.pending.requiredSlots,
        questionText: entry.questionText,
        workerId: entry.workerId,
        ...(entry.scope ? { scope: entry.scope } : {}),
      },
    },
    sources: [],
    processingErrors: [],
  };
}
