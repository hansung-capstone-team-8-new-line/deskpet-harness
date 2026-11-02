import {
  BRIDGE_FACT_KEYS as K,
  ContextTurn,
  ReminderPayload,
  TaskRef,
  Target,
  type ActionResult,
  type ContextPacket,
  type CurrentTurnInput,
  type ErrorInfo,
  type ExecutionConstraints,
  type HarnessResult,
  type OutputRequest,
  type Pending,
  type PipelineActionRequest,
  type PipelineActionResult,
  type PipelineActionStatus,
  type PipelineError,
  type PipelineHarnessRequest,
  type PipelineHarnessResult,
  type PipelineOutputRequest,
} from '@deskpet/contracts';
import type { HarnessService, OperationStore } from '@deskpet/harness';
import { OutputService, mapHarnessResult, requiredMeaning } from '@deskpet/output';

/**
 * 파이프라인 문서 형식(HarnessAdapter.run / reconcile, OutputModel.generate)을 현재 Harness·출력 체인에 연결한다.
 *
 * 문서에 있는 것은 문서를 따른다
 * - 한 번의 run 호출이 HarnessResult {action, question, resultText}를 돌려준다. 질문은 status=needs_clarification + question 문장
 * - mutationApproved=false면 쓰기를 하지 않는다 (Harness도 답변을 따로 검사)
 * - 응답 유실은 unknown, reconcile로만 확인한다 (재전송 없음)
 *
 * 문서에 없는 것은 현재 구현을 따른다 (docs/pipeline-bridge.md)
 * - 질문·결과 문장은 코드가 만든 고정 문장이다 (LLM이 아님). 대상·행위·커밋 범위 문구가 들어 있다
 * - 확인 질문 전달은 기존 pipeline.event question_delivered + deliveredText로 보고한다. pendingId·outputId는 facts로 준다
 * - 답변 연결: pendingClarification.pendingId → 같은 requestId의 대기 질문 → (답변으로 보이는 발화면) 같은 대화의 최근 대기 질문
 * - 대기 질문이 있는데 다른 업무 요청이 오면 그 질문을 철회하고 새 요청으로 처리한다 (이전 확인에 "네"가 붙지 않도록)
 */
export interface PipelineBridgeDeps {
  harness: HarnessService;
  store: OperationStore;
  /** 실제 출력 체인 (모델이 있으면 모델 사용) */
  output: OutputService;
  defaultConversationId?: string;
}

const WRITE_ACTIONS = new Set(['submit_approval', 'complete_stage']);
const DEFAULT_CONVERSATION = 'deskpet-default';

export class PipelineBridge {
  /** 결과 문장은 항상 고정 문구로 만든다 (모델 없음) */
  private readonly fixed = new OutputService();

  constructor(private readonly d: PipelineBridgeDeps) {}

  // ================================================================ run
  async run(p: PipelineHarnessRequest): Promise<PipelineHarnessResult> {
    const conversationId = this.conversationOf(p);
    const turn = toTurn(p, conversationId);
    const constraints: ExecutionConstraints = { deadlineAt: p.action.deadlineAt, maxPages: 3, maxResultBytes: 256_000, policyVersion: 'policy-0.1', wikiSearchAllowed: p.wikiSearchAllowed };
    const waiting = await this.d.store.listWaitingPendingsByConversation(conversationId);
    const pending = pickPending(waiting, p, turn);

    let r: HarnessResult;
    if (pending) {
      const conf = pending.kind === 'confirmation' ? await this.d.store.getConfirmationForPending(pending.pendingId) : undefined;
      r = await this.d.harness.resume({
        originalRequestId: pending.requestId,
        currentTurn: turn,
        // 답변은 질문을 만든 맥락으로 받는다 (맥락이 바뀌었으면 Harness가 새 요청으로 다룬다)
        context: { ...toContext(p, conversationId), contextId: pending.contextId, version: pending.contextVersion },
        pendingId: pending.pendingId,
        expectedPendingRevision: pending.revision,
        ...(conf ? { confirmationId: conf.confirmationId } : {}),
        newCallConstraints: constraints,
        ...(pending.kind === 'confirmation' ? { externalApproval: p.mutationApproved } : {}),
      });
    } else {
      // 다른 요청이 오면 남아 있는 질문은 철회한다
      for (const w of waiting) await this.d.store.closePending(w.pendingId, 'revoked', 'superseded_by_new_request');
      r = await this.d.harness.handle({ requestId: p.action.requestId, currentTurn: turn, context: toContext(p, conversationId), constraints });
    }
    return this.toPipelineResult(r, p.action.operationId);
  }

