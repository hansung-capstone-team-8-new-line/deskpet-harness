import {
  ActionResult as ActionResultSchema,
  HarnessRequest as HarnessRequestSchema,
  HarnessResumeRequest as HarnessResumeSchema,
  PipelineEvent as PipelineEventSchema,
  confirmationTokens,
  deliveredQuestionMatches,
  evidenceNoteContent,
  extractPrLinks,
  isRepositoryAllowed,
  isSameEvidenceNote,
  isWriteAction,
  type ActionName,
  type ActionResult,
  type CallConstraints,
  type ConfirmationRecord,
  type ConfirmationScope,
  type ContextPacket,
  type CurrentTurnInput,
  type DispatchHandle,
  type ErrorInfo,
  type EurekaGatewayPort,
  type EurekaStageTarget,
  type ExecutionAuthority,
  type ExecutionConstraints,
  type FollowUpNotice,
  type GatewayResult,
  type GitHubPrTarget,
  type GitHubReviewGatewayPort,
  type HarnessRequest,
  type HarnessResult,
  type HarnessResumeRequest,
  type LlmClient,
  type McpClientPort,
  type OperationRecord,
  type Pending,
  type PendingView,
  type PipelineEvent,
  type ProvisionalErrorCode,
  type SensorAssessment,
  type SourceRef,
  type Target,
  type TaskRef,
  type WorkspaceGatewayPort,
  type WorktreeIsolatorPort,
} from '@deskpet/contracts';
import { StoreDispatchOwner } from './dispatch/DispatchOwner.js';
import { reviewFacts, type ReviewFacts } from './facts.js';
import { DirectEurekaExecutor } from './eureka/DirectEurekaExecutor.js';
import { McpGuideRegistry } from './guide/BaseMcpGuide.js';
import type { DispatchAuthoritySource } from './guide/fastPathDispatch.js';
import { GitHubMcpGuide } from './guide/GitHubMcpGuide.js';
import type { Guide } from './guide/Guide.js';
import { WorkspaceMcpGuide } from './guide/WorkspaceMcpGuide.js';
import { DEFAULT_POLICY, type PolicyConfig } from './policy/config.js';
import { expectedOutcomeFor } from './policy/expectedOutcome.js';
import { classifyAnswer } from './policy/inputPolicy.js';
import type { WikiReader } from './ports.js';
import type { Clock, IdGen } from './runtime/clock.js';
import { collectTimings, timedPort, type TimingSink } from './runtime/timing.js';
import { DeterministicSensor, type Sensor } from './sensor/Sensor.js';
import type { OperationStore, PrepareCommand } from './store/OperationStore.js';
import { IntentTriage } from './swarm/IntentTriage.js';
import { PipelinePermissionQueue } from './swarm/PipelinePermissionQueue.js';
import { SwarmCoordinator } from './swarm/SwarmCoordinator.js';

/**
 * HarnessService — 범용 MCP Guide 템플릿 · IntentTriage(`unclear` 4분기) · 자율 실행형 Agent Swarm 조율기.
 *
 * 아키텍처 원칙:
 * - Router 진입 의도는 `llm` / `unclear`(및 `mcp.task`)만 전제하며 비합의 `pr.review`/`pr.approve` 강제를 두지 않는다.
 * - `unclear`는 IntentTriage가 먼저 의도를 파악해 ① 재질문(`clarify`), ② 일상 대화(`reroute_talk`),
 *   ③ 유레카 직접 조작(`direct_eureka`), ④ 코딩/MCP/추론(`delegate_swarm`)로 분기한다.
 * - Swarm Worker는 중앙 승인 병목 없이 MCP 도구를 직접 실행하며, Guide에 명시된 조건에 한해
 *   PipelinePermissionQueue를 통해 사용자 확인을 입력받는다.
 */
export interface HarnessDeps {
  store: OperationStore;
  github: GitHubReviewGatewayPort;
  eureka: EurekaGatewayPort;
  clock: Clock;
  ids: IdGen;
  config?: PolicyConfig;
  /** 레거시 주입 호환용. 신규 구성에서는 guideRegistry 사용을 권장한다 */
  guide?: Guide;
  mcpManager?: McpClientPort;
  workspace?: WorkspaceGatewayPort;
  worktreeManager?: WorktreeIsolatorPort;
  guideRegistry?: McpGuideRegistry;
  triage?: IntentTriage;
  llm?: LlmClient;
  sensor?: Sensor;
  wiki?: WikiReader;
  holderId?: string;
  onFollowUp?: (n: FollowUpNotice) => void;
}

export interface CancellationSignal {
  requestId: string;
  reason: string;
}

interface RequestMeta {
  requestId: string;
  conversationId: string;
  contextId: string;
  contextVersion: number;
  intent: string;
  stateRevision: number;
  cancelled: boolean;
  eventGap: boolean;
  taskRefs: TaskRef[];
  deadlineAt: string;
  executionConstraints?: ExecutionConstraints;
  timingSink?: TimingSink;
  abort: AbortController;
  touchedAtMs: number;
  backgroundRunning?: boolean;
}

const MAX_TRACKED_REQUESTS = 500;
const WRITE_RETRYABLE: ReadonlySet<ProvisionalErrorCode> = new Set(['GITHUB_TRANSIENT', 'EUREKA_TRANSIENT']);
type WriteOutcome = { actionResult: ActionResult; operation: OperationRecord } | { assessmentPending: true; operation: OperationRecord };

const EMPTY_MCP_CLIENT: McpClientPort = {
  listServerIds: () => [],
  hasServer: () => false,
  listTools: async () => [],
  callTool: async (req) => ({
    mcpId: req.mcpId,
    toolName: req.toolName,
    ok: false,
    content: [],
    isError: true,
    error: `MCP server '${req.mcpId}' is not configured`,
    observedAt: new Date().toISOString(),
  }),
};

export class HarnessService {
  private readonly cfg: PolicyConfig;
  private readonly sensor: Sensor;
  private readonly holderId: string;
  private readonly owner: StoreDispatchOwner;
  private readonly directOwner: StoreDispatchOwner;
  private readonly mcpManager: McpClientPort;
  private readonly guideRegistry: McpGuideRegistry;
  private readonly permissionQueue: PipelinePermissionQueue;
  private readonly swarm: SwarmCoordinator;
  private readonly triage: IntentTriage;
  private readonly directEureka: DirectEurekaExecutor;
  private readonly requests = new Map<string, RequestMeta>();
  private readonly preparedByRequest = new Map<
    string,
    { operationId: string; operation: OperationRecord; authority: ExecutionAuthority; handle: DispatchHandle }
  >();
  private readonly background = new Set<Promise<unknown>>();
  private noticeSeq = 0;

  private readonly d: HarnessDeps;

  constructor(deps: HarnessDeps) {
    const d: HarnessDeps = {
      ...deps,
      github: timedPort(deps.github, 'github'),
      eureka: timedPort(deps.eureka, 'eureka'),
      ...(deps.wiki ? { wiki: timedPort(deps.wiki, 'wiki') } : {}),
      ...(deps.llm ? { llm: timedPort(deps.llm, 'llm', { complete: 'llm.guide' }) } : {}),
    };
    this.d = d;
    this.cfg = d.config ?? DEFAULT_POLICY;
    this.sensor = d.sensor ?? new DeterministicSensor();
    this.holderId = d.holderId ?? 'harness-1';
    this.owner = new StoreDispatchOwner(d.store, d.clock, this.holderId, (op) => this.dispatchValidity(op));
    this.directOwner = new StoreDispatchOwner(d.store, d.clock, `${this.holderId}:direct-eureka`, async (op) => {
      const meta = this.requests.get(op.requestId);
      if (meta?.cancelled) return 'request_cancelled';
      if (meta && d.clock.nowMs() > Date.parse(meta.deadlineAt)) return 'deadline_exceeded';
      return null;
    });

    this.mcpManager = d.mcpManager ?? EMPTY_MCP_CLIENT;
    const dispatchSource: DispatchAuthoritySource = {
      acquireHandle: (params, c) => this.acquireWorkerDispatchHandle(params, c),
      executeGitHubReview: (params, c) => this.executePreparedGitHubReview(params, c),
      executeGitHubApproval: (params, c) => this.executePreparedGitHubApproval(params, c),
    };
    this.guideRegistry =
      d.guideRegistry ??
      new McpGuideRegistry([
        new GitHubMcpGuide({
          gateway: d.github,
          dispatchSource,
          config: this.cfg,
          clock: d.clock,
          ids: d.ids,
        }),
        ...(d.workspace ? [new WorkspaceMcpGuide({ workspace: d.workspace })] : []),
      ]);

    this.permissionQueue = new PipelinePermissionQueue(
      ({ requestId, kind, purpose, requiredSlots, scope }) => {
        const meta = this.requests.get(requestId);
        if (!meta) throw new Error(`missing request metadata for pending permission (${requestId})`);
        return this.createQuestion(meta, kind, purpose, requiredSlots, scope);
      },
      d.onFollowUp,
      () => d.clock.nowIso(),
    );

    this.swarm = new SwarmCoordinator({
      mcpManager: this.mcpManager,
      guideRegistry: this.guideRegistry,
      permissionQueue: this.permissionQueue,
      clock: d.clock,
      ids: d.ids,
      ...(d.llm ? { llm: d.llm } : {}),
      ...(d.wiki ? { wiki: d.wiki } : {}),
      ...(d.worktreeManager ? { worktreeManager: d.worktreeManager } : {}),
    });

    this.triage = d.triage ?? new IntentTriage(d.llm, d.wiki, d.clock);
    this.directEureka = new DirectEurekaExecutor(d.eureka, d.store, this.directOwner, d.clock);
  }

  // ===================================================================== handle
  async handle(raw: HarnessRequest): Promise<HarnessResult> {
    const parsed = HarnessRequestSchema.safeParse(raw);
    if (!parsed.success) return this.processingFailure(raw?.requestId ?? 'unknown', 'INVALID_INPUT', parsed.error.message);
    const req = parsed.data;
    const dup = await this.d.store.getTurnResult(req.currentTurn.turnId);
    if (dup) return dup;

    const meta = this.meta(req.requestId, req.currentTurn, req.context, req.constraints.deadlineAt, intentOf(req.currentTurn));
    meta.executionConstraints = req.constraints;
    const result = await this.withTimings(() => this.dispatchIncoming(meta, req), meta);
    await this.d.store.recordTurnResult(req.currentTurn.turnId, result);
    this.settle(result);
    return result;
  }

