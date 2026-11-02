import {
  ActionResult as ActionResultSchema,
  CurrentTurnInput,
  GuideDecision as GuideDecisionSchema,
  HarnessRequest as HarnessRequestSchema,
  HarnessResumeRequest as HarnessResumeSchema,
  PipelineEvent as PipelineEventSchema,
  isWriteAction,
  type ActionResult,
  type ConfirmationRecord,
  type ConfirmationScope,
  type ContextPacket,
  type ErrorInfo,
  type EurekaGatewayPort,
  type EurekaStageTarget,
  type ExecutionAuthority,
  type ExecutionConstraints,
  type GatewayResult,
  type GitHubPrTarget,
  type GitHubReviewGatewayPort,
  type GuideDecision,
  type HarnessRequest,
  type HarnessResult,
  type HarnessResumeRequest,
  type OperationRecord,
  type Pending,
  type PendingView,
  type PipelineEvent,
  type ProvisionalErrorCode,
  type LlmClient,
  type SensorAssessment,
  type SourceRef,
  type TaskRef,
  type FollowUpNotice,
  confirmationTokens,
  extractPrLinks,
  deliveredQuestionMatches,
} from '@deskpet/contracts';
import { StoreDispatchOwner } from './dispatch/DispatchOwner.js';
import { reviewFacts, type ReviewFacts } from './facts.js';
import { RuleBasedGuide, type Guide, type GuideFacts } from './guide/Guide.js';
import { LlmGuide, RuleFirstGuide } from './guide/LlmGuide.js';
import { DEFAULT_POLICY, type PolicyConfig } from './policy/config.js';
import { expectedOutcomeFor } from './policy/expectedOutcome.js';
import { classifyAnswer, writeInputBlockers } from './policy/inputPolicy.js';
import type { WikiReader } from './ports.js';
import type { Clock, IdGen } from './runtime/clock.js';
import { collectTimings, timedPort } from './runtime/timing.js';
import { DeterministicSensor, type Sensor } from './sensor/Sensor.js';
import type { OperationStore, PrepareCommand } from './store/OperationStore.js';

/**
 * HarnessService — 추가 해석, 계획, 재질문, 승인 확인, 도구 실행 조율, 작업 기록·복구 (Liability §Ownership).
 * 공개 메서드: handle / resume / onPipelineEvent / cancel / reconcile (다이어그램).
 *
 * 핵심 불변식
 * - Guide 제안은 실행 권한이 아니다. 쓰기는 confirmation 경로(resume)에서만, 원자적 commit 뒤에만 실행한다.
 * - GitHub 승인과 Eureka 단계 완료는 별도 confirmation·operation이다.
 * - 쓰기 결과 불명은 unknown으로 남기고 재전송하지 않는다. 자동 롤백하지 않는다.
 */
export interface HarnessDeps {
  store: OperationStore;
  github: GitHubReviewGatewayPort;
  eureka: EurekaGatewayPort;
  clock: Clock;
  ids: IdGen;
  config?: PolicyConfig;
  guide?: Guide;
  /** 있으면 규칙 Guide가 모르는 의도에 LLM 보조 Guide를 쓴다 (RuleFirstGuide). guide를 직접 주면 무시한다 */
  llm?: LlmClient;
  sensor?: Sensor;
  wiki?: WikiReader;
  holderId?: string;
  /** 요청이 끝난 뒤 확정된 결과 알림 (잠깐 기다려도 끝나지 않은 Eureka 반영, 주기 복구 결과). D-23 */
  onFollowUp?: (n: FollowUpNotice) => void;
}

export interface CancellationSignal {
  requestId: string;
  reason: string;
}

/**
 * 요청 메타데이터. inference: MVP는 메모리에 둔다. 재시작 후에는 pending 기록에서 최소 정보를 복원한다.
 */
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
  abort: AbortController;
  /** 마지막으로 쓴 시각. 오래된 항목 정리용 (감사 F-07) */
  touchedAtMs: number;
  /** 응답을 먼저 돌려준 뒤에도 진행 중인 후속 작업. 끝날 때까지 메타를 지우지 않는다 */
  backgroundRunning?: boolean;
}

/** 메모리에 들고 있는 요청 상태 상한 (감사 F-07). 끝난 요청은 바로 지우고, 답변 대기 요청만 남긴다 */
const MAX_TRACKED_REQUESTS = 500;

const WRITE_RETRYABLE: ReadonlySet<ProvisionalErrorCode> = new Set(['GITHUB_TRANSIENT', 'EUREKA_TRANSIENT']);

/** 쓰기 실행 결과. 센서 자체 오류면 확정 ActionResult 없이 판정 대기(assessment=pending)로 끝난다 */
type WriteOutcome = { actionResult: ActionResult; operation: OperationRecord } | { assessmentPending: true; operation: OperationRecord };

export class HarnessService {
  private readonly cfg: PolicyConfig;
  private readonly guide: Guide;
  private readonly sensor: Sensor;
  private readonly holderId: string;
  private readonly owner: StoreDispatchOwner;
  private readonly requests = new Map<string, RequestMeta>();
  private readonly background = new Set<Promise<unknown>>();
  private noticeSeq = 0;

  private readonly d: HarnessDeps;

  constructor(deps: HarnessDeps) {
    // 외부 호출 시간 기록 (NFR-01, D-26): port 경계에서 잰다
    const d: HarnessDeps = {
      ...deps,
      github: timedPort(deps.github, 'github'),
      eureka: timedPort(deps.eureka, 'eureka'),
      ...(deps.wiki ? { wiki: timedPort(deps.wiki, 'wiki') } : {}),
      ...(deps.llm ? { llm: timedPort(deps.llm, 'llm', { complete: 'llm.guide' }) } : {}),
    };
    this.d = d;
    this.cfg = d.config ?? DEFAULT_POLICY;
    this.guide = d.guide ?? new RuleFirstGuide(new RuleBasedGuide(this.cfg), d.llm ? new LlmGuide(d.llm, { now: () => d.clock.nowMs(), timeoutMs: this.cfg.llmGuideTimeoutMs }) : undefined);
    this.sensor = d.sensor ?? new DeterministicSensor();
    this.holderId = d.holderId ?? 'harness-1';
    this.owner = new StoreDispatchOwner(d.store, d.clock, this.holderId, (op) => this.dispatchValidity(op));
  }