  // ========================================================== reconcile
  /** 결과를 모르는 쓰기를 기존 결과 조회로만 확인한다. 다시 보내지 않는다 */
  async reconcile(a: PipelineActionRequest): Promise<PipelineActionResult> {
    const ops = (await this.d.store.listOperations(a.requestId)).filter((o) => WRITE_ACTIONS.has(o.action));
    const op = ops.find((o) => o.recovery === 'needed') ?? ops[ops.length - 1];
    if (!op) {
      return { operationId: a.operationId, status: 'unknown', facts: {}, error: { code: 'RECONCILIATION_UNAVAILABLE', message: 'no write operation recorded for this request', retryable: false } };
    }
    const rec = await this.d.harness.reconcile(op.operationId, `bridge-${a.operationId}`, { deadlineAt: a.deadlineAt });
    const ar = rec.actionResult ?? (await this.d.store.getOperation(op.operationId))?.actionResult;
    if (!ar) {
      return { operationId: a.operationId, status: 'unknown', facts: { [K.harnessOperationId]: op.operationId, recovery: rec.status }, error: { code: 'RECONCILIATION_PENDING', message: `recovery ${rec.status}`, retryable: true, operationId: a.operationId } };
    }
    return {
      operationId: a.operationId,
      status: ar.status,
      facts: { [K.harnessOperationId]: op.operationId, [K.action]: ar.action, [K.dispatchState]: ar.dispatchState, recovery: rec.status },
      error: ar.error ? toError(ar.error, a.operationId) : null,
    };
  }

  // =========================================================== generate
  /**
   * 출력 모델 (OutputModel.generate → String). requiredText를 기준 문장으로 다듬는다.
   * 성공하지 않은 작업은 다듬지 않고 기준 문장 그대로 돌려준다. 검사·실패 시 고정 문구 규칙은 OutputService와 같다.
   */
  async generate(o: PipelineOutputRequest): Promise<string> {
    return (await this.generateDetailed(o)).text;
  }

  /** generate와 같고 출력 모델 호출 시간(modelMs)도 돌려준다 (NFR-01, D-26) */
  async generateDetailed(o: PipelineOutputRequest): Promise<{ text: string; modelMs?: number }> {
    const st = o.action?.status;
    if (st && st !== 'succeeded' && st !== 'needs_clarification') return { text: o.requiredText };
    const reminder = ReminderPayload.safeParse(o.reminder);
    const tokens = (o.action?.facts[K.requiredMeaning] ?? '').split('\n').filter(Boolean);
    const pendingId = o.action?.facts[K.pendingId];
    const isQuestion = o.isQuestion && !!pendingId;
    const req: OutputRequest = {
      outputId: o.outputId,
      requestRefs: { requestId: o.requestId, operationIds: [] },
      purpose: reminder.success ? 'reminder' : isQuestion ? 'question' : 'result',
      actionResults: [],
      facts: { ...(o.action?.facts ?? {}), baseText: o.requiredText, ...wikiFromFacts(o.action?.facts) },
      sources: [],
      // 고정 범위 문구가 있으면 그것을, 없으면 기준 문장 전체를 지킨다
      requiredMeaning: reminder.success ? [] : tokens.length ? tokens : [o.requiredText],
      constraints: { language: 'ko-KR', maxSpeechChars: Math.max(220, o.requiredText.length + 60), allowedEmotions: ['neutral', 'cheerful', 'concerned', 'thinking', 'apologetic'] },
      ...(isQuestion ? { pendingId } : {}),
      ...(reminder.success ? { reminder: reminder.data } : {}),
    };
    const c = await this.d.output.generate(req);
    return { text: c.text, ...(c.modelMs !== undefined ? { modelMs: c.modelMs } : {}) };
  }

  // ============================================================= mapping
  private conversationOf(p: PipelineHarnessRequest): string {
    const s = p.context.stamp['conversationId'];
    return p.conversationId ?? (typeof s === 'string' && s ? s : (this.d.defaultConversationId ?? DEFAULT_CONVERSATION));
  }