  private async dispatchIncoming(meta: RequestMeta, req: HarnessRequest): Promise<HarnessResult> {
    const { currentTurn: turn, context: ctx, constraints } = req;

    // Router의 `unclear`는 의도 파악이 우선이며 4방향으로 분기한다
    if (meta.intent === 'unclear' || meta.intent === 'unknown') {
      const outcome = await this.triage.analyze({
        requestId: meta.requestId,
        turn,
        context: ctx,
        deadlineAt: constraints.deadlineAt,
        availableMcpIds: this.mcpManager.listServerIds(),
        ...(constraints.wikiSearchAllowed !== undefined ? { wikiSearchAllowed: constraints.wikiSearchAllowed } : {}),
        signal: meta.abort.signal,
      });
      const t = outcome.triage;

      if (t.verdict === 'reroute_talk') {
        return this.result(
          meta,
          'completed',
          [],
          { reroute: 'talk', triage: t },
          { sources: outcome.sources },
        );
      }

      if (t.verdict === 'clarify') {
        const questionText = t.clarifyQuestion?.trim() || '어떤 작업을 원하시는지 조금 더 구체적으로 말씀해 주시겠어요?';
        const view = await this.createQuestion(meta, 'clarification', 'triage_clarification', t.missingSlots);
        return this.result(
          meta,
          'awaiting_user',
          [],
          {
            triage: t,
            question: { ...questionFacts(view), questionText },
          },
          { pending: view, sources: outcome.sources },
        );
      }

      if (t.verdict === 'direct_eureka') {
        const exec = await this.directEureka.execute({
          requestId: meta.requestId,
          triage: t,
          constraints: { deadlineAt: constraints.deadlineAt, signal: meta.abort.signal },
          holderId: `${this.holderId}:direct-eureka`,
        });
        if (exec.clarifyQuestion) {
          const view = await this.createQuestion(meta, 'clarification', 'eureka_clarification', ['target']);
          return this.result(
            meta,
            'awaiting_user',
            exec.actionResults,
            {
              triage: t,
              ...exec.facts,
              question: { ...questionFacts(view), questionText: exec.clarifyQuestion },
            },
            { pending: view, sources: [...outcome.sources, ...exec.sources] },
          );
        }
        return this.result(
          meta,
          exec.ok ? 'completed' : 'failed',
          exec.actionResults,
          { triage: t, ...exec.facts },
          { sources: [...outcome.sources, ...exec.sources] },
        );
      }

      // delegate_swarm → llm 경로와 동일하게 Agent Swarm으로 진입
      return this.swarm.startAndWait({
        requestId: meta.requestId,
        goal: t.swarmGoal?.trim() || turn.rawText,
        turn,
        context: ctx,
        constraints,
        ...(outcome.wikiExcerpts.length ? { wikiExcerpts: outcome.wikiExcerpts } : {}),
        signal: meta.abort.signal,
      });
    }

    // `llm` / `mcp.task` 및 기타 Harness 진입 요청 → 자율 실행형 Agent Swarm
    return this.swarm.startAndWait({
      requestId: meta.requestId,
      goal: turn.rawText,
      turn,
      context: ctx,
      constraints,
      signal: meta.abort.signal,
    });
  }

  // ===================================================================== resume
  async resume(raw: HarnessResumeRequest): Promise<HarnessResult> {
    const parsed = HarnessResumeSchema.safeParse(raw);
    if (!parsed.success) return this.processingFailure(raw?.originalRequestId ?? 'unknown', 'INVALID_INPUT', parsed.error.message);
    const req = parsed.data;
    const dup = await this.d.store.getTurnResult(req.currentTurn.turnId);
    if (dup) return dup;

    const existingMeta = this.requests.get(req.originalRequestId);
    const result = await this.withTimings(() => this.resumeInner(req), existingMeta);
    await this.d.store.recordTurnResult(req.currentTurn.turnId, result);
    this.settle(result);
    return result;
  }

  private async resumeInner(req: HarnessResumeRequest): Promise<HarnessResult> {
    const pending = await this.d.store.getPending(req.pendingId);
    if (!pending || pending.requestId !== req.originalRequestId) {
      return this.processingFailure(req.originalRequestId, 'CONFIRMATION_INVALID', 'pending not found for request');
    }
    const meta = this.requests.get(req.originalRequestId) ?? this.restoreMeta(pending, req);
    meta.deadlineAt = req.newCallConstraints.deadlineAt;
    meta.executionConstraints = req.newCallConstraints;
    if (meta.cancelled) return this.result(meta, 'cancelled', [], { cancelled: true });
    if (meta.eventGap) {
      return this.processingFailure(meta.requestId, 'POLICY_BLOCKED', 'pipeline event order gap; resync required');
    }
    if (pending.contextId !== req.context.contextId || pending.conversationId !== req.currentTurn.conversationId) {
      return this.processingFailure(meta.requestId, 'CONFIRMATION_INVALID', 'context/conversation mismatch');
    }

    // 대기 중인 Swarm Worker 허가/재질문 응답 처리
    if (this.permissionQueue.hasWaitingWorker(pending.pendingId)) {
      return this.resumeQueuedWorker(meta, pending, req);
    }

    // Triage 재질문 응답 → 의도 재분석/Swarm 재진입
    if (pending.kind === 'clarification') {
      const commit = await this.d.store.atomicCommitAnswerAndClaim({
        pendingId: pending.pendingId,
        expectedPendingRevision: req.expectedPendingRevision,
        requestId: meta.requestId,
        conversationId: meta.conversationId,
        answerTurnId: req.currentTurn.turnId,
        answeredAtMs: this.d.clock.nowMs(),
        decision: { kind: 'clarification_answer' },
      });
      if (!commit.ok) return this.answerRejected(meta, commit.reason, commit.pending);
      meta.stateRevision += 1;
      meta.contextId = req.context.contextId;
      meta.contextVersion = req.context.version;
      meta.taskRefs = req.context.taskRefs;
      return this.swarm.startAndWait({
        requestId: meta.requestId,
        goal: req.currentTurn.rawText,
        turn: req.currentTurn,
        context: req.context,
        constraints: req.newCallConstraints,
        signal: meta.abort.signal,
      });
    }

    // 비Swarm 영속 confirmation (예: 복구 뒤 후속 Eureka 완료 확인)
    return this.resumePersistedConfirmation(meta, pending, req);
  }

  private async resumeQueuedWorker(
    meta: RequestMeta,
    pending: Pending,
    req: HarnessResumeRequest,
  ): Promise<HarnessResult> {
    if (pending.kind === 'clarification') {
      const commit = await this.d.store.atomicCommitAnswerAndClaim({
        pendingId: pending.pendingId,
        expectedPendingRevision: req.expectedPendingRevision,
        requestId: meta.requestId,
        conversationId: meta.conversationId,
        answerTurnId: req.currentTurn.turnId,
        answeredAtMs: this.d.clock.nowMs(),
        decision: { kind: 'clarification_answer' },
      });
      if (!commit.ok) return this.answerRejected(meta, commit.reason, commit.pending);
      meta.stateRevision += 1;
      this.permissionQueue.resolvePending(pending.pendingId, {
        approved: true,
        verdict: 'clarified',
        answerText: req.currentTurn.rawText,
        turnId: req.currentTurn.turnId,
        rationale: 'clarification answered',
        resolvedAt: this.d.clock.nowIso(),
        updatedContext: req.context,
        updatedTurn: req.currentTurn,
      });
      return (
        (await this.swarm.continueSession(meta.requestId)) ??
        this.result(meta, 'completed', [], {})
      );
    }

    if (!req.confirmationId) return this.processingFailure(meta.requestId, 'CONFIRMATION_INVALID', 'confirmationId required');
    const conf = await this.d.store.getConfirmation(req.confirmationId);
    if (!conf || conf.pendingId !== pending.pendingId) {
      return this.processingFailure(meta.requestId, 'CONFIRMATION_INVALID', 'confirmation not found for pending');
    }

    const answer = this.evaluateConfirmationAnswer(req, conf);
    const evidence = {
      inputChannel: req.currentTurn.inputChannel,
      sttConfidenceState: req.currentTurn.sttConfidenceState,
      ...(req.currentTurn.sttConfidence !== undefined ? { sttConfidence: req.currentTurn.sttConfidence } : {}),
      routeOverallConfidence: req.currentTurn.routeDecision.overallConfidence,
    };
    const prepare = answer.verdict === 'approved' ? this.prepareFromScope(meta, conf) : undefined;
    const commit = await this.d.store.atomicCommitAnswerAndClaim({
      pendingId: pending.pendingId,
      expectedPendingRevision: req.expectedPendingRevision,
      requestId: meta.requestId,
      conversationId: meta.conversationId,
      answerTurnId: req.currentTurn.turnId,
      answeredAtMs: this.d.clock.nowMs(),
      decision: {
        kind: 'confirmation',
        confirmationId: conf.confirmationId,
        verdict: answer.verdict,
        evidence,
        rawText: req.currentTurn.rawText,
        rationale: answer.rationale,
        ...(prepare ? { prepare } : {}),
      },
    });
    if (!commit.ok) return this.answerRejected(meta, commit.reason, commit.pending);
    meta.stateRevision += 1;

    if (answer.verdict === 'unclear') {
      const view = await this.createQuestion(meta, 'confirmation', pending.purpose, pending.requiredSlots, conf.scope);
      this.permissionQueue.rebindPending(pending.pendingId, view);
      return this.result(
        meta,
        'awaiting_user',
        [],
        { unclearAnswer: { reason: answer.rationale }, question: questionFacts(view) },
        { pending: view },
      );
    }

    if (answer.verdict === 'approved' && commit.prepared?.ok) {
      this.preparedByRequest.set(meta.requestId, {
        operationId: commit.prepared.operation.operationId,
        operation: commit.prepared.operation,
        authority: commit.prepared.authority,
        handle: this.owner.handleFor(commit.prepared.authority, commit.prepared.operation.operationId),
      });
    }

    this.permissionQueue.resolvePending(pending.pendingId, {
      approved: answer.verdict === 'approved',
      verdict: answer.verdict,
      answerText: req.currentTurn.rawText,
      turnId: req.currentTurn.turnId,
      rationale: answer.rationale,
      resolvedAt: this.d.clock.nowIso(),
    });

    return (
      (await this.swarm.continueSession(meta.requestId)) ??
      this.result(meta, 'completed', [], {})
    );
  }

