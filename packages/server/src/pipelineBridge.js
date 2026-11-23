import { BRIDGE_FACT_KEYS as K, ContextTurn, ReminderPayload, TaskRef, Target, } from '@deskpet/contracts';
import { OutputService, mapHarnessResult, requiredMeaning } from '@deskpet/output';
const WRITE_ACTIONS = new Set(['submit_approval', 'complete_stage', 'mcp_tool_call']);
const DEFAULT_CONVERSATION = 'deskpet-default';
export class PipelineBridge {
    d;
    /** 결과 문장은 항상 고정 문구로 만든다 (모델 없음) */
    fixed = new OutputService();
    constructor(d) {
        this.d = d;
    }
    // ================================================================ run
    async run(p) {
        const conversationId = this.conversationOf(p);
        const turn = toTurn(p, conversationId);
        const constraints = { deadlineAt: p.action.deadlineAt, maxPages: 3, maxResultBytes: 256_000, policyVersion: 'policy-0.1', wikiSearchAllowed: p.wikiSearchAllowed };
        const waiting = await this.d.store.listWaitingPendingsByConversation(conversationId);
        const pending = pickPending(waiting, p, turn);
        let r;
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
        }
        else {
            // 다른 요청이 오면 남아 있는 질문은 철회한다
            for (const w of waiting)
                await this.d.store.closePending(w.pendingId, 'revoked', 'superseded_by_new_request');
            r = await this.d.harness.handle({ requestId: p.action.requestId, currentTurn: turn, context: toContext(p, conversationId), constraints });
        }
        return this.toPipelineResult(r, p.action.operationId);
    }
    // ========================================================== reconcile
    /** 결과를 모르는 쓰기를 기존 결과 조회로만 확인한다. 다시 보내지 않는다 */
    async reconcile(a) {
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
    async generate(o) {
        return (await this.generateDetailed(o)).text;
    }
    /** generate와 같고 출력 모델 호출 시간(modelMs)도 돌려준다 (NFR-01, D-26) */
    async generateDetailed(o) {
        const st = o.action?.status;
        // 화면 계약(D-32): 쓰기 작업 결과(dispatchState가 있는 결과)만 actionStatus로 주고, 감정은 결과에 맞춘다
        const wrote = !!o.action?.facts[K.dispatchState];
        const actionStatus = wrote && (st === 'succeeded' || st === 'failed' || st === 'unknown') ? st : undefined;
        const emotionFor = (e) => (actionStatus === 'succeeded' ? 'happy' : actionStatus === 'failed' ? 'sad' : actionStatus === 'unknown' ? 'neutral' : e);
        if (st && st !== 'succeeded' && st !== 'needs_clarification')
            return { text: o.requiredText, emotion: emotionFor(st === 'failed' ? 'sad' : 'neutral'), ...(actionStatus ? { actionStatus } : {}) };
        const reminder = ReminderPayload.safeParse(o.reminder);
        const tokens = (o.action?.facts[K.requiredMeaning] ?? '').split('\n').filter(Boolean);
        const pendingId = o.action?.facts[K.pendingId];
        const isQuestion = o.isQuestion && !!pendingId;
        const req = {
            outputId: o.outputId,
            requestRefs: { requestId: o.requestId, operationIds: [] },
            purpose: reminder.success ? 'reminder' : isQuestion ? 'question' : 'result',
            actionResults: [],
            facts: { ...(o.action?.facts ?? {}), baseText: o.requiredText, ...wikiFromFacts(o.action?.facts) },
            sources: [],
            // 고정 범위 문구가 있으면 그것을, 없으면 기준 문장 전체를 지킨다
            requiredMeaning: reminder.success ? [] : tokens.length ? tokens : [o.requiredText],
            constraints: { language: 'ko-KR', maxSpeechChars: Math.max(220, o.requiredText.length + 60), allowedEmotions: ['neutral', 'happy', 'sad'] },
            ...(isQuestion ? { pendingId } : {}),
            ...(reminder.success ? { reminder: reminder.data } : {}),
        };
        const c = await this.d.output.generate(req);
        return { text: c.text, displayText: c.displayText, emotion: emotionFor(c.emotion), ...(actionStatus ? { actionStatus } : {}), ...(c.modelMs !== undefined ? { modelMs: c.modelMs } : {}) };
    }
    // ============================================================= mapping
    conversationOf(p) {
        const s = p.context.stamp['conversationId'];
        return p.conversationId ?? (typeof s === 'string' && s ? s : (this.d.defaultConversationId ?? DEFAULT_CONVERSATION));
    }
    /** HarnessResult → 파이프라인 문서 형식 (notice 변환에도 쓴다) */
    async toPipelineResult(r, operationId) {
        const text = (await this.fixed.generate(mapHarnessResult(r))).text;
        const awaiting = r.disposition === 'awaiting_user' && !!r.pending;
        const primary = pickPrimary(r.actionResults);
        const status = statusOf(r, primary, awaiting);
        const facts = { [K.harnessRequestId]: r.requestId, [K.disposition]: r.disposition };
        if (primary) {
            facts[K.action] = primary.action;
            facts[K.harnessOperationId] = primary.operationId;
            facts[K.dispatchState] = primary.dispatchState;
        }
        if (awaiting) {
            const pv = r.pending;
            facts[K.questionKind] = pv.kind;
            facts[K.questionPurpose] = pv.purpose;
            facts[K.pendingId] = pv.pendingId;
            facts[K.outputId] = pv.outputId;
            facts[K.expiresAt] = pv.expiresAt;
            const req = requiredMeaning(r);
            if (req.length)
                facts[K.requiredMeaning] = req.join('\n');
        }
        const review = r.facts['review'];
        if (review?.prNumber)
            facts['prNumber'] = String(review.prNumber);
        if (review?.repository)
            facts['repository'] = String(review.repository);
        if (review?.headSha)
            facts['headSha'] = review.headSha;
        const blocked = r.facts['blocked'];
        if (blocked?.reasons?.length)
            facts['blockedReasons'] = blocked.reasons.join(',');
        // 확인 답변을 승인으로 받지 않은 이유 (예: input not acceptable for approval: stt_confidence_low / pipeline did not mark … mutationApproved=false)
        const unclear = r.facts['unclearAnswer'];
        if (unclear?.reason)
            facts['unclearAnswerReason'] = unclear.reason;
        // 승인 뒤 Eureka 반영을 건너뛰거나 보류한 이유 (예: no_linked_eureka_stage, sha_changed_since_approval)
        const fu = r.facts['followUp'];
        if (fu?.eligibility && fu.eligibility !== 'eligible')
            facts['followUp'] = [fu.eligibility, fu.reason, ...(fu.conditions ?? [])].filter(Boolean).join(',');
        if (typeof r.facts['interpretedIntent'] === 'string' && r.facts['interpretedIntent'])
            facts['interpretedIntent'] = r.facts['interpretedIntent'];
        if (typeof r.facts['reroute'] === 'string' && r.facts['reroute'])
            facts['reroute'] = r.facts['reroute'];
        for (const k of ['workerId', 'permissionRequestId', 'server', 'toolName']) {
            if (typeof r.facts[k] === 'string' && r.facts[k])
                facts[k] = r.facts[k];
        }
        if (r.facts['swarm'])
            facts['swarmSummary'] = JSON.stringify(r.facts['swarm']);
        if (r.facts['interrupted'])
            facts['interrupted'] = JSON.stringify(r.facts['interrupted']);
        if (r.facts['workspace'])
            facts['workspace'] = JSON.stringify(r.facts['workspace']);
        if (r.facts['directEureka'])
            facts['directEureka'] = JSON.stringify(r.facts['directEureka']);
        if (r.facts['triage'])
            facts['triage'] = JSON.stringify(r.facts['triage']);
        const questionReasons = r.facts['questionReasons'];
        if (Array.isArray(questionReasons)) {
            facts['questionReasons'] = JSON.stringify(questionReasons.filter((s) => typeof s === 'string').slice(0, 16).map((s) => s.slice(0, 256)));
        }
        // D-23: 응답 뒤에도 진행 중인 Eureka 반영 — 끝나면 서버 notice로 결과가 온다
        const sc = r.facts['stageCompletion'];
        if (sc?.status === 'in_progress') {
            facts['inProgress'] = 'true';
            if (sc.operationId)
                facts[K.harnessOperationId] = sc.operationId;
        }
        const retry = r.facts['retry'];
        if (retry?.status)
            facts['retryStatus'] = retry.status;
        // 팀 문서 발췌 (L-10 상한 안). 파이프라인은 output.generate에 이 facts를 그대로 넘긴다
        const wiki = r.facts['wiki']?.excerpts;
        if (wiki?.length)
            facts['wikiExcerpts'] = JSON.stringify(wiki);
        // 단계별 시간 (NFR-01, D-26): {"totalMs":…, "stages":[{stage, ms, ok}]}
        if (r.facts['timings'])
            facts['timings'] = JSON.stringify(r.facts['timings']);
        const err = errorOf(r, primary, operationId);
        return {
            action: { operationId, status, facts, error: err },
            question: awaiting ? text : null,
            resultText: awaiting ? null : text,
        };
    }
}
// ==================================================================== helpers
function wikiFromFacts(f) {
    const raw = f?.['wikiExcerpts'];
    if (!raw)
        return {};
    try {
        const xs = JSON.parse(raw);
        if (!Array.isArray(xs))
            return {};
        const excerpts = xs
            .filter((x) => !!x && typeof x.text === 'string' && typeof x.ref === 'string')
            .slice(0, 3);
        return excerpts.length ? { wiki: { excerpts } } : {};
    }
    catch {
        return {};
    }
}
function toTurn(p, conversationId) {
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
function toContext(p, conversationId) {
    const s = p.context.stamp;
    const target = Target.safeParse(p.action.decision.resolvedTarget);
    const active = Target.safeParse(p.context.activeTarget);
    const refs = TaskRef.array().safeParse(p['taskRefs']);
    const turns = p.context.turns.flatMap((t) => {
        const x = t;
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
function pickPending(waiting, p, turn) {
    if (waiting.length === 0)
        return undefined;
    const pc = p.context.pendingClarification;
    if (typeof pc?.pendingId === 'string') {
        const hit = waiting.find((w) => w.pendingId === pc.pendingId);
        if (hit)
            return hit;
    }
    const same = waiting.filter((w) => w.requestId === p.action.requestId);
    if (same.length)
        return same[same.length - 1];
    const intent = turn.routeDecision.headOutputs['intention']?.value;
    const looksLikeAnswer = p.mutationApproved || intent === undefined || intent === null || (typeof intent === 'string' && ANSWER_INTENT.test(intent));
    return looksLikeAnswer ? waiting[waiting.length - 1] : undefined;
}
function pickPrimary(rs) {
    const writes = rs.filter((a) => WRITE_ACTIONS.has(a.action));
    return writes[writes.length - 1] ?? rs[rs.length - 1];
}
function statusOf(r, primary, awaiting) {
    if (awaiting)
        return 'needs_clarification';
    if (r.facts['assessmentPending'])
        return 'unknown';
    if (r.disposition === 'cancelled' || r.facts['declined'])
        return 'cancelled';
    if (r.facts['blocked'] || r.disposition === 'failed')
        return 'failed';
    // D-23: 진행 중은 아직 결과가 없다 (unknown + facts.inProgress). 다시 하기를 시작하지 않았으면 실패로 알린다
    if (r.facts['stageCompletion']?.status === 'in_progress' && !primary)
        return 'unknown';
    const retry = r.facts['retry']?.status;
    if (retry && retry !== 'started' && !primary)
        return retry === 'already_done' ? 'succeeded' : 'failed';
    return primary?.status ?? 'succeeded';
}
function errorOf(r, primary, operationId) {
    if (primary?.error && primary.status !== 'succeeded')
        return toError(primary.error, operationId);
    if (r.processingErrors[0])
        return toError(r.processingErrors[0], operationId);
    const blocked = r.facts['blocked'];
    if (blocked)
        return { code: 'POLICY_BLOCKED', message: `blocked: ${(blocked.reasons ?? []).join(', ')}`, retryable: false, operationId, stage: 'harness.policy' };
    return null;
}
function toError(e, operationId) {
    return { code: e.provisionalCode, message: e.message, retryable: e.nextAction === 'bounded_read_retry', operationId, stage: e.stage };
}