  /** HarnessResult → 파이프라인 문서 형식 (notice 변환에도 쓴다) */
  async toPipelineResult(r: HarnessResult, operationId: string): Promise<PipelineHarnessResult> {
    const text = (await this.fixed.generate(mapHarnessResult(r))).text;
    const awaiting = r.disposition === 'awaiting_user' && !!r.pending;
    const primary = pickPrimary(r.actionResults);
    const status = statusOf(r, primary, awaiting);
    const facts: Record<string, string> = { [K.harnessRequestId]: r.requestId, [K.disposition]: r.disposition };
    if (primary) {
      facts[K.action] = primary.action;
      facts[K.harnessOperationId] = primary.operationId;
      facts[K.dispatchState] = primary.dispatchState;
    }
    if (awaiting) {
      const pv = r.pending!;
      facts[K.questionKind] = pv.kind;
      facts[K.questionPurpose] = pv.purpose;
      facts[K.pendingId] = pv.pendingId;
      facts[K.outputId] = pv.outputId;
      facts[K.expiresAt] = pv.expiresAt;
      const req = requiredMeaning(r);
      if (req.length) facts[K.requiredMeaning] = req.join('\n');
    }
    const review = r.facts['review'] as { prNumber?: number; repository?: string; headSha?: string } | undefined;
    if (review?.prNumber) facts['prNumber'] = String(review.prNumber);
    if (review?.repository) facts['repository'] = String(review.repository);
    if (review?.headSha) facts['headSha'] = review.headSha;
    const blocked = r.facts['blocked'] as { reasons?: string[] } | undefined;
    if (blocked?.reasons?.length) facts['blockedReasons'] = blocked.reasons.join(',');
    // D-23: 응답 뒤에도 진행 중인 Eureka 반영 — 끝나면 서버 notice로 결과가 온다
    const sc = r.facts['stageCompletion'] as { status?: string; operationId?: string } | undefined;
    if (sc?.status === 'in_progress') {
      facts['inProgress'] = 'true';
      if (sc.operationId) facts[K.harnessOperationId] = sc.operationId;
    }
    const retry = r.facts['retry'] as { status?: string } | undefined;
    if (retry?.status) facts['retryStatus'] = retry.status;
    // 팀 문서 발췌 (L-10 상한 안). 파이프라인은 output.generate에 이 facts를 그대로 넘긴다
    const wiki = (r.facts['wiki'] as { excerpts?: unknown[] } | undefined)?.excerpts;
    if (wiki?.length) facts['wikiExcerpts'] = JSON.stringify(wiki);
    // 단계별 시간 (NFR-01, D-26): {"totalMs":…, "stages":[{stage, ms, ok}]}
    if (r.facts['timings']) facts['timings'] = JSON.stringify(r.facts['timings']);

    const err = errorOf(r, primary, operationId);
    return {
      action: { operationId, status, facts, error: err },
      question: awaiting ? text : null,
      resultText: awaiting ? null : text,
    };
  }
}

// ==================================================================== helpers
function wikiFromFacts(f: Record<string, string> | undefined): { wiki?: { excerpts: { text: string; ref: string }[] } } {
  const raw = f?.['wikiExcerpts'];
  if (!raw) return {};
  try {
    const xs = JSON.parse(raw) as unknown;
    if (!Array.isArray(xs)) return {};
    const excerpts = xs
      .filter((x): x is { text: string; ref: string } => !!x && typeof (x as { text?: unknown }).text === 'string' && typeof (x as { ref?: unknown }).ref === 'string')
      .slice(0, 3);
    return excerpts.length ? { wiki: { excerpts } } : {};
  } catch {
    return {};
  }
}

function toTurn(p: PipelineHarnessRequest, conversationId: string): CurrentTurnInput {
  const conf = p.transcript.sttConfidence;
  const d = p.action.decision;
  return {
    conversationId,
    turnId: p.context.turnId,
    rawText: p.transcript.text,
    isFinal: p.transcript.isFinal,
    inputChannel: 'voice',
    sttConfidenceState: conf === undefined ? 'unavailable' : 'provided',
    ...(conf === undefined ? {} : { sttConfidence: conf }),
    routeDecision: {
      headOutputs: Object.fromEntries(Object.entries(d.headOutputs).map(([k, h]) => [k, { value: h.value, confidence: h.confidence }])),
      overallConfidence: d.overallConfidence,
      missingRequiredSlots: d.missingRequiredSlots,
      route: d.route,
      sourceTurnIds: [],
    },
  };
}