  private async resumePersistedConfirmation(
    meta: RequestMeta,
    pending: Pending,
    req: HarnessResumeRequest,
  ): Promise<HarnessResult> {
    if (!req.confirmationId) return this.processingFailure(meta.requestId, 'CONFIRMATION_INVALID', 'confirmationId required');
    const conf = await this.d.store.getConfirmation(req.confirmationId);
    if (!conf || conf.pendingId !== pending.pendingId) {
      return this.processingFailure(meta.requestId, 'CONFIRMATION_INVALID', 'confirmation not found for pending');
    }

    const answer = this.evaluateConfirmationAnswer(req, conf);
    const evidence = {
      inputChannel: req.currentTurn.inputChannel,
      sttConfidenceState: req.currentTurn.sttConfidenceState,
      ...(req.currentTurn.sttConfidence !== undefined ? { sttConfidence: req.currentTurn.sttConfidence } : {}),
      routeOverallConfidence: req.currentTurn.routeDecision.overallConfidence,
    };
    const prepare = answer.verdict === 'approved' ? this.prepareFromScope(meta, conf) : undefined;
    const commit = await this.d.store.atomicCommitAnswerAndClaim({
      pendingId: pending.pendingId,
      expectedPendingRevision: req.expectedPendingRevision,
      requestId: meta.requestId,
      conversationId: meta.conversationId,
      answerTurnId: req.currentTurn.turnId,
      answeredAtMs: this.d.clock.nowMs(),
      decision: {
        kind: 'confirmation',
        confirmationId: conf.confirmationId,
        verdict: answer.verdict,
        evidence,
        rawText: req.currentTurn.rawText,
        rationale: answer.rationale,
        ...(prepare ? { prepare } : {}),
      },
    });
    if (!commit.ok) return this.answerRejected(meta, commit.reason, commit.pending);
    meta.stateRevision += 1;

    if (answer.verdict === 'rejected') {
      return this.result(meta, 'completed', [], { declined: { action: conf.scope.action, target: conf.scope.target }, noExternalChanges: true });
    }
    if (answer.verdict === 'unclear') {
      const view = await this.createQuestion(meta, 'confirmation', pending.purpose, [], conf.scope);
      return this.result(meta, 'awaiting_user', [], { unclearAnswer: { reason: answer.rationale }, question: questionFacts(view) }, { pending: view });
    }

    const prepared = commit.prepared;
    if (!prepared || !prepared.ok) {
      const reason = prepared && !prepared.ok ? prepared.reason : 'prepare_missing';
      return this.result(meta, 'failed', [], {}, { errors: [errorInfo('harness.prepare', reason === 'capacity_exhausted' ? 'STORAGE_RESERVATION_FAILED' : 'CONFIRMATION_INVALID', reason, 'none')] });
    }
    if (conf.scope.action === 'submit_approval') {
      return this.executeApproval(meta, prepared.operation, prepared.authority, req.newCallConstraints);
    }
    if (conf.scope.action === 'complete_stage') {
      return this.stageCompletionWithWait(meta, prepared.operation, prepared.authority, req.newCallConstraints);
    }
    return this.swarm.startAndWait({
      requestId: meta.requestId,
      goal: req.currentTurn.rawText,
      turn: req.currentTurn,
      context: req.context,
      constraints: req.newCallConstraints,
      signal: meta.abort.signal,
    });
  }

  /**
   * Guide 명시 기준에 따른 확인 답변 평가:
   * GitHub PR / Eureka stage는 명시된 STT·라우터 신뢰도 기준을 적용하고,
   * 임의 MCP는 Guide에 별도 신뢰도 제한이 없으면 명시적 동의/거절 표현 및 externalApproval만 검사한다.
   */
  private evaluateConfirmationAnswer(
    req: HarnessResumeRequest,
    conf: ConfirmationRecord,
  ): { verdict: 'approved' | 'rejected' | 'unclear'; rationale: string } {
    const usesConfidencePolicy =
      conf.scope.target.kind === 'github_pr' || conf.scope.target.kind === 'eureka_stage';
    const effectiveCfg = usesConfidencePolicy
      ? this.cfg
      : { ...this.cfg, minSttConfidenceForWrite: 0, minRouteConfidenceForWrite: 0 };
    let answer = classifyAnswer(req.currentTurn, effectiveCfg);
    if (answer.verdict === 'approved' && req.externalApproval === false) {
      answer = { verdict: 'unclear', rationale: 'pipeline did not mark the answer as approval (mutationApproved=false)' };
    }
    return answer;
  }

  private async acquireWorkerDispatchHandle(
    params: { requestId: string; action: ActionName; target: Target; actualRequest: Record<string, unknown> },
    _c: CallConstraints,
  ): Promise<{ operationId: string; handle: DispatchHandle }> {
    const existing = this.preparedByRequest.get(params.requestId);
    if (existing) {
      this.preparedByRequest.delete(params.requestId);
      return existing;
    }
    const prep = await this.d.store.reserveAndPrepare({
      owner: 'harness',
      requestId: params.requestId,
      action: params.action,
      target: params.target,
      isWrite: isWriteAction(params.action),
      expectedOutcome: expectedOutcomeFor(params.action, params.target),
      checkRuleVersion: this.cfg.checkRuleVersion,
      actualRequest: params.actualRequest,
      priorEvidence: {},
      holderId: this.holderId,
    });
    if (!prep.ok) throw new Error(`dispatch prepare failed: ${prep.reason}`);
    return {
      operationId: prep.operation.operationId,
      handle: this.owner.handleFor(prep.authority, prep.operation.operationId),
    };
  }

  private async executePreparedGitHubReview(
    params: {
      requestId: string;
      target: GitHubPrTarget;
      requestedSections: ('changes' | 'checks' | 'reviews')[];
      purpose?: 'review' | 'approval_precheck';
      expectedHeadSha?: string;
    },
    c: CallConstraints,
  ): Promise<{ actionResult?: ActionResult; review?: ReviewFacts; error?: string }> {
    const meta = this.requests.get(params.requestId);
    if (!meta) return { error: 'request_not_active' };
    const purpose = params.purpose ?? 'review';
    const expectedHeadSha =
      params.expectedHeadSha ??
      (purpose === 'approval_precheck' ? await this.lastReviewedSha(meta.conversationId, params.target) : undefined);
    const prep = await this.d.store.reserveAndPrepare({
      owner: 'harness',
      requestId: meta.requestId,
      action: 'get_review_context',
      target: params.target,
      isWrite: false,
      expectedOutcome: expectedOutcomeFor('get_review_context', params.target, {
        sections: params.requestedSections,
        ...(expectedHeadSha ? { headSha: expectedHeadSha } : {}),
      }),
      checkRuleVersion: this.cfg.checkRuleVersion,
      actualRequest: {
        action: 'get_review_context',
        repository: params.target.repository,
        prNumber: params.target.prNumber,
        requestedSections: params.requestedSections,
        ...(expectedHeadSha ? { expectedHeadSha } : {}),
        purpose,
        conversationId: meta.conversationId,
      },
      priorEvidence: {},
      holderId: this.holderId,
    });
    if (!prep.ok) {
      const ar: ActionResult = {
        operationId: 'not-recorded',
        action: 'get_review_context',
        target: params.target,
        status: 'failed',
        dispatchState: 'not_sent',
        facts: {},
        externalRefs: [],
        observedAt: this.d.clock.nowIso(),
        error: errorInfo('harness.prepare', 'STORAGE_RESERVATION_FAILED', prep.reason, 'none'),
      };
      return { actionResult: ar, error: 'storage' };
    }
    const op = prep.operation;
    const ctx = await this.d.github.getReviewContext(
      {
        repository: params.target.repository,
        prNumber: params.target.prNumber,
        requestedSections: params.requestedSections,
        ...(expectedHeadSha ? { expectedHeadSha } : {}),
        deadlineAt: c.deadlineAt,
      },
      { deadlineAt: c.deadlineAt, signal: meta.abort.signal },
    );
    const facts = ctx.prBasics
      ? reviewFacts(
          ctx,
          purpose === 'approval_precheck' || this.cfg.offerApprovalAfterReview
            ? (expectedHeadSha ?? ctx.initialHeadSha)
            : undefined,
          {
            ignoreChecks: this.cfg.prChecks === 'skip',
            repositoryAllowed: isRepositoryAllowed(
              this.cfg.allowedRepositories,
              params.target.repository.owner,
              params.target.repository.name,
            ),
          },
        )
      : undefined;
    const g: GatewayResult = {
      mode: 'read',
      dispatchState: 'sent',
      outcome: ctx.prBasics ? 'response' : 'error',
      response: (facts ?? {}) as unknown as Record<string, unknown>,
      externalRefs: [],
      respondedAt: this.d.clock.nowIso(),
      consistency: ctx.consistency,
      successTextOnly: false,
      ...(ctx.error ? { error: ctx.error } : {}),
    };
    const inspected = this.inspect(meta, op, g);
    if (!inspected.ok) {
      await this.d.store.appendEvidence(
        op.operationId,
        this.pendingAssessmentEvidence(op.attempts[0]!.attemptId, g, inspected.diagnostic, op.priorEvidence),
      );
      return { error: 'sensor_assessment_pending' };
    }
    const assessment = inspected.assessment;
    const ar = this.toActionResult(op, assessment, g, assessment.suggestedActionStatus ?? 'failed');
    await this.d.store.appendEvidence(op.operationId, {
      attemptId: op.attempts[0]!.attemptId,
      attemptDispatchState: 'sent',
      phase: 'stopped',
      assessment: 'assessed',
      actionResult: ar,
      releaseAuthority: true,
    });
    return {
      actionResult: ar,
      ...(facts ? { review: facts } : { error: ctx.error?.provisionalCode ?? 'review_read_failed' }),
    };
  }

  private async lastReviewedSha(conversationId: string, target: GitHubPrTarget): Promise<string | undefined> {
    const ops = await this.d.store.listOperations();
    for (let i = ops.length - 1; i >= 0; i--) {
      const o = ops[i]!;
      if (o.action !== 'get_review_context' || o.target.kind !== 'github_pr') continue;
      if (o.actualRequest['conversationId'] !== conversationId) continue;
      if (
        o.target.repository.owner.toLowerCase() !== target.repository.owner.toLowerCase() ||
        o.target.repository.name.toLowerCase() !== target.repository.name.toLowerCase() ||
        o.target.prNumber !== target.prNumber
      ) {
        continue;
      }
      const sha = o.actionResult?.status === 'succeeded' ? o.actionResult.facts['headSha'] : undefined;
      if (typeof sha === 'string' && sha) return sha;
    }
    return undefined;
  }