  // ===================================================================== handle
  async handle(raw: HarnessRequest): Promise<HarnessResult> {
    const parsed = HarnessRequestSchema.safeParse(raw);
    if (!parsed.success) return this.processingFailure(raw?.requestId ?? 'unknown', 'INVALID_INPUT', parsed.error.message);
    const req = parsed.data;
    const dup = await this.d.store.getTurnResult(req.currentTurn.turnId);
    if (dup) return dup; // 동일 turnId 재전달은 저장된 결과로 응답

    const meta = this.meta(req.requestId, req.currentTurn, req.context, req.constraints.deadlineAt, intentOf(req.currentTurn));
    const result = await this.withTimings(() => (RETRY_INTENTS.has(meta.intent) ? this.retryStageCompletion(meta, req.currentTurn, req.context, req.constraints) : this.runGuideLoop(meta, req.currentTurn, req.context, req.constraints)));
    await this.d.store.recordTurnResult(req.currentTurn.turnId, result);
    this.settle(result);
    return result;
  }

  // ===================================================================== resume
  async resume(raw: HarnessResumeRequest): Promise<HarnessResult> {
    const parsed = HarnessResumeSchema.safeParse(raw);
    if (!parsed.success) return this.processingFailure(raw?.originalRequestId ?? 'unknown', 'INVALID_INPUT', parsed.error.message);
    const req = parsed.data;
    const dup = await this.d.store.getTurnResult(req.currentTurn.turnId);
    if (dup) return dup;

    const result = await this.withTimings(() => this.resumeInner(req));
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
    meta.deadlineAt = req.newCallConstraints.deadlineAt; // 새 호출 deadline. 승인 유효성은 연장하지 않는다
    if (meta.cancelled) return this.result(meta, 'cancelled', [], { cancelled: true });
    if (meta.eventGap) {
      // 순서 누락은 실행을 차단한다 (message-contracts §Pending Transitions)
      return this.processingFailure(meta.requestId, 'POLICY_BLOCKED', 'pipeline event order gap; resync required');
    }
    if (pending.contextId !== req.context.contextId || pending.conversationId !== req.currentTurn.conversationId) {
      return this.processingFailure(meta.requestId, 'CONFIRMATION_INVALID', 'context/conversation mismatch');
    }

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
      const newIntent = intentOf(req.currentTurn);
      if (newIntent.startsWith('pr.')) meta.intent = newIntent;
      meta.contextId = req.context.contextId;
      meta.contextVersion = req.context.version;
      meta.taskRefs = req.context.taskRefs;
      return this.runGuideLoop(meta, req.currentTurn, req.context, req.newCallConstraints);
    }