function toContext(p: PipelineHarnessRequest, conversationId: string): ContextPacket {
  const s = p.context.stamp;
  const target = Target.safeParse(p.action.decision.resolvedTarget);
  const active = Target.safeParse(p.context.activeTarget);
  const refs = TaskRef.array().safeParse((p as Record<string, unknown>)['taskRefs']);
  const turns = p.context.turns.flatMap((t) => {
    const x = t as { role?: unknown; content?: unknown; text?: unknown; turnId?: unknown };
    const c = ContextTurn.safeParse({ role: x.role, content: x.content ?? x.text, ...(typeof x.turnId === 'string' ? { turnId: x.turnId } : {}) });
    return c.success ? [c.data] : [];
  });
  const version = typeof s['version'] === 'number' && Number.isInteger(s['version']) && s['version'] >= 0 ? s['version'] : 1;
  return {
    contextId: typeof s['contextId'] === 'string' && s['contextId'] ? s['contextId'] : `ctx-${conversationId}`,
    version,
    ...(target.success ? { target: target.data } : active.success ? { target: active.data } : {}),
    candidates: [],
    relatedTurns: turns,
    taskRefs: refs.success ? refs.data : [],
  };
}

const ANSWER_INTENT = /^(confirm|answer|yes|no)/;

/** 이 발화가 대기 중 질문의 답인지. 다른 업무 의도가 분명하면 답으로 보지 않는다 */
function pickPending(waiting: Pending[], p: PipelineHarnessRequest, turn: CurrentTurnInput): Pending | undefined {
  if (waiting.length === 0) return undefined;
  const pc = p.context.pendingClarification as { pendingId?: unknown } | undefined;
  if (typeof pc?.pendingId === 'string') {
    const hit = waiting.find((w) => w.pendingId === pc.pendingId);
    if (hit) return hit;
  }
  const same = waiting.filter((w) => w.requestId === p.action.requestId);
  if (same.length) return same[same.length - 1];
  const intent = turn.routeDecision.headOutputs['intention']?.value;
  const looksLikeAnswer = p.mutationApproved || intent === undefined || intent === null || (typeof intent === 'string' && ANSWER_INTENT.test(intent));
  return looksLikeAnswer ? waiting[waiting.length - 1] : undefined;
}

function pickPrimary(rs: ActionResult[]): ActionResult | undefined {
  const writes = rs.filter((a) => WRITE_ACTIONS.has(a.action));
  return writes[writes.length - 1] ?? rs[rs.length - 1];
}

function statusOf(r: HarnessResult, primary: ActionResult | undefined, awaiting: boolean): PipelineActionStatus {
  if (awaiting) return 'needs_clarification';
  if (r.facts['assessmentPending']) return 'unknown';
  if (r.disposition === 'cancelled' || r.facts['declined']) return 'cancelled';
  if (r.facts['blocked'] || r.disposition === 'failed') return 'failed';
  // D-23: 진행 중은 아직 결과가 없다 (unknown + facts.inProgress). 다시 하기를 시작하지 않았으면 실패로 알린다
  if ((r.facts['stageCompletion'] as { status?: string } | undefined)?.status === 'in_progress' && !primary) return 'unknown';
  const retry = (r.facts['retry'] as { status?: string } | undefined)?.status;
  if (retry && retry !== 'started' && !primary) return retry === 'already_done' ? 'succeeded' : 'failed';
  return primary?.status ?? 'succeeded';
}

function errorOf(r: HarnessResult, primary: ActionResult | undefined, operationId: string): PipelineError | null {
  if (primary?.error && primary.status !== 'succeeded') return toError(primary.error, operationId);
  if (r.processingErrors[0]) return toError(r.processingErrors[0], operationId);
  const blocked = r.facts['blocked'] as { reasons?: string[] } | undefined;
  if (blocked) return { code: 'POLICY_BLOCKED', message: `blocked: ${(blocked.reasons ?? []).join(', ')}`, retryable: false, operationId, stage: 'harness.policy' };
  return null;
}

function toError(e: ErrorInfo, operationId: string): PipelineError {
  return { code: e.provisionalCode, message: e.message, retryable: e.nextAction === 'bounded_read_retry', operationId, stage: e.stage };
}