  private async executePreparedGitHubApproval(
    params: { requestId: string; target: GitHubPrTarget; expectedHeadSha: string },
    c: CallConstraints,
  ): Promise<HarnessResult> {
    const prep = this.preparedByRequest.get(params.requestId);
    const meta = this.requests.get(params.requestId);
    if (!prep || !meta || prep.operation.action !== 'submit_approval') {
      return this.processingFailure(params.requestId, 'CONFIRMATION_INVALID', 'approval requires user confirmation');
    }
    this.preparedByRequest.delete(params.requestId);
    const constraints: ExecutionConstraints = {
      deadlineAt: c.deadlineAt,
      maxPages: meta.executionConstraints?.maxPages ?? 5,
      maxResultBytes: meta.executionConstraints?.maxResultBytes ?? 1_048_576,
      policyVersion: meta.executionConstraints?.policyVersion ?? this.cfg.policyVersion,
      ...(meta.executionConstraints?.allowedActions ? { allowedActions: meta.executionConstraints.allowedActions } : {}),
      ...(meta.executionConstraints?.wikiSearchAllowed !== undefined
        ? { wikiSearchAllowed: meta.executionConstraints.wikiSearchAllowed }
        : {}),
    };
    return this.executeApproval(meta, prep.operation, prep.authority, constraints);
  }

  // ============================================================ follow-up / recovery
  private async stageCompletionWithWait(
    meta: RequestMeta,
    op: OperationRecord,
    authority: ExecutionAuthority,
    constraints: ExecutionConstraints,
  ): Promise<HarnessResult> {
    const work = this.executeStageCompletion(meta, op, authority, constraints);
    const waitMs = this.cfg.followUpReplyWaitMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = Symbol('late');
    const first = await Promise.race([
      work,
      new Promise<typeof late>((r) => (timer = setTimeout(() => r(late), Math.max(0, waitMs)))),
    ]);
    if (timer) clearTimeout(timer);
    if (first !== late) return first;
    meta.backgroundRunning = true;
    const t = op.target as EurekaStageTarget;
    const tracked = work
      .then((r) => {
        const ar = r.actionResults.find((a) => a.action === 'complete_stage');
        this.emitNotice('late_completion', r, op.operationId, 'complete_stage', ar?.status ?? (r.facts['assessmentPending'] ? 'assessment_pending' : r.disposition));
      })
      .catch(() => undefined)
      .finally(() => {
        meta.backgroundRunning = false;
        this.background.delete(tracked);
        this.settle({ requestId: meta.requestId, disposition: 'completed', actionResults: [], facts: {}, sources: [], processingErrors: [] });
      });
    this.background.add(tracked);
    return this.result(meta, 'completed', [], {
      stageCompletion: { status: 'in_progress', operationId: op.operationId, itemId: t.itemId, stageId: t.stageId, stageName: op.actualRequest['stageName'] },
    });
  }

  private async withTimings(fn: () => Promise<HarnessResult>, meta?: RequestMeta): Promise<HarnessResult> {
    const sink: TimingSink = meta?.timingSink ?? { entries: [] };
    if (meta && !meta.timingSink) meta.timingSink = sink;
    const { value, timings, totalMs } = await collectTimings(fn, sink);
    return { ...value, facts: { ...value.facts, timings: { totalMs, stages: timings } } };
  }