    // ---- confirmation
    if (!req.confirmationId) return this.processingFailure(meta.requestId, 'CONFIRMATION_INVALID', 'confirmationId required');
    const conf = await this.d.store.getConfirmation(req.confirmationId);
    if (!conf || conf.pendingId !== pending.pendingId) {
      // 없는 오래된 확인 ID로 새 실행을 허용하지 않는다
      return this.processingFailure(meta.requestId, 'CONFIRMATION_INVALID', 'confirmation not found for pending');
    }
    let answer = classifyAnswer(req.currentTurn, this.cfg);
    // 파이프라인이 승인으로 판단하지 않았으면(mutationApproved=false) 쓰기를 하지 않는다. 거절은 그대로 거절
    if (answer.verdict === 'approved' && req.externalApproval === false) answer = { verdict: 'unclear', rationale: 'pipeline did not mark the answer as approval (mutationApproved=false)' };
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
      // S-05: 거절은 쓰기 없음. GitHub 승인을 되돌리지 않는다
      return this.result(meta, 'completed', [], { declined: { action: conf.scope.action, target: conf.scope.target }, noExternalChanges: true });
    }
    if (answer.verdict === 'unclear') {
      // unclear는 pending을 소비하고 새 재질문으로 연결한다. 승인 operation을 만들지 않는다
      const view = await this.createQuestion(meta, 'confirmation', conf.scope.action === 'submit_approval' ? 'confirm_pr_approval' : 'confirm_stage_completion', [], conf.scope);
      return this.result(meta, 'awaiting_user', [], { unclearAnswer: { reason: answer.rationale }, question: questionFacts(view) }, { pending: view });
    }

    const prepared = commit.prepared;
    if (!prepared || !prepared.ok) {
      const reason = prepared && !prepared.ok ? prepared.reason : 'prepare_missing';
      return this.result(meta, 'failed', [], {}, { errors: [errorInfo('harness.prepare', reason === 'capacity_exhausted' ? 'STORAGE_RESERVATION_FAILED' : 'CONFIRMATION_INVALID', reason, 'none')] });
    }
    const constraints = req.newCallConstraints;
    if (conf.scope.action === 'submit_approval') {
      return this.executeApproval(meta, prepared.operation, prepared.authority, constraints);
    }
    return this.stageCompletionWithWait(meta, prepared.operation, prepared.authority, constraints);
  }

  // ============================================================ follow-up (D-23)
  /**
   * Eureka 반영을 실행하고 followUpReplyWaitMs만 기다린다. 그 안에 끝나면 결과를, 아니면 '진행 중'을 돌려주고
   * 끝난 결과는 onFollowUp 알림으로 보낸다. 실행 자체는 호출 deadline 안에서만 진행한다 (늘리지 않음).
   */
  private async stageCompletionWithWait(meta: RequestMeta, op: OperationRecord, authority: ExecutionAuthority, constraints: ExecutionConstraints): Promise<HarnessResult> {
    const work = this.executeStageCompletion(meta, op, authority, constraints);
    const waitMs = this.cfg.followUpReplyWaitMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = Symbol('late');
    const first = await Promise.race([work, new Promise<typeof late>((r) => (timer = setTimeout(() => r(late), Math.max(0, waitMs))))]);
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

  /** 이번 호출에서 외부 호출이 걸린 시간을 facts.timings에 붙인다 (NFR-01, D-26) */
  private async withTimings(fn: () => Promise<HarnessResult>): Promise<HarnessResult> {
    const { value, timings, totalMs } = await collectTimings(fn);
    return { ...value, facts: { ...value.facts, timings: { totalMs, stages: timings } } };
  }

  /** 응답 뒤에도 진행 중인 후속 작업이 끝날 때까지 기다린다 (서버 종료·테스트용) */
  async drainBackground(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  /**
   * 주기 복구(RecoveryWorker)가 확정한 결과를 알린다. 요청 경로 안의 reconcile은 알리지 않는다 (그 응답에 이미 포함).
   * GitHub 승인이 성공으로 확정되면 연결된 Eureka 단계의 상태와 기록을 다시 보고, 반영할 수 있을 때만 후속 확인 질문을
   * 만들어 같이 보낸다 (D-24). 질문을 만들지 않은 이유는 facts.followUp에 남는다.
   */
  async notifyRecovered(op: OperationRecord, actionResult: ActionResult): Promise<HarnessResult> {
    const facts: Record<string, unknown> = { recovered: { operationId: op.operationId, action: op.action } };
    if (op.action === 'complete_stage' && op.target.kind === 'eureka_stage') {
      facts['stageCompletion'] = { status: actionResult.status, itemId: op.target.itemId, stageId: op.target.stageId, stageName: op.actualRequest['stageName'] };
    }
    let result: HarnessResult = { requestId: op.requestId, disposition: 'completed', actionResults: [actionResult], facts, sources: [], processingErrors: [] };
    if (op.action === 'submit_approval' && actionResult.status === 'succeeded') {
      result = await this.followUpAfterRecovery(op, actionResult, facts).catch(() => result);
    }
    this.emitNotice('recovery', result, op.operationId, op.action, actionResult.status);
    return result;
  }

  private async followUpAfterRecovery(op: OperationRecord, approval: ActionResult, facts: Record<string, unknown>): Promise<HarnessResult> {
    const plain = (followUp: Record<string, unknown>): HarnessResult => ({ requestId: op.requestId, disposition: 'completed', actionResults: [approval], facts: { ...facts, followUp }, sources: [], processingErrors: [] });
    const linked = op.actualRequest['linkedStage'] as TaskRef | undefined;
    if (!linked?.stageId) return plain({ eligibility: 'not_applicable', reason: 'no_linked_eureka_stage' });
    // 이미 후속 작업이 있거나 질문을 기다리는 중이면 새로 묻지 않는다
    const existing = (await this.d.store.listOperations(op.requestId)).find((o) => o.action === 'complete_stage' && o.actualRequest['approvalOperationId'] === op.operationId);
    if (existing) return plain({ eligibility: 'not_applicable', reason: 'followup_operation_exists', operationId: existing.operationId });
    if ((await this.d.store.listWaitingPendings(op.requestId)).length) return plain({ eligibility: 'not_applicable', reason: 'question_already_waiting' });

    const deadlineAt = new Date(this.d.clock.nowMs() + 30_000).toISOString();
    const t = op.target as GitHubPrTarget;
    // Eureka 기록 확인: 기록에서 찾은 연결이면 그 기록에 PR 주소가 아직 있는지 본다 (지워졌으면 묻지 않음)
    if (linked.source.ref.includes('note:') && this.d.eureka.listStageNotes) {
      const notes = await this.d.eureka.listStageNotes({ stageId: linked.stageId }, { deadlineAt });
      if (!notes.ok) return plain({ eligibility: 'unverified', conditions: ['eureka_notes_unverified'] });
      const still = notes.data!.notes.some((n) => extractPrLinks(n.content).some((l) => l.prNumber === t.prNumber && l.owner.toLowerCase() === t.repository.owner.toLowerCase() && l.name.toLowerCase() === t.repository.name.toLowerCase()));
      if (!still) return plain({ eligibility: 'blocked', conditions: ['eureka_note_link_removed'] });
    }
    const meta =
      this.requests.get(op.requestId) ??
      this.restoreFromOperation(op, linked, deadlineAt);
    meta.deadlineAt = deadlineAt;
    if (!meta.taskRefs.some((r) => r.stageId === linked.stageId)) meta.taskRefs = [...meta.taskRefs, linked];
    const constraints: ExecutionConstraints = { deadlineAt, maxPages: 3, maxResultBytes: 256_000, policyVersion: this.cfg.policyVersion };
    const r = await this.followUpAfterApproval(meta, op, approval, constraints, facts);
    this.settle(r);
    return r;
  }

  /** 복구로 확정된 승인 operation에서 요청 메타를 다시 만든다 (재시작 뒤 메모리에 없을 때) */
  private restoreFromOperation(op: OperationRecord, linked: TaskRef, deadlineAt: string): RequestMeta {
    const a = op.actualRequest;
    const m: RequestMeta = {
      requestId: op.requestId,
      conversationId: String(a['conversationId'] ?? 'unknown'),
      contextId: String(a['contextId'] ?? `ctx-recovered-${op.requestId}`),
      contextVersion: typeof a['contextVersion'] === 'number' ? a['contextVersion'] : 1,
      intent: 'pr.approve',
      stateRevision: 1,
      cancelled: false,
      eventGap: false,
      taskRefs: [linked],
      deadlineAt,
      abort: new AbortController(),
      touchedAtMs: this.d.clock.nowMs(),
    };
    this.requests.set(op.requestId, m);
    return m;
  }

  private emitNotice(source: FollowUpNotice['source'], result: HarnessResult, operationId: string, action: string, status: string) {
    if (!this.d.onFollowUp) return;
    try {
      this.d.onFollowUp({ noticeId: `notice-${this.holderId}-${this.d.clock.nowMs()}-${++this.noticeSeq}`, source, requestId: result.requestId, operationId, action, status, result, observedAt: this.d.clock.nowIso() });
    } catch {
      // 알림 실패는 업무 결과에 영향을 주지 않는다
    }
  }

  /**
   * 실패한 Eureka 반영 다시 하기 (D-23: "다시 해줘" 요청 자체를 동의로 본다).
   * - 같은 대화에서 가장 최근의 complete_stage가 명시적으로 실패(failed)했을 때만. unknown은 다시 보내지 않는다 (주기 복구가 확인)
   * - 승인 operation이 성공이고, 후속 적합성을 다시 확인해 통과해야 한다
   * - 기존 확인 기록 규칙을 그대로 쓴다: 새 확인(pending·confirmation)을 만들고 이 턴을 그 답으로 기록한다. 질문 전달 증거는 channel=retry_request
   * - 쓰기 입력 검사(음성 신뢰도 등)는 일반 승인 답변과 같다
   */
  private async retryStageCompletion(meta: RequestMeta, turn: CurrentTurnInput, ctx: ContextPacket, constraints: ExecutionConstraints): Promise<HarnessResult> {
    const blockers = writeInputBlockers(turn, this.cfg);
    if (blockers.length) return this.result(meta, 'completed', [], { retry: { status: 'input_blocked', reasons: blockers } });
    const ops = (await this.d.store.listOperations()).filter((o) => o.action === 'complete_stage' && o.target.kind === 'eureka_stage');
    const mine: OperationRecord[] = [];
    for (const o of ops) {
      const ap = await this.d.store.getOperation(String(o.actualRequest['approvalOperationId'] ?? ''));
      if (ap && ap.actualRequest['conversationId'] === meta.conversationId) mine.push(o);
    }
    const refStage = ctx.taskRefs.find((r) => r.stageId)?.stageId;
    const candidates = refStage ? mine.filter((o) => (o.target as EurekaStageTarget).stageId === refStage) : mine;
    const last = candidates[candidates.length - 1];
    if (!last) return this.result(meta, 'completed', [], { retry: { status: 'nothing_to_retry' } });
    const lt = last.target as EurekaStageTarget;
    const base = { operationId: last.operationId, itemId: lt.itemId, stageId: lt.stageId, stageName: last.actualRequest['stageName'] };
    const st = last.actionResult?.status;
    if (!st || st === 'unknown' || last.recovery !== 'none' || last.assessment === 'pending') return this.result(meta, 'completed', [], { retry: { status: 'result_unknown', ...base } });
    if (st === 'succeeded') return this.result(meta, 'completed', [], { retry: { status: 'already_done', ...base } });
    if (st !== 'failed') return this.result(meta, 'completed', [], { retry: { status: 'nothing_to_retry', ...base } });

    const approvalOp = await this.d.store.getOperation(String(last.actualRequest['approvalOperationId']));
    if (!approvalOp || approvalOp.actionResult?.status !== 'succeeded') return this.result(meta, 'completed', [], { retry: { status: 'approval_not_confirmed', ...base } });
    const prTarget = approvalOp.target as GitHubPrTarget;
    const approvedSha = String(approvalOp.actualRequest['commitId']);
    const check = await this.followUpEligibility(prTarget, approvedSha, lt.itemId, lt.stageId, constraints);
    if (check.eligibility !== 'eligible') return this.result(meta, 'completed', [], { retry: { status: 'blocked', ...base }, followUp: { eligibility: check.eligibility, conditions: check.conditions } });

    const x = last.actualRequest;
    const scope: ConfirmationScope = {
      action: 'complete_stage',
      target: { kind: 'eureka_stage', itemId: lt.itemId, stageId: lt.stageId },
      exactChange: {
        status: 'done',
        approvalOperationId: approvalOp.operationId,
        approvedSha,
        reviewId: x['reviewId'] ?? approvalOp.actionResult.externalRefs.find((r) => r.kind === 'pull_request_review')?.id ?? '',
        linkedRepository: `${prTarget.repository.owner}/${prTarget.repository.name}`,
        linkedPrNumber: prTarget.prNumber,
        priorStageStatus: check.evidence['stageStatus'],
        stageName: check.evidence['stageName'] ?? x['stageName'],
        followUpObservedAt: this.d.clock.nowIso(),
        retryOf: last.operationId,
      },
    };
    const view = await this.createQuestion(meta, 'confirmation', 'confirm_stage_completion', [], scope);
    const conf = await this.d.store.getConfirmationForPending(view.pendingId);
    const delivered = await this.d.store.markQuestionDelivered(view.pendingId, view.outputId, {
      deliveredAt: this.d.clock.nowIso(),
      channel: 'retry_request',
      sourceMessageId: turn.turnId,
      deliveredText: confirmationTokens(scope).join(' '),
    });
    if (!conf || !delivered) return this.processingFailure(meta.requestId, 'CONFIRMATION_INVALID', 'retry consent could not be recorded');
    const commit = await this.d.store.atomicCommitAnswerAndClaim({
      pendingId: view.pendingId,
      expectedPendingRevision: delivered.revision,
      requestId: meta.requestId,
      conversationId: meta.conversationId,
      answerTurnId: turn.turnId,
      answeredAtMs: this.d.clock.nowMs(),
      decision: {
        kind: 'confirmation',
        confirmationId: conf.confirmationId,
        verdict: 'approved',
        evidence: {
          inputChannel: turn.inputChannel,
          sttConfidenceState: turn.sttConfidenceState,
          ...(turn.sttConfidence !== undefined ? { sttConfidence: turn.sttConfidence } : {}),
          routeOverallConfidence: turn.routeDecision.overallConfidence,
        },
        rawText: turn.rawText,
        rationale: `retry request treated as consent (D-23), retryOf=${last.operationId}`,
        prepare: this.prepareFromScope(meta, conf),
      },
    });
    if (!commit.ok) return this.answerRejected(meta, commit.reason, commit.pending);
    meta.stateRevision += 1;
    const prepared = commit.prepared;
    if (!prepared || !prepared.ok) {
      const reason = prepared && !prepared.ok ? prepared.reason : 'prepare_missing';
      return this.result(meta, 'failed', [], {}, { errors: [errorInfo('harness.prepare', reason === 'capacity_exhausted' ? 'STORAGE_RESERVATION_FAILED' : 'CONFIRMATION_INVALID', reason, 'none')] });
    }
    const r = await this.stageCompletionWithWait(meta, prepared.operation, prepared.authority, constraints);
    return { ...r, facts: { ...r.facts, retry: { status: 'started', retryOf: last.operationId } } };
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
          // 확인 질문은 실제로 전달한 문장이 저장된 범위(대상·행위·버전)와 맞을 때만 전달로 인정한다 (감사 F-01)
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
          // 기한 내 발화 시작은 무응답 타이머만 멈춘다
          if (p0 && !p0.speechStartedAt) await this.d.store.closePending(e.pendingId, 'expired', 'question_wait_expired');
        }
        break;
      case 'target_changed':
      case 'request_cancelled':
        for (const pd of await this.d.store.listWaitingPendings(e.requestId)) await this.d.store.closePending(pd.pendingId, 'revoked', e.kind);
        if (e.kind === 'request_cancelled') await this.cancel({ requestId: e.requestId, reason: 'request_cancelled' });
        break;
    }
    if (meta) meta.stateRevision += 1;
    return { applied: true };
  }

  // ===================================================================== cancel
  /**
   * 취소: 대기 중인 pending·미소비 확인을 revoked로, dispatch 전 operation의 실행 권한을 회수한다.
   * 전송 가능 경계를 지난 작업은 외부 취소 성공으로 기록하지 않고 결과 기록을 유지한다.
   */
  async cancel(signal: CancellationSignal): Promise<{ revokedPendings: string[]; revokedOperations: string[]; alreadyDispatched: string[] }> {
    const meta = this.requests.get(signal.requestId);
    if (meta) {
      meta.cancelled = true;
      meta.abort.abort();
    }
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
  /** 기존 결과 조회로만 복구한다. 쓰기를 실행하지 않는다. 동시에 하나의 복구 담당만 허용한다. */
  /**
   * 판정 대기(assessment=pending) operation의 센서 재검사. 외부 호출·재전송을 하지 않고 저장된 응답 증거만 다시 판정한다.
   * 판정되면 일반 경로와 같이 ActionResult를 확정한다. unknown이면 recovery=needed로 읽기 복구 대상이 된다.
   * 한계(MVP): 재검사로 승인이 성공 판정돼도 Eureka 후속 질문은 자동으로 시작하지 않는다.
   */
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
    } catch (e) {
      const after = await this.d.store.releaseRecovery(op.operationId, holder, 'still_unknown');
      void e;
      return { status: 'still_unknown', recovery: after.recovery, ...(after.actionResult ? { actionResult: after.actionResult } : {}) };
    }
    const inspected = this.inspect({ requestId: systemRequestId, cancelled: false }, op, g, priorEvidence);
    if (!inspected.ok) {
      // 센서 오류는 복구 실패로 보지 않는다. 복구 담당을 반드시 해제하고 외부 결과 불명 상태를 유지한다
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
    // 일치 결과를 찾지 못한 것은 실패 증거가 아니다: 현재 상태는 facts로, operation은 unknown 유지
    if (op.actionResult) {
      const kept: ActionResult = { ...op.actionResult, facts: { ...op.actionResult.facts, latestObservation: assessment.confirmedFacts }, observedAt: this.d.clock.nowIso() };
      await this.d.store.appendEvidence(op.operationId, { attemptId: last.attemptId, actionResult: kept });
    }
    const after = await this.d.store.releaseRecovery(op.operationId, holder, 'still_unknown');
    return { status: 'still_unknown', recovery: after.recovery, ...(after.actionResult ? { actionResult: after.actionResult } : {}) };
  }

  // ============================================================== guide loop
  private async runGuideLoop(meta: RequestMeta, turn: CurrentTurnInput, ctx: ContextPacket, constraints: ExecutionConstraints): Promise<HarnessResult> {
    const actionResults: ActionResult[] = [];
    const sources: SourceRef[] = [];
    const facts: GuideFacts = {};
    if (meta.intent === 'pr.approve' && ctx.target?.kind === 'github_pr') {
      const sha = await this.lastReviewedSha(meta.conversationId, ctx.target);
      if (sha) facts.lastReviewedSha = sha;
    }
    let wiki: { outcome: 'found' | 'empty' | 'failed' | 'not_queried'; excerpts: { text: string; source: SourceRef }[] } = { outcome: 'not_queried', excerpts: [] };

    for (let step = 0; step < this.cfg.maxGuideSteps; step++) {
      if (this.d.clock.nowMs() > Date.parse(constraints.deadlineAt)) {
        return this.result(meta, 'failed', actionResults, { ...exportFacts(facts) }, { errors: [errorInfo('harness', 'DEADLINE_EXCEEDED', 'call deadline exceeded', 'none')], sources });
      }
      if (meta.cancelled) return this.result(meta, 'cancelled', actionResults, exportFacts(facts), { sources });

      let decision: GuideDecision;
      try {
        decision = await this.guide.proposeNext({
          requestId: meta.requestId,
          turnId: turn.turnId,
          stateRevision: meta.stateRevision,
          goal: { currentTurn: turn, intent: meta.intent, allowedScope: ['get_review_context'] },
          context: { packet: ctx, wiki, unverified: [] },
          operations: [],
          confirmations: [],
          constraints: {
            deadlineAt: constraints.deadlineAt,
            policyVersion: this.cfg.policyVersion,
            maxSteps: this.cfg.maxGuideSteps,
            wikiSearchAllowed: constraints.wikiSearchAllowed !== false && !!this.d.wiki,
          },
          facts: facts as Record<string, unknown>,
        });
        decision = GuideDecisionSchema.parse(decision);
        const stepRef = decision.reasonRefs.find((r) => r.startsWith('llm:') || r.startsWith('llm_')) ?? `rule:${decision.kind}`;
        facts.guideSteps = [...(facts.guideSteps ?? []), stepRef];
      } catch (e) {
        // 가이드 오류는 도구를 실행하지 않고 처리 오류로 종료한다
        return this.result(meta, 'failed', actionResults, exportFacts(facts), { errors: [errorInfo('harness.guide', 'GUIDE_ERROR', e instanceof Error ? e.message : 'guide error', 'none')], sources });
      }
      if (decision.basedOnRevision !== meta.stateRevision) {
        return this.result(meta, 'failed', actionResults, exportFacts(facts), { errors: [errorInfo('harness.guide', 'STALE_REVISION', 'stale guide decision ignored', 'none')], sources });
      }

      switch (decision.kind) {
        case 'propose_action': {
          const a = decision.payload.typedArguments;
          // Guide는 쓰기를 제안할 수 없다. 쓰기는 확인 경로에서만 실행한다
          if (a.action !== 'get_review_context') {
            return this.result(meta, 'failed', actionResults, exportFacts(facts), { errors: [errorInfo('harness.guide', 'POLICY_BLOCKED', `action ${a.action} not allowed from guide`, 'none')], sources });
          }
          const { actionResult, review, error } = await this.executeReview(meta, a, constraints, meta.intent === 'pr.approve' ? 'approval_precheck' : 'review');
          if (actionResult) {
            actionResults.push(actionResult);
            sources.push({ kind: 'github', ref: `${a.repository.owner}/${a.repository.name}#${a.prNumber}`, observedAt: actionResult.observedAt });
          }
          if (review) facts.review = review;
          else facts.reviewError = error ?? 'review_read_failed';
          meta.stateRevision += 1;
          break;
        }
        case 'need_context': {
          // Wiki는 Guide 판단 참고 자료일 뿐이다 (D-19). 파이프라인이 허용하지 않으면 검색하지 않는다
          if (constraints.wikiSearchAllowed === false) {
            wiki = { outcome: 'not_queried', excerpts: [] };
          } else if (this.d.wiki) {
            try {
              wiki = await this.d.wiki.search(turn.rawText, decision.payload.searchScope, { deadlineAt: constraints.deadlineAt });
            } catch {
              wiki = { outcome: 'failed', excerpts: [] }; // 검색 결과 없음과 검색 실패를 구분
            }
            for (const e of wiki.excerpts) sources.push(e.source);
            if (wiki.outcome === 'found') facts.wikiExcerpts = capExcerpts(wiki.excerpts.map((e) => ({ text: e.text, ref: e.source.ref })));
          } else wiki = { outcome: 'failed', excerpts: [] };
          facts.wikiSearched = wiki.outcome;
          meta.stateRevision += 1;
          break;
        }
        case 'ask_user': {
          const p = decision.payload;
          const scope: ConfirmationScope | undefined =
            p.questionKind === 'confirmation' && p.targetActionVersion
              ? { action: p.targetActionVersion.action, target: p.targetActionVersion.target, ...(p.targetActionVersion.headSha ? { headSha: p.targetActionVersion.headSha } : {}) }
              : undefined;
          if (p.questionKind === 'confirmation' && !scope) {
            return this.result(meta, 'failed', actionResults, exportFacts(facts), { errors: [errorInfo('harness.guide', 'GUIDE_ERROR', 'confirmation without scope', 'none')], sources });
          }
          const view = await this.createQuestion(meta, p.questionKind, p.purpose, p.requiredSlots, scope);
          return this.result(meta, 'awaiting_user', actionResults, { ...exportFacts(facts), question: { ...questionFacts(view), ...(ctx.target ? { target: ctx.target } : {}) }, ...(decision.reasonRefs.length ? { questionReasons: decision.reasonRefs } : {}) }, { pending: view, sources });
        }
        case 'blocked':
          return this.result(meta, 'completed', actionResults, { ...exportFacts(facts), blocked: { reasons: decision.payload.unmetConditions, intent: meta.intent, ...(decision.reasonRefs.length ? { guideRefs: decision.reasonRefs } : {}) } }, { sources });
        case 'finish':
          if (decision.payload.reason === 'answer_partial') {
            // Guide가 Wiki 발췌로는 배경을 답할 수 없다고 봤다 → 발췌는 출력에 넘기지 않고, 못 찾았다고만 알린다
            delete facts.wikiExcerpts;
            return this.result(meta, 'completed', actionResults, { ...exportFacts(facts), backgroundNotFound: true }, { sources });
          }
          return this.result(meta, 'completed', actionResults, exportFacts(facts), { sources });
      }
    }
    return this.result(meta, 'failed', actionResults, exportFacts(facts), { errors: [errorInfo('harness.guide', 'GUIDE_ERROR', 'max guide steps reached', 'none')], sources });
  }

  // ============================================================= executions
  private async executeReview(
    meta: RequestMeta,
    a: Extract<import('@deskpet/contracts').ActionArgs, { action: 'get_review_context' }>,
    constraints: ExecutionConstraints,
    purpose: 'review' | 'approval_precheck',
  ): Promise<{ actionResult?: ActionResult; review?: ReviewFacts; error?: string }> {
    const target: GitHubPrTarget = { kind: 'github_pr', repository: a.repository, prNumber: a.prNumber };
    const prep = await this.d.store.reserveAndPrepare({
      owner: 'harness',
      requestId: meta.requestId,
      action: 'get_review_context',
      target,
      isWrite: false,
      expectedOutcome: expectedOutcomeFor('get_review_context', target, { sections: a.requestedSections, ...(a.expectedHeadSha ? { headSha: a.expectedHeadSha } : {}) }),
      checkRuleVersion: this.cfg.checkRuleVersion,
      actualRequest: { ...a, purpose, conversationId: meta.conversationId },
      priorEvidence: {},
      holderId: this.holderId,
    });
    if (!prep.ok) {
      const ar: ActionResult = { operationId: 'not-recorded', action: 'get_review_context', target, status: 'failed', dispatchState: 'not_sent', facts: {}, externalRefs: [], observedAt: this.d.clock.nowIso(), error: errorInfo('harness.prepare', 'STORAGE_RESERVATION_FAILED', prep.reason, 'none') };
      return { actionResult: ar, error: 'storage' };
    }
    const op = prep.operation;
    const ctx = await this.d.github.getReviewContext(
      { repository: a.repository, prNumber: a.prNumber, requestedSections: a.requestedSections, ...(a.expectedHeadSha ? { expectedHeadSha: a.expectedHeadSha } : {}), deadlineAt: constraints.deadlineAt },
      { deadlineAt: constraints.deadlineAt, signal: meta.abort.signal },
    );
    const facts = ctx.prBasics ? reviewFacts(ctx, purpose === 'approval_precheck' ? (a.expectedHeadSha ?? ctx.initialHeadSha) : undefined) : undefined;
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
      // 판정 대기: 조회 결과를 근거로 쓰지 않는다 (판정 없는 사실로 승인 질문을 만들지 않음)
      await this.d.store.appendEvidence(op.operationId, this.pendingAssessmentEvidence(op.attempts[0]!.attemptId, g, inspected.diagnostic, op.priorEvidence));
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
    return { actionResult: ar, ...(facts ? { review: facts } : { error: ctx.error?.provisionalCode ?? 'review_read_failed' }) };
  }

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
      // 성공이 아니면 Eureka 완료를 진행하지 않는다
      return this.result(meta, 'completed', [actionResult], { ...facts, followUp: { eligibility: 'not_started', reason: `approval_${actionResult.status}` } });
    }
    return this.followUpAfterApproval(meta, operation, actionResult, constraints, facts);
  }

  /**
   * 승인 성공과 후속 진행 적합성은 별도 사실이다. Eureka 질문 전에 최신 PR head·조건과 Eureka 대상 상태를 조회한다.
   * 승인 SHA와 달라졌거나 확인할 수 없으면 기존 승인 성공을 보존하고 후속 완료를 보류한다 (Liability §Confirmation 6).
   */
  private async followUpAfterApproval(meta: RequestMeta, approvalOp: OperationRecord, approval: ActionResult, constraints: ExecutionConstraints, facts: Record<string, unknown>): Promise<HarnessResult> {
    const t = approvalOp.target as GitHubPrTarget;
    const ref = meta.taskRefs.find((r) => r.stageId && r.prNumber === t.prNumber && r.repository?.owner === t.repository.owner && r.repository?.name === t.repository.name);
    if (!ref || !ref.stageId) {
      return this.result(meta, 'completed', [approval], { ...facts, followUp: { eligibility: 'not_applicable', reason: 'no_linked_eureka_stage' } });
    }
    const approvedSha = String(approvalOp.actualRequest['commitId']);
    const check = await this.followUpEligibility(t, approvedSha, ref.itemId, ref.stageId, constraints);
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
      target: { kind: 'eureka_stage', itemId: ref.itemId, stageId: ref.stageId },
      exactChange: {
        status: 'done',
        approvalOperationId: approvalOp.operationId,
        approvedSha,
        reviewId,
        // 확인 질문 문장이 함께 말하는 승인 PR (전달 문장 검사 허용 목록, 감사 F-01)
        linkedRepository: `${t.repository.owner}/${t.repository.name}`,
        linkedPrNumber: t.prNumber,
        priorStageStatus: check.evidence['stageStatus'],
        stageName: check.evidence['stageName'],
        followUpObservedAt: this.d.clock.nowIso(),
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

    // 동의 뒤 실행 직전에도 재검증한다
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
    return this.result(meta, 'completed', [actionResult], {
      stageCompletion: { status: actionResult.status, itemId: t.itemId, stageId: t.stageId, stageName: ar0['stageName'], dispatchState: actionResult.dispatchState },
    });
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
        // beforeDispatch에서 권한이 회수됨(취소·deadline·확인 무효)
        return { actionResult: current.actionResult, operation: current };
      }
      const priorEvidence = { ...current.priorEvidence, ...(g.response?.['priorReviewIds'] ? { priorReviewIds: g.response['priorReviewIds'] } : {}) };
      const inspected = this.inspect(meta, current, g, priorEvidence);
      if (!inspected.ok) {
        // 센서만 실패: 재전송·재시도·unknown 매핑 없이 판정 대기로 남기고 reassess()로 재검사한다.
        // 응답 없이 전송됐을 수 있으면 외부 결과 확인(읽기 복구)도 필요하다
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

  /** 판정 대기 응답: 성공·실패·불명을 말하지 않고 판정이 끝나지 않았다는 사실만 돌려준다 */
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

  /** beforeDispatch 재검사: 취소·deadline·확인 유효성 */
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
          // 재시작·복구 뒤 Eureka 후속 질문을 만들 때 쓴다 (D-24)
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
    throw new Error(`unsupported confirmation scope ${s.action}`);
  }

  private async createQuestion(meta: RequestMeta, kind: 'clarification' | 'confirmation', purpose: string, requiredSlots: string[], scope?: ConfirmationScope): Promise<PendingView> {
    // 재질문·확인 재발급: 기존 pending과 미소비 confirmation을 닫고 새로 발급한다
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
    // 낡은 revision·중복·만료는 실행하지 않고 현재 상태를 반환한다
    if (pending && pending.state === 'waiting') {
      return this.result(meta, 'awaiting_user', [], { answerNotAccepted: reason }, { pending: viewOf(pending) });
    }
    return this.result(meta, 'completed', [], { answerNotAccepted: reason, pendingState: pending?.state });
  }

  /**
   * Sensor 호출. 센서 자체 오류는 판정을 만들지 않는다 (guide-sensor: suggestedActionStatus 미생성, assessment=pending).
   * 외부 결과 불명(unknown)과 판정 대기를 구분하기 위해 오류를 별도 값으로 돌려준다.
   */
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

  /** 판정 대기 기록: 응답 증거(재검사용 GatewayResult 포함)를 남기고 확정 ActionResult는 만들지 않는다 */
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
    // 증거 요구를 충족하지 못한 성공은 unknown으로 낮춘다 (succeeded 승격 금지)
    return { ...candidate, status: 'unknown', dispatchState: write ? (g.dispatchState === 'not_sent' ? 'may_have_been_sent' : g.dispatchState) : 'sent', externalRefs: [], error: errorInfo('sensor', 'MCP_RESULT_UNKNOWN', checked.error.issues.map((i) => i.message).join('; '), 'reconcile', op.operationId) };
  }

  private async lastReviewedSha(conversationId: string, target: GitHubPrTarget): Promise<string | undefined> {
    const ops = (await this.d.store.listOperations())
      .filter(
        (o) =>
          o.action === 'get_review_context' &&
          o.actualRequest['purpose'] === 'review' &&
          o.actualRequest['conversationId'] === conversationId &&
          o.target.kind === 'github_pr' &&
          o.target.prNumber === target.prNumber &&
          o.target.repository.owner === target.repository.owner &&
          o.target.repository.name === target.repository.name &&
          o.actionResult?.status === 'succeeded',
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const sha = ops[0]?.actionResult?.facts['headSha'];
    return typeof sha === 'string' ? sha : undefined;
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

  /** 답변을 기다리지 않는 요청은 메모리에서 지운다. 결과는 turn 기록·operation 기록에 남아 있다 */
  private settle(result: HarnessResult) {
    const m = this.requests.get(result.requestId);
    if (!m || m.backgroundRunning) return;
    if (result.disposition === 'awaiting_user') m.touchedAtMs = this.d.clock.nowMs();
    else if (!m.eventGap) this.requests.delete(result.requestId);
  }

  /**
   * 질문 유효 기간이 지난 항목을 지운다. 그래도 상한을 넘으면 오래된 것부터 지우되, 순서 누락(eventGap)·취소 표시가 있는
   * 항목은 유효 기간이 지날 때까지 남긴다 (지우면 그 표시로 막던 실행이 풀릴 수 있으므로).
   */
  private sweepRequests() {
    if (this.requests.size <= MAX_TRACKED_REQUESTS) return;
    const now = this.d.clock.nowMs();
    const ttl = Math.max(this.cfg.confirmationTtlMs, this.cfg.clarificationTtlMs) * 2;
    for (const [id, m] of this.requests) if (now - m.touchedAtMs > ttl) this.requests.delete(id);
    for (const [id, m] of this.requests) {
      if (this.requests.size <= MAX_TRACKED_REQUESTS) break;
      if (!m.eventGap && !m.cancelled) this.requests.delete(id);
    }
  }

  /** 진단·테스트용: 메모리에 들고 있는 요청 수 */
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

// ==================================================================== utils
/** 승인 대상 PR과 연결된 Eureka 단계 (taskRefs). 복구 뒤 후속 질문에 쓰려고 operation에 남긴다 */
function linkedStageOf(refs: TaskRef[], t: GitHubPrTarget): { linkedStage?: TaskRef } {
  const ref = refs.find((r) => r.stageId && r.prNumber === t.prNumber && r.repository?.owner === t.repository.owner && r.repository?.name === t.repository.name);
  return ref ? { linkedStage: ref } : {};
}

/** 실패한 Eureka 반영 다시 하기 의도 (라우터 intention, D-23). 값은 잠정 */
const RETRY_INTENTS: ReadonlySet<string> = new Set(['eureka.retry', 'followup.retry']);

function intentOf(turn: CurrentTurnInput): string {
  const v = turn.routeDecision.headOutputs['intention']?.value;
  return typeof v === 'string' ? v : 'unknown';
}

function errorInfo(stage: string, code: ProvisionalErrorCode, message: string, next: ErrorInfo['nextAction'], operationId?: string): ErrorInfo {
  return { stage, provisionalCode: code, message, nextAction: next, ...(operationId ? { operationId } : {}) };
}

/** L-10 상한: 발췌 3개·합계 1,500자 */
function capExcerpts(xs: { text: string; ref: string }[]): { text: string; ref: string }[] {
  let budget = 1_500;
  const out: { text: string; ref: string }[] = [];
  for (const x of xs.slice(0, 3)) {
    if (budget <= 0) break;
    const text = x.text.slice(0, budget);
    budget -= text.length;
    out.push({ text, ref: x.ref });
  }
  return out;
}

function exportFacts(f: GuideFacts): Record<string, unknown> {
  return {
    ...(f.review ? { review: f.review } : {}),
    ...(f.reviewError ? { reviewError: f.reviewError } : {}),
    ...(f.lastReviewedSha ? { lastReviewedSha: f.lastReviewedSha } : {}),
    ...(f.wikiSearched ? { wikiSearch: f.wikiSearched } : {}),
    ...(f.wikiExcerpts?.length ? { wiki: { excerpts: f.wikiExcerpts } } : {}),
    ...(f.guideSteps?.length ? { guideSteps: f.guideSteps } : {}),
  };
}

function questionMeaning(s: ConfirmationScope): string {
  if (s.target.kind === 'github_pr') return `APPROVE ${s.target.repository.owner}/${s.target.repository.name}#${s.target.prNumber} @ ${s.headSha}`;
  if (s.target.kind === 'eureka_stage') return `COMPLETE_STAGE item=${s.target.itemId} stage=${s.target.stageId} status=done`;
  return `${s.action}`;
}

function questionFacts(v: PendingView): Record<string, unknown> {
  return { purpose: v.purpose, kind: v.kind, requiredSlots: v.requiredSlots, ...(v.scope ? { scope: v.scope, meaning: questionMeaning(v.scope) } : {}) };
}

function viewOf(p: Pending): PendingView {
  return { pendingId: p.pendingId, revision: p.revision, kind: p.kind, purpose: p.purpose, requiredSlots: p.requiredSlots, ...(p.scope ? { scope: p.scope } : {}), outputId: p.outputId, expiresAt: p.expiresAt };
}