  async drainBackground(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  async notifyRecovered(op: OperationRecord, actionResult: ActionResult): Promise<HarnessResult> {
    const facts: Record<string, unknown> = { recovered: { operationId: op.operationId, action: op.action } };
    if (op.action === 'complete_stage' && op.target.kind === 'eureka_stage') {
      facts['stageCompletion'] = { status: actionResult.status, itemId: op.target.itemId, stageId: op.target.stageId, stageName: op.actualRequest['stageName'] };
    }
    if (op.action === 'complete_stage' && actionResult.status === 'succeeded') {
      // 복구로 완료가 확인되면 완료 근거 기록도 남긴다 (D-28). 이미 시도했으면 다시 보내지 않는다
      const cur = (await this.d.store.getOperation(op.operationId)) ?? op;
      const note = await this.writeEvidenceNote(cur, new Date(this.d.clock.nowMs() + 30_000).toISOString()).catch(() => undefined);
      if (note) facts['stageCompletion'] = { ...(facts['stageCompletion'] as Record<string, unknown>), evidenceNote: note };
    }
    let result: HarnessResult = { requestId: op.requestId, disposition: 'completed', actionResults: [actionResult], facts, sources: [], processingErrors: [] };
    if (op.action === 'submit_approval' && actionResult.status === 'succeeded') {
      result = await this.followUpAfterRecovery(op, actionResult, facts).catch(() => result);
    }
    this.emitNotice('recovery', result, op.operationId, op.action, actionResult.status);
    return result;
  }

  private async followUpAfterRecovery(op: OperationRecord, approval: ActionResult, facts: Record<string, unknown>): Promise<HarnessResult> {
    const plain = (followUp: Record<string, unknown>): HarnessResult => ({
      requestId: op.requestId,
      disposition: 'completed',
      actionResults: [approval],
      facts: { ...facts, followUp },
      sources: [],
      processingErrors: [],
    });
    let linked = op.actualRequest['linkedStage'] as TaskRef | undefined;
    if (!linked?.stageId) {
      // 승인 때 업무 연결이 없었으면 단계 기록에서 직접 찾는다 (2026-11-08, 읽기만)
      const found = await this.findLinkedStage(op.target as GitHubPrTarget, new Date(this.d.clock.nowMs() + 30_000).toISOString());
      if (found.status !== 'linked') return plain({ eligibility: 'not_applicable', reason: found.status === 'none' ? 'no_linked_eureka_stage' : `linked_stage_${found.status}` });
      linked = found.ref;
    }
    const linkedStageId = linked.stageId!;
    const existing = (await this.d.store.listOperations(op.requestId)).find((o) => o.action === 'complete_stage' && o.actualRequest['approvalOperationId'] === op.operationId);
    if (existing) return plain({ eligibility: 'not_applicable', reason: 'followup_operation_exists', operationId: existing.operationId });
    if ((await this.d.store.listWaitingPendings(op.requestId)).length) return plain({ eligibility: 'not_applicable', reason: 'question_already_waiting' });

    const deadlineAt = new Date(this.d.clock.nowMs() + 30_000).toISOString();
    const t = op.target as GitHubPrTarget;
    if (linked.source.ref.includes('note:') && this.d.eureka.listStageNotes) {
      const notes = await this.d.eureka.listStageNotes({ stageId: linkedStageId }, { deadlineAt });
      if (!notes.ok) return plain({ eligibility: 'unverified', conditions: ['eureka_notes_unverified'] });
      const still = notes.data!.notes.some((n) => extractPrLinks(n.content).some((l) => l.prNumber === t.prNumber && l.owner.toLowerCase() === t.repository.owner.toLowerCase() && l.name.toLowerCase() === t.repository.name.toLowerCase()));
      if (!still) return plain({ eligibility: 'blocked', conditions: ['eureka_note_link_removed'] });
    }
    const meta = this.requests.get(op.requestId) ?? this.restoreFromOperation(op, linked, deadlineAt);
    meta.deadlineAt = deadlineAt;
    if (!meta.taskRefs.some((r) => r.stageId === linked.stageId)) meta.taskRefs = [...meta.taskRefs, linked];
    const constraints: ExecutionConstraints = { deadlineAt, maxPages: 3, maxResultBytes: 256_000, policyVersion: this.cfg.policyVersion };
    const r = await this.followUpAfterApproval(meta, op, approval, constraints, facts);
    this.settle(r);
    return r;
  }

  private restoreFromOperation(op: OperationRecord, linked: TaskRef, deadlineAt: string): RequestMeta {
    const a = op.actualRequest;
    const meta: RequestMeta = {
      requestId: op.requestId,
      conversationId: typeof a['conversationId'] === 'string' && a['conversationId'] ? a['conversationId'] : 'default',
      contextId: typeof a['contextId'] === 'string' && a['contextId'] ? a['contextId'] : 'ctx-recovery',
      contextVersion: typeof a['contextVersion'] === 'number' ? a['contextVersion'] : 1,
      intent: 'llm',
      stateRevision: 1,
      cancelled: false,
      eventGap: false,
      taskRefs: [linked],
      deadlineAt,
      abort: new AbortController(),
      touchedAtMs: this.d.clock.nowMs(),
    };
    this.requests.set(op.requestId, meta);
    return meta;
  }

  private emitNotice(source: FollowUpNotice['source'], result: HarnessResult, operationId: string, action: string, outcomeStatus: string) {
    if (!this.d.onFollowUp) return;
    try {
      this.d.onFollowUp({
        noticeId: `ntc-${++this.noticeSeq}-${operationId}`,
        source,
        requestId: result.requestId,
        operationId,
        action,
        status: outcomeStatus,
        result,
        observedAt: this.d.clock.nowIso(),
      });
    } catch {
      // 알림 실패는 업무 결과에 영향을 주지 않는다
    }
  }

  // ============================================================ pipeline events
  async onPipelineEvent(raw: PipelineEvent): Promise<{ applied: boolean; reason?: string }> {
    const p = PipelineEventSchema.safeParse(raw);
    if (!p.success) return { applied: false, reason: 'invalid_event' };
    const e = p.data;
    const last = (await this.d.store.getLastPipelineRevision(e.requestId)) ?? 0;
    if (e.sourceRevision <= last) return { applied: false, reason: 'duplicate_or_stale' };
    const meta = this.requests.get(e.requestId);
    if (e.sourceRevision > last + 1) {
      if (meta) meta.eventGap = true;
      return { applied: false, reason: 'gap' };
    }
    await this.d.store.setLastPipelineRevision(e.requestId, e.sourceRevision);
    switch (e.kind) {
      case 'question_delivered':
        if (e.pendingId && e.outputId) {
          const pd = await this.d.store.getPending(e.pendingId);
          if (pd?.kind === 'confirmation' && pd.scope && !deliveredQuestionMatches(pd.scope, e.deliveredText)) {
            if (meta) meta.stateRevision += 1;
            return { applied: false, reason: e.deliveredText ? 'question_scope_mismatch' : 'delivered_text_required' };
          }
          await this.d.store.markQuestionDelivered(e.pendingId, e.outputId, {
            deliveredAt: e.occurredAt,
            channel: e.channel ?? 'speech',
            sourceMessageId: e.messageId,
            ...(e.deliveredText ? { deliveredText: e.deliveredText } : {}),
          });
        }
        break;
      case 'speech_started':
        if (e.pendingId) await this.d.store.markSpeechStarted(e.pendingId, e.occurredAt);
        break;
      case 'question_wait_expired':
        if (e.pendingId) {
          const p0 = await this.d.store.getPending(e.pendingId);
          if (p0 && !p0.speechStartedAt) {
            await this.d.store.closePending(e.pendingId, 'expired', 'question_wait_expired');
            this.permissionQueue.abortRequest(e.requestId, 'expired');
          }
        }
        break;
      case 'target_changed':
      case 'request_cancelled':
        for (const pd of await this.d.store.listWaitingPendings(e.requestId)) {
          await this.d.store.closePending(pd.pendingId, 'revoked', e.kind);
        }
        if (e.kind === 'request_cancelled') await this.cancel({ requestId: e.requestId, reason: 'request_cancelled' });
        else this.permissionQueue.abortRequest(e.requestId, 'target_changed');
        break;
    }
    if (meta) meta.stateRevision += 1;
    return { applied: true };
  }

  // ===================================================================== cancel
  async cancel(signal: CancellationSignal): Promise<{ revokedPendings: string[]; revokedOperations: string[]; alreadyDispatched: string[] }> {
    const meta = this.requests.get(signal.requestId);
    if (meta) {
      meta.cancelled = true;
      meta.abort.abort();
    }
    this.permissionQueue.abortRequest(signal.requestId, signal.reason);
    const revokedPendings: string[] = [];
    for (const p of await this.d.store.listWaitingPendings(signal.requestId)) {
      await this.d.store.closePending(p.pendingId, 'revoked', signal.reason);
      revokedPendings.push(p.pendingId);
    }
    const revokedOperations: string[] = [];
    const alreadyDispatched: string[] = [];
    for (const op of await this.d.store.listOperations(signal.requestId)) {
      if (!isWriteAction(op.action) || op.actionResult) continue;
      const r = await this.d.store.revokeBeforeDispatch(op.operationId, signal.reason);
      (r.revoked ? revokedOperations : alreadyDispatched).push(op.operationId);
    }
    return { revokedPendings, revokedOperations, alreadyDispatched };
  }

  // ================================================================== reconcile
  async reassess(operationId: string, systemRequestId: string): Promise<{ status: 'assessed' | 'still_pending' | 'not_needed'; actionResult?: ActionResult }> {
    const op = await this.d.store.getOperation(operationId);
    if (!op || op.assessment !== 'pending' || op.currentExecutionAuthority) return { status: 'not_needed', ...(op?.actionResult ? { actionResult: op.actionResult } : {}) };
    const last = op.attempts[op.attempts.length - 1]!;
    const resp = (last.responseEvidence ?? {}) as Record<string, unknown>;
    const g = resp['gatewayResult'] as GatewayResult | undefined;
    if (!g) return { status: 'still_pending' };
    const prior = (resp['priorEvidenceForAssessment'] as Record<string, unknown> | undefined) ?? op.priorEvidence;
    const inspected = this.inspect({ requestId: systemRequestId, cancelled: false }, op, g, prior);
    if (!inspected.ok) return { status: 'still_pending' };
    const status = inspected.assessment.suggestedActionStatus ?? (isWriteAction(op.action) ? 'unknown' : 'failed');
    const ar = this.toActionResult(op, inspected.assessment, g, status);
    const recovery = isWriteAction(op.action) && (op.recovery === 'none' || op.recovery === 'needed') ? { recovery: status === 'unknown' ? ('needed' as const) : ('none' as const) } : {};
    const after = await this.d.store.appendEvidence(op.operationId, { attemptId: last.attemptId, assessment: 'assessed', actionResult: ar, ...recovery });
    return { status: 'assessed', actionResult: after.actionResult! };
  }

  async reconcile(operationId: string, systemRequestId: string, constraints: { deadlineAt: string }): Promise<{ status: 'resolved' | 'still_unknown' | 'busy' | 'not_needed'; actionResult?: ActionResult; recovery?: string }> {
    const op = await this.d.store.getOperation(operationId);
    if (!op || op.recovery !== 'needed') return { status: 'not_needed', ...(op?.actionResult ? { actionResult: op.actionResult } : {}) };
    const holder = `${this.holderId}:recovery:${systemRequestId}`;
    const auth = await this.d.store.claimSingleRecovery(op.operationId, op.revision, holder);
    if (!auth) return { status: 'busy' };
    const last = op.attempts[op.attempts.length - 1]!;
    const resp = (last.responseEvidence ?? {}) as Record<string, unknown>;
    const c = { deadlineAt: constraints.deadlineAt };
    let g: GatewayResult;
    const priorEvidence = { ...op.priorEvidence, ...(resp['priorReviewIds'] ? { priorReviewIds: resp['priorReviewIds'] } : {}) };
    try {
      if (op.action === 'submit_approval') {
        const t = op.target as GitHubPrTarget;
        g = await this.d.github.getApprovalOutcome(
          {
            operationId: op.operationId,
            repository: t.repository,
            prNumber: t.prNumber,
            expectedHeadSha: String(op.actualRequest['commitId']),
            priorReviewIds: (priorEvidence['priorReviewIds'] as string[] | undefined) ?? [],
            ...(typeof resp['submitter'] === 'string' ? { submitter: resp['submitter'] } : {}),
            ...(typeof resp['reviewId'] === 'string' ? { reviewId: resp['reviewId'] } : {}),
          },
          c,
        );
      } else if (op.action === 'complete_stage') {
        const t = op.target as EurekaStageTarget;
        g = await this.d.eureka.getChangeOutcome(
          { operationId: op.operationId, itemId: t.itemId, stageId: t.stageId, priorStageStatus: String(op.priorEvidence['priorStageStatus'] ?? 'unknown') },
          c,
        );
      } else {
        await this.d.store.releaseRecovery(op.operationId, holder, 'still_unknown');
        return { status: 'still_unknown' };
      }
    } catch {
      const after = await this.d.store.releaseRecovery(op.operationId, holder, 'still_unknown');
      return { status: 'still_unknown', recovery: after.recovery, ...(after.actionResult ? { actionResult: after.actionResult } : {}) };
    }
    const inspected = this.inspect({ requestId: systemRequestId, cancelled: false }, op, g, priorEvidence);
    if (!inspected.ok) {
      const after = await this.d.store.releaseRecovery(op.operationId, holder, 'still_unknown');
      return { status: 'still_unknown', recovery: after.recovery, ...(after.actionResult ? { actionResult: after.actionResult } : {}) };
    }
    const assessment = inspected.assessment;
    if (assessment.verdict === 'confirmed_success' || assessment.verdict === 'confirmed_failure') {
      const ar = this.toActionResult(op, assessment, { ...g, dispatchState: op.actionResult?.dispatchState ?? 'may_have_been_sent' }, assessment.suggestedActionStatus!);
      await this.d.store.appendEvidence(op.operationId, { attemptId: last.attemptId, actionResult: ar, assessment: 'assessed' });
      const after = await this.d.store.releaseRecovery(op.operationId, holder, 'resolved');
      return { status: 'resolved', actionResult: after.actionResult!, recovery: after.recovery };
    }
    if (op.actionResult) {
      const kept: ActionResult = { ...op.actionResult, facts: { ...op.actionResult.facts, latestObservation: assessment.confirmedFacts }, observedAt: this.d.clock.nowIso() };
      await this.d.store.appendEvidence(op.operationId, { attemptId: last.attemptId, actionResult: kept });
    }
    const after = await this.d.store.releaseRecovery(op.operationId, holder, 'still_unknown');
    return { status: 'still_unknown', recovery: after.recovery, ...(after.actionResult ? { actionResult: after.actionResult } : {}) };
  }

  // ============================================================== executions
  private async executeApproval(meta: RequestMeta, op: OperationRecord, authority: ExecutionAuthority, constraints: ExecutionConstraints): Promise<HarnessResult> {
    const t = op.target as GitHubPrTarget;
    const cmd = { operationId: op.operationId, confirmationId: op.confirmationRef!, repository: t.repository, prNumber: t.prNumber, expectedHeadSha: String(op.actualRequest['commitId']) };
    const out = await this.runWrite(meta, op, authority, constraints, (h) => this.d.github.submitApproval(cmd, h, { deadlineAt: constraints.deadlineAt }));
    if ('assessmentPending' in out) return this.assessmentPendingResult(meta, out.operation);
    const { actionResult, operation } = out;
    const facts: Record<string, unknown> = {
      approval: {
        status: actionResult.status,
        headSha: cmd.expectedHeadSha,
        repository: `${t.repository.owner}/${t.repository.name}`,
        prNumber: t.prNumber,
        reviewId: actionResult.externalRefs.find((r) => r.kind === 'pull_request_review')?.id,
        dispatchState: actionResult.dispatchState,
        recovery: operation.recovery,
      },
    };
    if (actionResult.status !== 'succeeded') {
      return this.result(meta, 'completed', [actionResult], { ...facts, followUp: { eligibility: 'not_started', reason: `approval_${actionResult.status}` } });
    }
    return this.followUpAfterApproval(meta, operation, actionResult, constraints, facts);
  }

  private async followUpAfterApproval(meta: RequestMeta, approvalOp: OperationRecord, approval: ActionResult, constraints: ExecutionConstraints, facts: Record<string, unknown>): Promise<HarnessResult> {
    const t = approvalOp.target as GitHubPrTarget;
    let ref = meta.taskRefs.find((r) => r.stageId && r.prNumber === t.prNumber && r.repository?.owner === t.repository.owner && r.repository?.name === t.repository.name);
    if (!ref || !ref.stageId) {
      // 파이프라인이 업무 연결(taskRefs)을 주지 않았으면 Eureka 단계 기록에서 이 PR 주소를 직접 찾는다 (2026-11-08, 읽기만)
      const found = await this.findLinkedStage(t, constraints.deadlineAt);
      if (found.status !== 'linked') {
        return this.result(meta, 'completed', [approval], { ...facts, followUp: { eligibility: 'not_applicable', reason: found.status === 'none' ? 'no_linked_eureka_stage' : `linked_stage_${found.status}` } });
      }
      ref = found.ref;
      meta.taskRefs = [...meta.taskRefs, ref];
    }
    const stageId = ref.stageId!;
    const approvedSha = String(approvalOp.actualRequest['commitId']);
    const check = await this.followUpEligibility(t, approvedSha, ref.itemId, stageId, constraints);
    await this.d.store.appendEvidence(approvalOp.operationId, {
      attemptId: approvalOp.attempts[approvalOp.attempts.length - 1]!.attemptId,
      followUp: { eligibility: check.eligibility, conditions: check.conditions, evidence: check.evidence, observedAt: this.d.clock.nowIso() },
    });
    if (check.eligibility !== 'eligible') {
      return this.result(meta, 'completed', [approval], { ...facts, followUp: { eligibility: check.eligibility, conditions: check.conditions } });
    }
    const reviewId = approval.externalRefs.find((r) => r.kind === 'pull_request_review')?.id ?? '';
    const scope: ConfirmationScope = {
      action: 'complete_stage',
      target: { kind: 'eureka_stage', itemId: ref.itemId, stageId },
      exactChange: {
        status: 'done',
        approvalOperationId: approvalOp.operationId,
        approvedSha,
        reviewId,
        linkedRepository: `${t.repository.owner}/${t.repository.name}`,
        linkedPrNumber: t.prNumber,
        priorStageStatus: check.evidence['stageStatus'],
        stageName: check.evidence['stageName'],
        followUpObservedAt: this.d.clock.nowIso(),
        ...this.evidenceNoteFlag(),
      },
    };
    const view = await this.createQuestion(meta, 'confirmation', 'confirm_stage_completion', [], scope);
    return this.result(meta, 'awaiting_user', [approval], { ...facts, followUp: { eligibility: 'eligible', conditions: [] }, question: questionFacts(view) }, { pending: view });
  }

  private async followUpEligibility(t: GitHubPrTarget, approvedSha: string, itemId: string, stageId: string, constraints: ExecutionConstraints): Promise<{ eligibility: 'eligible' | 'blocked' | 'unverified'; conditions: string[]; evidence: Record<string, unknown> }> {
    const c = { deadlineAt: constraints.deadlineAt };
    const ctx = await this.d.github.getReviewContext({ repository: t.repository, prNumber: t.prNumber, requestedSections: [], expectedHeadSha: approvedSha, deadlineAt: constraints.deadlineAt }, c);
    const conditions: string[] = [];
    let unverified = false;
    if (!ctx.prBasics) {
      unverified = true;
      conditions.push('pr_state_unverified');
    } else {
      const latest = ctx.observedHeadSha ?? ctx.prBasics.headSha;
      if (ctx.prBasics.headSha !== approvedSha || latest !== approvedSha || ctx.consistency === 'changed') conditions.push('sha_changed_since_approval');
      if (ctx.prBasics.state === 'closed') conditions.push('pr_closed');
    }
    const st = await this.d.eureka.getTaskState({ itemId, stageId }, c);
    let stageStatus: string | undefined;
    let stageName: string | undefined;
    if (!st.ok || !st.data) {
      unverified = true;
      conditions.push('eureka_state_unverified');
    } else {
      stageStatus = st.data.stage?.status;
      stageName = st.data.stage?.name;
      if (!st.data.stage) conditions.push('eureka_stage_not_found');
      else if (st.data.stage.status === 'done' || st.data.stage.status === 'skip') conditions.push('eureka_stage_already_done');
      if (st.data.itemStatus === 'hold') conditions.push('eureka_item_on_hold');
    }
    const evidence = { observedHeadSha: ctx.prBasics?.headSha, prState: ctx.prBasics?.state, stageStatus, stageName };
    if (conditions.some((x) => !x.endsWith('_unverified'))) return { eligibility: 'blocked', conditions, evidence };
    if (unverified) return { eligibility: 'unverified', conditions, evidence };
    return { eligibility: 'eligible', conditions, evidence };
  }

  private async executeStageCompletion(meta: RequestMeta, op: OperationRecord, authority: ExecutionAuthority, constraints: ExecutionConstraints): Promise<HarnessResult> {
    const t = op.target as EurekaStageTarget;
    const ar0 = op.actualRequest;
    const approvalOperationId = String(ar0['approvalOperationId']);
    const approvedSha = String(ar0['approvedSha']);
    const approvalOp = await this.d.store.getOperation(approvalOperationId);
    const prTarget = approvalOp?.target as GitHubPrTarget | undefined;

    const recheck = prTarget
      ? await this.followUpEligibility(prTarget, approvedSha, t.itemId, t.stageId, constraints)
      : { eligibility: 'unverified' as const, conditions: ['approval_operation_missing'], evidence: {} };
    if (recheck.eligibility !== 'eligible') {
      await this.d.store.revokeBeforeDispatch(op.operationId, `followup_${recheck.eligibility}:${recheck.conditions.join(',')}`);
      const blocked = await this.d.store.appendEvidence(op.operationId, {
        attemptId: authority.attemptId,
        followUp: { eligibility: recheck.eligibility, conditions: recheck.conditions, evidence: recheck.evidence, observedAt: this.d.clock.nowIso() },
        actionResult: {
          operationId: op.operationId,
          action: 'complete_stage',
          target: t,
          status: 'failed',
          dispatchState: 'not_sent',
          facts: { conditions: recheck.conditions },
          externalRefs: [],
          observedAt: this.d.clock.nowIso(),
          error: errorInfo('harness.followup', recheck.conditions.includes('sha_changed_since_approval') ? 'SHA_CHANGED' : 'POLICY_BLOCKED', recheck.conditions.join(','), 'user_input', op.operationId),
        },
      });
      return this.result(meta, 'completed', [blocked.actionResult!], { stageCompletion: { status: 'failed', blockedBy: recheck.conditions }, followUp: { eligibility: recheck.eligibility, conditions: recheck.conditions } });
    }

    const cmd = {
      operationId: op.operationId,
      confirmationId: op.confirmationRef!,
      itemId: t.itemId,
      stageId: t.stageId,
      githubSuccessEvidence: { approvalOperationId, reviewId: String(ar0['reviewId'] ?? ''), approvedSha, followUpObservedAt: String(ar0['followUpObservedAt'] ?? '') },
      expectedChange: { status: 'done' as const },
    };
    const out = await this.runWrite(meta, op, authority, constraints, (h) => this.d.eureka.completeStage(cmd, h, { deadlineAt: constraints.deadlineAt }));
    if ('assessmentPending' in out) return this.assessmentPendingResult(meta, out.operation);
    const { actionResult } = out;
    const note = actionResult.status === 'succeeded' ? await this.writeEvidenceNote(out.operation, constraints.deadlineAt) : undefined;
    return this.result(meta, 'completed', [actionResult], {
      stageCompletion: { status: actionResult.status, itemId: t.itemId, stageId: t.stageId, stageName: ar0['stageName'], dispatchState: actionResult.dispatchState, ...(note ? { evidenceNote: note } : {}) },
    });
  }

  /**
   * 승인한 PR과 연결된 Eureka 단계를 단계 기록(note)의 PR 주소로 찾는다 (D-21과 같은 규칙, 읽기만).
   * - 열린 업무의 미완료 단계 중 기록이 있는 것만, 최대 20개 단계까지 읽는다
   * - 정확히 한 단계면 linked. 둘 이상이면 ambiguous, 일부 기록을 못 읽었거나 상한에 걸리면 partial — 둘 다 추측하지 않는다
   */
  private async findLinkedStage(t: GitHubPrTarget, deadlineAt: string): Promise<{ status: 'linked'; ref: TaskRef } | { status: 'none' | 'ambiguous' | 'partial' | 'failed' }> {
    const read = this.d.eureka.listStageNotes?.bind(this.d.eureka);
    if (!read || !isRepositoryAllowed(this.cfg.allowedRepositories, t.repository.owner, t.repository.name)) return { status: 'none' };
    const c = { deadlineAt };
    const list = await this.d.eureka.listTasks({ onlyOpen: true, limit: 100 }, c);
    if (!list.ok) return { status: 'failed' };
    const stages = list.data!.items.flatMap((i) => i.stages.filter((st) => st.noteIds?.length && st.status !== 'done' && st.status !== 'skip').map((st) => ({ item: i, st })));
    let incomplete = list.data!.completeness !== 'complete' || stages.length > 20;
    const hits: TaskRef[] = [];
    for (const { item, st } of stages.slice(0, 20)) {
      const notes = await read({ stageId: st.stageId }, c);
      if (!notes.ok || notes.data!.completeness !== 'complete') {
        incomplete = true;
        continue;
      }
      const note = notes.data!.notes.find((n) => extractPrLinks(n.content).some((l) => l.prNumber === t.prNumber && l.owner.toLowerCase() === t.repository.owner.toLowerCase() && l.name.toLowerCase() === t.repository.name.toLowerCase()));
      if (note) hits.push({ itemId: item.itemId, stageId: st.stageId, repository: { ...t.repository }, prNumber: t.prNumber, source: { kind: 'eureka', ref: `item:${item.itemId}/stage:${st.stageId}/note:${note.noteId}` } });
    }
    if (hits.length > 1) return { status: 'ambiguous' };
    if (incomplete) return { status: 'partial' };
    return hits.length === 1 ? { status: 'linked', ref: hits[0]! } : { status: 'none' };
  }

  /** 단계 완료 확인 질문에 완료 근거 기록(D-28)을 함께 묻는지. 켜져 있고 Gateway가 기록 작성을 지원할 때만 */
  private evidenceNoteFlag(): { evidenceNote?: true } {
    return this.cfg.evidenceNote && this.d.eureka.addStageNote ? { evidenceNote: true } : {};
  }

  /**
   * 완료 근거 기록 (D-28). 단계 완료가 성공으로 판정된 뒤, 동의 범위에 evidenceNote가 있을 때만 쓴다.
   * - 같은 operation에서 이미 시도했으면(dispatching·written·unknown 등) 다시 보내지 않는다
   * - 쓰기 전에 단계 기록을 읽어 같은 PR·같은 승인 커밋의 근거 기록이 있으면 쓰지 않는다 (복구·재시작 중복 방지)
   * - 기록을 못 읽으면 쓰지 않는다. 응답을 못 받으면 unknown으로 두고 다시 보내지 않는다
   * - 단계 완료 결과에는 영향을 주지 않는다 (실패해도 완료는 그대로)
   */
  private async writeEvidenceNote(op: OperationRecord, deadlineAt: string): Promise<{ status: string; noteId?: string; reason?: string } | undefined> {
    if (op.action !== 'complete_stage' || op.target.kind !== 'eureka_stage' || op.actualRequest['evidenceNote'] !== true) return undefined;
    if (op.evidenceNote) return { status: op.evidenceNote.status === 'dispatching' ? 'unknown' : op.evidenceNote.status, ...(op.evidenceNote.noteId ? { noteId: op.evidenceNote.noteId } : {}), reason: 'already_attempted' };
    const attemptId = op.attempts[op.attempts.length - 1]!.attemptId;
    const save = async (status: NonNullable<OperationRecord['evidenceNote']>['status'], extra: { noteId?: string; reason?: string } = {}) => {
      await this.d.store.appendEvidence(op.operationId, { attemptId, evidenceNote: { status, ...extra, observedAt: this.d.clock.nowIso() } }).catch(() => undefined);
      return { status, ...extra };
    };
    const add = this.d.eureka.addStageNote?.bind(this.d.eureka);
    if (!add || !this.d.eureka.listStageNotes) return save('skipped', { reason: 'not_supported' });
    const approvalOp = await this.d.store.getOperation(String(op.actualRequest['approvalOperationId']));
    if (!approvalOp || approvalOp.target.kind !== 'github_pr') return save('skipped', { reason: 'approval_operation_missing' });
    const pr = approvalOp.target;
    const e = { owner: pr.repository.owner, name: pr.repository.name, prNumber: pr.prNumber, approvedSha: String(op.actualRequest['approvedSha'] ?? ''), reviewId: String(op.actualRequest['reviewId'] ?? '') || undefined };
    if (e.approvedSha.length < 7) return save('skipped', { reason: 'approved_sha_missing' });
    const stageId = op.target.stageId;
    const c = { deadlineAt };
    const notes = await this.d.eureka.listStageNotes({ stageId, limit: 100 }, c);
    if (!notes.ok || notes.data!.completeness !== 'complete') return save('skipped', { reason: 'notes_unverified' });
    const same = notes.data!.notes.find((n) => isSameEvidenceNote(n.content, e));
    if (same) return save('already_present', { noteId: same.noteId });

    const content = evidenceNoteContent({ ...e, ...(e.reviewId ? { reviewId: e.reviewId } : {}) });
    let marked = false;
    const handle = {
      operationId: op.operationId,
      attemptId,
      ownerRevision: op.revision,
      // 보내기 직전에 '보내는 중'을 먼저 남긴다. 이 기록이 남지 않으면 보내지 않는다
      beforeDispatch: async () => {
        try {
          const rec = await this.d.store.appendEvidence(op.operationId, { attemptId, evidenceNote: { status: 'dispatching', observedAt: this.d.clock.nowIso() } });
          marked = true;
          return { ok: true as const, ack: { kind: 'may_have_been_sent' as const, operationId: op.operationId, attemptId, ownerRevision: rec.revision, persistedAt: this.d.clock.nowIso() } };
        } catch (err) {
          return { ok: false as const, reason: 'storage_error' as const, detail: err instanceof Error ? err.message : 'store' };
        }
      },
    };
    let g: GatewayResult;
    try {
      g = await add({ operationId: op.operationId, stageId, content }, handle, c);
    } catch {
      return marked ? save('unknown', { reason: 'gateway_error' }) : save('failed', { reason: 'gateway_error_before_send' });
    }
    const noteId = g.externalRefs.find((r) => r.kind === 'stage_note')?.id;
    if (g.outcome === 'response' && noteId) return save('written', { noteId });
    if (g.dispatchState === 'not_sent') return save('failed', { reason: g.error?.provisionalCode ?? 'not_sent' });
    if (g.outcome === 'no_response' || g.outcome === 'response') return save('unknown', { reason: g.outcome === 'response' ? 'unexpected_response' : 'no_response' });
    return save('failed', { reason: g.error?.provisionalCode ?? 'error' });
  }

  /**
   * 쓰기 실행 공통: DispatchOwner 핸들로 Gateway 호출 → 증거 기록 → Sensor → ActionResult commit.
   * - 전송하지 않았음이 확실한 일시 오류만 조건부 1회 재시도
   * - unknown이면 recovery=needed, 같은 호출 안에서 deadline이 남으면 읽기 복구 1회
   */
  private async runWrite(
    meta: RequestMeta,
    op0: OperationRecord,
    authority0: ExecutionAuthority,
    constraints: ExecutionConstraints,
    call: (h: ReturnType<StoreDispatchOwner['handleFor']>) => Promise<GatewayResult>,
  ): Promise<WriteOutcome> {
    let op = op0;
    let authority = authority0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const g = await call(this.owner.handleFor(authority, op.operationId));
      const current = (await this.d.store.getOperation(op.operationId))!;
      if (current.actionResult && !current.currentExecutionAuthority && current.attempts.length === op.attempts.length) {
        return { actionResult: current.actionResult, operation: current };
      }
      const priorEvidence = { ...current.priorEvidence, ...(g.response?.['priorReviewIds'] ? { priorReviewIds: g.response['priorReviewIds'] } : {}) };
      const inspected = this.inspect(meta, current, g, priorEvidence);
      if (!inspected.ok) {
        const noResponse = g.outcome !== 'response' && g.dispatchState !== 'not_sent';
        op = await this.d.store.appendEvidence(current.operationId, {
          ...this.pendingAssessmentEvidence(authority.attemptId, g, inspected.diagnostic, priorEvidence),
          ...(noResponse ? { recovery: 'needed' as const } : {}),
        });
        return { assessmentPending: true, operation: op };
      }
      const assessment = inspected.assessment;
      const status = assessment.suggestedActionStatus ?? 'unknown';
      const ar = this.toActionResult(current, assessment, g, status);
      const retryable = g.dispatchState === 'not_sent' && !!g.notSentProof && !!g.error && WRITE_RETRYABLE.has(g.error.provisionalCode);
      op = await this.d.store.appendEvidence(current.operationId, {
        attemptId: authority.attemptId,
        ...(g.dispatchState === 'not_sent' ? (g.notSentProof ? { attemptDispatchState: 'not_sent' as const, notSentProof: g.notSentProof } : {}) : { attemptDispatchState: g.dispatchState }),
        responseEvidence: { ...(g.response ?? {}), outcome: g.outcome, successTextOnly: g.successTextOnly },
        phase: g.outcome === 'response' ? 'response_received' : 'stopped',
        assessment: 'assessed',
        recovery: status === 'unknown' ? 'needed' : 'none',
        actionResult: ar,
        releaseAuthority: true,
      });
      if (retryable && attempt === 0 && this.d.clock.nowMs() < Date.parse(constraints.deadlineAt) && !meta.cancelled) {
        const retry = await this.d.store.prepareRetryAttempt(op.operationId, op.revision, this.holderId);
        if (retry.ok) {
          op = retry.operation;
          authority = retry.authority;
          continue;
        }
      }
      if (status === 'unknown' && this.d.clock.nowMs() < Date.parse(constraints.deadlineAt)) {
        const rec = await this.reconcile(op.operationId, meta.requestId, { deadlineAt: constraints.deadlineAt });
        op = (await this.d.store.getOperation(op.operationId))!;
        return { actionResult: rec.actionResult ?? op.actionResult!, operation: op };
      }
      return { actionResult: ar, operation: op };
    }
    return { actionResult: op.actionResult!, operation: op };
  }

  private assessmentPendingResult(meta: RequestMeta, op: OperationRecord): HarnessResult {
    const last = op.attempts[op.attempts.length - 1];
    return this.result(meta, 'completed', [], {
      assessmentPending: {
        operationId: op.operationId,
        action: op.action,
        target: op.target,
        dispatchState: last?.dispatchState ?? 'unknown',
        recovery: op.recovery,
      },
    });
  }

  private async dispatchValidity(op: OperationRecord): Promise<string | null> {
    const meta = this.requests.get(op.requestId);
    if (meta?.cancelled) return 'request_cancelled';
    if (meta && this.d.clock.nowMs() > Date.parse(meta.deadlineAt)) return 'deadline_exceeded';
    if (!op.confirmationRef) return 'confirmation_missing';
    const conf = await this.d.store.getConfirmation(op.confirmationRef);
    if (!conf) return 'confirmation_missing';
    if (conf.state !== 'approved' || conf.operationId !== op.operationId) return `confirmation_${conf.state}`;
    if (this.d.clock.nowMs() > Date.parse(conf.expiresAt)) return 'confirmation_expired';
    return null;
  }

  // ================================================================ helpers
  private prepareFromScope(meta: RequestMeta, conf: ConfirmationRecord): PrepareCommand {
    const s = conf.scope;
    if (s.action === 'submit_approval' && s.target.kind === 'github_pr') {
      return {
        owner: 'harness',
        requestId: meta.requestId,
        action: 'submit_approval',
        target: s.target,
        isWrite: true,
        expectedOutcome: expectedOutcomeFor('submit_approval', s.target, { headSha: s.headSha! }),
        checkRuleVersion: this.cfg.checkRuleVersion,
        actualRequest: {
          repository: s.target.repository,
          prNumber: s.target.prNumber,
          commitId: s.headSha,
          event: 'APPROVE',
          conversationId: meta.conversationId,
          contextId: meta.contextId,
          contextVersion: meta.contextVersion,
          ...linkedStageOf(meta.taskRefs, s.target),
        },
        priorEvidence: {},
        holderId: this.holderId,
      };
    }
    if (s.action === 'complete_stage' && s.target.kind === 'eureka_stage') {
      const x = s.exactChange ?? {};
      return {
        owner: 'harness',
        requestId: meta.requestId,
        action: 'complete_stage',
        target: s.target,
        isWrite: true,
        expectedOutcome: expectedOutcomeFor('complete_stage', s.target),
        checkRuleVersion: this.cfg.checkRuleVersion,
        actualRequest: { itemId: s.target.itemId, stageId: s.target.stageId, status: 'done', ...x },
        priorEvidence: { priorStageStatus: x['priorStageStatus'] },
        holderId: this.holderId,
      };
    }
    if (s.action === 'mcp_tool_call' && s.target.kind === 'mcp_tool') {
      return {
        owner: 'harness',
        requestId: meta.requestId,
        action: 'mcp_tool_call',
        target: s.target,
        isWrite: false,
        expectedOutcome: expectedOutcomeFor('mcp_tool_call', s.target),
        checkRuleVersion: this.cfg.checkRuleVersion,
        actualRequest: { ...(s.exactChange ?? {}), mcpId: s.target.mcpId, toolName: s.target.toolName },
        priorEvidence: {},
        holderId: this.holderId,
      };
    }
    throw new Error(`unsupported confirmation scope ${s.action}`);
  }

  private async createQuestion(meta: RequestMeta, kind: 'clarification' | 'confirmation', purpose: string, requiredSlots: string[], scope?: ConfirmationScope): Promise<PendingView> {
    for (const p of await this.d.store.listWaitingPendings(meta.requestId)) await this.d.store.closePending(p.pendingId, 'revoked', 'reissued');
    const now = this.d.clock.nowMs();
    const ttl = kind === 'confirmation' ? this.cfg.confirmationTtlMs : this.cfg.clarificationTtlMs;
    const pending: Pending = {
      pendingId: this.d.ids.next('pend'),
      requestId: meta.requestId,
      conversationId: meta.conversationId,
      contextId: meta.contextId,
      contextVersion: meta.contextVersion,
      revision: 0,
      kind,
      state: 'waiting',
      purpose,
      requiredSlots,
      ...(scope ? { scope } : {}),
      outputId: this.d.ids.next('out'),
      expiresAt: new Date(now + ttl).toISOString(),
    };
    let conf: ConfirmationRecord | undefined;
    if (kind === 'confirmation' && scope) {
      conf = {
        confirmationId: this.d.ids.next('conf'),
        pendingId: pending.pendingId,
        requestId: meta.requestId,
        conversationId: meta.conversationId,
        revision: 0,
        scope,
        requiredQuestionMeaning: questionMeaning(scope),
        outputId: pending.outputId,
        state: 'waiting',
        expiresAt: pending.expiresAt,
      };
    }
    await this.d.store.createPending(pending, conf);
    meta.stateRevision += 1;
    return {
      pendingId: pending.pendingId,
      revision: pending.revision,
      kind,
      purpose,
      requiredSlots,
      ...(scope ? { scope } : {}),
      ...(conf ? { confirmationId: conf.confirmationId } : {}),
      outputId: pending.outputId,
      expiresAt: pending.expiresAt,
    };
  }

  private answerRejected(meta: RequestMeta, reason: string, pending?: Pending): HarnessResult {
    if (pending && pending.state === 'waiting') {
      return this.result(meta, 'awaiting_user', [], { answerNotAccepted: reason }, { pending: viewOf(pending) });
    }
    return this.result(meta, 'completed', [], { answerNotAccepted: reason, pendingState: pending?.state });
  }

  private inspect(
    ctx: { requestId: string; cancelled: boolean },
    op: OperationRecord,
    g: GatewayResult,
    priorEvidence = op.priorEvidence,
  ): { ok: true; assessment: SensorAssessment } | { ok: false; diagnostic: string } {
    try {
      const assessment = this.sensor.inspect({
        requestId: ctx.requestId,
        operationId: op.operationId,
        attemptId: op.attempts[op.attempts.length - 1]!.attemptId,
        executionRevision: op.revision,
        expectedOutcome: op.expectedOutcome,
        actualRequest: op.actualRequest,
        gatewayResult: g,
        priorEvidence,
        executionContext: { cancelled: ctx.cancelled, expired: false },
      });
      return { ok: true, assessment };
    } catch (e) {
      return { ok: false, diagnostic: `sensor error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private pendingAssessmentEvidence(attemptId: string, g: GatewayResult, diagnostic: string, priorEvidence: Record<string, unknown>) {
    return {
      attemptId,
      ...(g.dispatchState === 'not_sent' ? (g.notSentProof ? { attemptDispatchState: 'not_sent' as const, notSentProof: g.notSentProof } : {}) : { attemptDispatchState: g.dispatchState }),
      responseEvidence: { ...(g.response ?? {}), outcome: g.outcome, successTextOnly: g.successTextOnly, gatewayResult: g as unknown as Record<string, unknown>, priorEvidenceForAssessment: priorEvidence, sensorDiagnostic: diagnostic },
      phase: g.outcome === 'response' ? ('response_received' as const) : ('stopped' as const),
      assessment: 'pending' as const,
      releaseAuthority: true,
    };
  }

  private toActionResult(op: OperationRecord, a: SensorAssessment, g: GatewayResult, status: ActionResult['status']): ActionResult {
    const write = isWriteAction(op.action);
    const dispatchState = write ? g.dispatchState : 'sent';
    const err: ErrorInfo | undefined =
      status === 'succeeded'
        ? undefined
        : (g.error ?? (status === 'unknown' ? errorInfo('sensor', op.target.kind === 'github_pr' ? 'GITHUB_RESULT_UNKNOWN' : 'EUREKA_TIMEOUT_RESULT_UNKNOWN', a.diagnostics.join('; ') || 'result not confirmed', 'reconcile', op.operationId) : undefined));
    const candidate: ActionResult = {
      operationId: op.operationId,
      action: op.action,
      target: op.target,
      status,
      dispatchState: status === 'unknown' && dispatchState === 'not_sent' ? 'may_have_been_sent' : dispatchState,
      facts: { ...a.confirmedFacts, ...(op.action === 'get_review_context' ? (g.response ?? {}) : {}) },
      externalRefs: status === 'succeeded' || status === 'failed' ? a.externalRefs : [],
      observedAt: this.d.clock.nowIso(),
      ...(err ? { error: { ...err, operationId: op.operationId } } : {}),
    };
    const checked = ActionResultSchema.safeParse(candidate);
    if (checked.success) return checked.data;
    return { ...candidate, status: 'unknown', dispatchState: write ? (g.dispatchState === 'not_sent' ? 'may_have_been_sent' : g.dispatchState) : 'sent', externalRefs: [], error: errorInfo('sensor', 'MCP_RESULT_UNKNOWN', checked.error.issues.map((i) => i.message).join('; '), 'reconcile', op.operationId) };
  }

  private meta(requestId: string, turn: CurrentTurnInput, ctx: ContextPacket, deadlineAt: string, intent: string): RequestMeta {
    const m: RequestMeta = {
      requestId,
      conversationId: turn.conversationId,
      contextId: ctx.contextId,
      contextVersion: ctx.version,
      intent,
      stateRevision: 1,
      cancelled: false,
      eventGap: false,
      taskRefs: ctx.taskRefs,
      deadlineAt,
      abort: new AbortController(),
      touchedAtMs: this.d.clock.nowMs(),
    };
    this.requests.delete(requestId);
    this.requests.set(requestId, m);
    this.sweepRequests();
    return m;
  }

  private settle(result: HarnessResult) {
    const m = this.requests.get(result.requestId);
    if (!m || m.backgroundRunning || this.swarm.hasActiveSession(result.requestId)) return;
    if (result.disposition === 'awaiting_user') m.touchedAtMs = this.d.clock.nowMs();
    else if (!m.eventGap) this.requests.delete(result.requestId);
  }

  private sweepRequests() {
    if (this.requests.size <= MAX_TRACKED_REQUESTS) return;
    const now = this.d.clock.nowMs();
    const ttl = Math.max(this.cfg.confirmationTtlMs, this.cfg.clarificationTtlMs) * 2;
    for (const [id, m] of this.requests) {
      if (now - m.touchedAtMs > ttl && !this.swarm.hasActiveSession(id)) this.requests.delete(id);
    }
    for (const [id, m] of this.requests) {
      if (this.requests.size <= MAX_TRACKED_REQUESTS) break;
      if (!m.eventGap && !m.cancelled && !this.swarm.hasActiveSession(id)) this.requests.delete(id);
    }
  }

  get trackedRequestCount(): number {
    return this.requests.size;
  }

  private restoreMeta(p: Pending, req: HarnessResumeRequest): RequestMeta {
    return this.meta(p.requestId, req.currentTurn, req.context, req.newCallConstraints.deadlineAt, intentOf(req.currentTurn));
  }

  private result(
    meta: RequestMeta,
    disposition: HarnessResult['disposition'],
    actionResults: ActionResult[],
    facts: Record<string, unknown>,
    extra: { pending?: PendingView; errors?: ErrorInfo[]; sources?: SourceRef[] } = {},
  ): HarnessResult {
    return {
      requestId: meta.requestId,
      disposition,
      actionResults,
      ...(extra.pending ? { pending: extra.pending } : {}),
      facts,
      sources: extra.sources ?? [],
      processingErrors: extra.errors ?? [],
    };
  }

  private processingFailure(requestId: string, code: ProvisionalErrorCode, message: string): HarnessResult {
    return { requestId, disposition: 'failed', actionResults: [], facts: {}, sources: [], processingErrors: [errorInfo('harness', code, message, 'none')] };
  }
}

function linkedStageOf(refs: TaskRef[], t: GitHubPrTarget): { linkedStage?: TaskRef } {
  const ref = refs.find((r) => r.stageId && r.prNumber === t.prNumber && r.repository?.owner === t.repository.owner && r.repository?.name === t.repository.name);
  return ref ? { linkedStage: ref } : {};
}

function intentOf(turn: CurrentTurnInput): string {
  const v = turn.routeDecision.headOutputs['intention']?.value;
  return typeof v === 'string' ? v : 'unknown';
}

function errorInfo(stage: string, code: ProvisionalErrorCode, message: string, next: ErrorInfo['nextAction'], operationId?: string): ErrorInfo {
  return { stage, provisionalCode: code, message, nextAction: next, ...(operationId ? { operationId } : {}) };
}

function questionMeaning(s: ConfirmationScope): string {
  if (s.target.kind === 'github_pr') return `APPROVE ${s.target.repository.owner}/${s.target.repository.name}#${s.target.prNumber} @ ${s.headSha}`;
  if (s.target.kind === 'eureka_stage') return `COMPLETE_STAGE item=${s.target.itemId} stage=${s.target.stageId} status=done`;
  if (s.target.kind === 'mcp_tool') return confirmationTokens(s).join(' ');
  return `${s.action}`;
}

function questionFacts(v: PendingView): Record<string, unknown> {
  return { purpose: v.purpose, kind: v.kind, requiredSlots: v.requiredSlots, ...(v.scope ? { scope: v.scope, meaning: questionMeaning(v.scope) } : {}) };
}

function viewOf(p: Pending): PendingView {
  return { pendingId: p.pendingId, revision: p.revision, kind: p.kind, purpose: p.purpose, requiredSlots: p.requiredSlots, ...(p.scope ? { scope: p.scope } : {}), outputId: p.outputId, expiresAt: p.expiresAt };
}
