import { deliveredQuestionMatches } from '@deskpet/contracts';
import { NoopPersistence, StoreStorageError } from './persistence.js';
import { SqlitePersistence } from './SqlitePersistence.js';
export const DEFAULT_RETENTION = {
    compactTerminalOps: true,
    dedupRetentionMs: 7 * 24 * 3600_000,
    maxDedupRecords: 2_000,
    turnResultRetentionMs: 3600_000,
    maxTurnResults: 500,
    closedRecordRetentionMs: 24 * 3600_000,
    maintenanceIntervalMs: 5 * 60_000,
};
const clone = (v) => structuredClone(v);
const sizeOf = (v) => JSON.stringify(v).length;
/**
 * OperationStore. 판단 로직은 메모리에서 수행하고, 변경은 persistence에 저널로 남긴다 (persistence.ts).
 * - JS 단일 스레드에서 각 메서드의 동기 본문은 원자적이다. `await` 이전에 검사·변경·기록을 모두 끝낸다.
 * - 변경 메서드는 tx()로 감싼다: 끝날 때 바뀐 레코드만 한 트랜잭션으로 기록하고, 실패하면 메모리도 되돌린다.
 *   변경 알림(subscribe)은 기록이 성공한 뒤에만 보낸다.
 * - 영속 저장소: `InMemoryOperationStore.openDurable(path, opts)` → 기존 기록을 불러오고 재시작 복구를 수행한다.
 * - `simulateRestart()`는 테스트용으로 같은 객체에서 재시작 복구만 흉내 낸다.
 */
export class InMemoryOperationStore {
    o;
    ops = new Map();
    pendings = new Map();
    confirmations = new Map();
    dedup = new Map();
    dedupByConfirmation = new Map();
    turnResults = new Map();
    pipelineRevs = new Map();
    listeners = new Set();
    compacted = 0;
    persistence;
    /** 마지막으로 기록된 레코드 JSON (변경 비교·실패 시 되돌리기 기준) */
    persisted = new Map();
    queuedEvents = null;
    retention;
    lastMaintenanceMs = Number.NEGATIVE_INFINITY;
    /** 테스트 훅: 다음 persistMayHaveBeenSent를 저장 실패로 만든다 */
    failNextPersist = false;
    constructor(o) {
        this.o = o;
        this.persistence = o.persistence ?? new NoopPersistence();
        this.retention = { ...DEFAULT_RETENTION, ...o.retention };
        for (const r of this.persistence.loadAll()) {
            this.setRow(r.cat, r.key, JSON.parse(r.json));
            this.persisted.set(rowKey(r.cat, r.key), r.json);
        }
    }
    /**
     * SQLite 파일을 열어 기존 기록을 불러오고 재시작 복구를 수행한다.
     * ID 생성기는 재시작해도 겹치지 않아야 한다 (randomIdGen 등).
     */
    static openDurable(path, o) {
        const store = new InMemoryOperationStore({ ...o, persistence: new SqlitePersistence(path) });
        store.recoverAfterRestart();
        return store;
    }
    /** 영속 계층을 닫는다. 이후 이 객체를 쓰지 않는다 */
    close() {
        this.persistence.close();
    }
    // ================================================================ prepare
    async reserveAndPrepare(cmd) {
        // 예약 기록 실패는 실행 전 차단이다 (Liability: 예약·필수 저장 실패는 전송을 차단)
        return this.tx(() => this.prepareSync(cmd), (e) => ({ ok: false, reason: 'capacity_exhausted', detail: `storage error: ${e.message}` }));
    }
    prepareSync(cmd, opts = {}) {
        if (cmd.confirmationRef) {
            const conf = this.confirmations.get(cmd.confirmationRef);
            if (!conf) {
                const compactedOp = this.dedupByConfirmation.get(cmd.confirmationRef);
                return {
                    ok: false,
                    reason: 'confirmation_invalid',
                    detail: compactedOp ? 'confirmation already consumed and compacted' : 'confirmation not found',
                };
            }
            if (conf.operationId) {
                const existing = this.ops.get(conf.operationId);
                if (existing)
                    return { ok: false, reason: 'confirmation_already_linked', existing: clone(existing) };
                return { ok: false, reason: 'confirmation_invalid', detail: 'linked operation compacted' };
            }
            if (!opts.skipConfirmationStateCheck && conf.state !== 'approved') {
                return { ok: false, reason: 'confirmation_invalid', detail: `confirmation state ${conf.state}` };
            }
        }
        const budget = cmd.isWrite ? this.o.recoveryBudgetBytes : 0;
        const now = this.o.clock.nowIso();
        const operationId = this.o.ids.next('op');
        const attemptId = this.o.ids.next('att');
        if (this.ops.has(operationId) || this.dedup.has(operationId)) {
            throw new Error(`operation id collision (${operationId}): use an IdGen that does not repeat across restarts`);
        }
        const op = {
            owner: cmd.owner,
            operationId,
            revision: 1,
            requestId: cmd.requestId,
            action: cmd.action,
            target: clone(cmd.target),
            ...(cmd.confirmationRef ? { confirmationRef: cmd.confirmationRef } : {}),
            currentExecutionAuthority: { holderId: cmd.holderId, attemptId, ownerRevision: 1, kind: cmd.isWrite ? 'write' : 'read' },
            attempts: [{ attemptId, dispatchState: 'not_sent', notSentProof: 'prepared_not_dispatched', startedAt: now }],
            executionPhase: 'prepared',
            assessment: 'pending',
            recovery: 'none',
            recoveryAttempts: 0,
            expectedOutcome: clone(cmd.expectedOutcome),
            checkRuleVersion: cmd.checkRuleVersion,
            actualRequest: clone(cmd.actualRequest),
            priorEvidence: clone(cmd.priorEvidence),
            reservedRecoveryBytes: budget,
            createdAt: now,
            updatedAt: now,
            lastMeaningfulAccessAt: now,
        };
        const needed = sizeOf(op) + budget;
        if (!this.ensureCapacity(needed)) {
            return { ok: false, reason: 'capacity_exhausted', detail: `need ${needed} bytes; new writes blocked` };
        }
        this.ops.set(operationId, op);
        if (cmd.confirmationRef) {
            const conf = this.confirmations.get(cmd.confirmationRef);
            conf.operationId = operationId;
            conf.revision += 1;
            this.emitConfirmation(conf);
        }
        this.emitOp(op);
        return { ok: true, operation: clone(op), authority: clone(op.currentExecutionAuthority) };
    }
    // ======================================================= dispatch boundary
    async persistMayHaveBeenSent(auth) {
        // 디스크 기록이 끝난 뒤에만 ack를 돌려준다. 기록 실패면 ack 없음 → Gateway는 전송하지 않는다
        return this.tx(() => this.persistMayHaveBeenSentSync(auth), (e) => ({ ok: false, reason: 'storage_error', detail: e.message }));
    }
    persistMayHaveBeenSentSync(auth) {
        const op = this.ops.get(auth.operationId);
        if (!op)
            return { ok: false, reason: 'not_found', detail: auth.operationId };
        const cur = op.currentExecutionAuthority;
        if (!cur)
            return { ok: false, reason: 'authority_revoked', detail: 'no current execution authority' };
        if (cur.holderId !== auth.holderId || cur.attemptId !== auth.attemptId || cur.ownerRevision !== auth.ownerRevision) {
            return { ok: false, reason: 'stale_authority', detail: 'authority mismatch' };
        }
        if (this.failNextPersist) {
            this.failNextPersist = false;
            return { ok: false, reason: 'storage_error', detail: 'simulated storage failure' };
        }
        const att = op.attempts.find((a) => a.attemptId === auth.attemptId);
        const now = this.o.clock.nowIso();
        att.dispatchState = 'may_have_been_sent';
        delete att.notSentProof;
        att.dispatchEvidence = { ...(att.dispatchEvidence ?? { preparedAt: att.startedAt }), mayHaveBeenSentAt: now };
        op.executionPhase = 'dispatching';
        this.touch(op, now);
        return {
            ok: true,
            ack: { kind: 'may_have_been_sent', operationId: op.operationId, attemptId: att.attemptId, ownerRevision: cur.ownerRevision, persistedAt: now },
        };
    }
    async appendEvidence(operationId, ev) {
        return this.tx(() => {
            const op = this.mustOp(operationId);
            const att = op.attempts.find((a) => a.attemptId === ev.attemptId);
            if (!att)
                throw new Error(`attempt ${ev.attemptId} not found on ${operationId}`);
            if (ev.attemptDispatchState) {
                if (ev.attemptDispatchState === 'not_sent') {
                    // not_sent는 전송하지 않았다는 확실한 증거가 있을 때만 (message-contracts §Write 3)
                    if (!ev.notSentProof)
                        throw new Error('not_sent requires proof');
                    att.notSentProof = ev.notSentProof;
                }
                if (att.dispatchState === 'sent' && ev.attemptDispatchState !== 'sent') {
                    throw new Error('cannot downgrade sent attempt');
                }
                att.dispatchState = ev.attemptDispatchState;
                if (ev.attemptDispatchState === 'sent') {
                    att.dispatchEvidence = { ...(att.dispatchEvidence ?? { preparedAt: att.startedAt }), sentAt: this.o.clock.nowIso() };
                }
            }
            if (ev.responseEvidence)
                att.responseEvidence = clone(ev.responseEvidence);
            if (ev.phase)
                op.executionPhase = ev.phase;
            if (ev.assessment)
                op.assessment = ev.assessment;
            if (ev.recovery)
                op.recovery = ev.recovery;
            if (ev.actionResult)
                op.actionResult = clone(ev.actionResult);
            if (ev.followUp)
                op.followUp = clone(ev.followUp);
            if (ev.evidenceNote)
                op.evidenceNote = clone(ev.evidenceNote);
            if (ev.releaseAuthority)
                delete op.currentExecutionAuthority;
            this.touch(op);
            return clone(op);
        });
    }
    async prepareRetryAttempt(operationId, expectedRevision, holderId) {
        return this.tx(() => {
            const op = this.ops.get(operationId);
            if (!op)
                return { ok: false, reason: 'retry_not_allowed', detail: 'not found' };
            if (op.revision !== expectedRevision)
                return { ok: false, reason: 'retry_not_allowed', detail: 'stale revision' };
            const last = op.attempts[op.attempts.length - 1];
            if (last.dispatchState !== 'not_sent' || !last.notSentProof || last.notSentProof === 'prepared_not_dispatched') {
                return { ok: false, reason: 'retry_not_allowed', detail: 'last attempt not proven not_sent' };
            }
            if (op.attempts.length >= 2)
                return { ok: false, reason: 'retry_not_allowed', detail: 'retry limit (1) reached' };
            if (op.currentExecutionAuthority)
                return { ok: false, reason: 'retry_not_allowed', detail: 'authority still held' };
            const now = this.o.clock.nowIso();
            const attemptId = this.o.ids.next('att');
            op.attempts.push({ attemptId, dispatchState: 'not_sent', notSentProof: 'prepared_not_dispatched', startedAt: now });
            op.executionPhase = 'prepared';
            op.assessment = 'pending';
            delete op.actionResult;
            op.revision += 1;
            op.currentExecutionAuthority = { holderId, attemptId, ownerRevision: op.revision, kind: 'write' };
            this.touch(op, now, false);
            return { ok: true, operation: clone(op), authority: clone(op.currentExecutionAuthority) };
        });
    }
    async revokeBeforeDispatch(operationId, reason) {
        return this.tx(() => {
            const op = this.ops.get(operationId);
            if (!op)
                return { revoked: false };
            const last = op.attempts[op.attempts.length - 1];
            if (!op.currentExecutionAuthority || last.dispatchState !== 'not_sent')
                return { revoked: false, operation: clone(op) };
            delete op.currentExecutionAuthority;
            last.notSentProof = `revoked_before_dispatch:${reason}`;
            op.executionPhase = 'stopped';
            op.assessment = 'assessed';
            op.actionResult = this.result(op, 'cancelled', 'not_sent', {
                stage: 'dispatch',
                provisionalCode: 'CANCELLED',
                message: reason,
                operationId: op.operationId,
                nextAction: 'none',
            });
            this.touch(op);
            return { revoked: true, operation: clone(op) };
        });
    }
    // ================================================================ recovery
    async claimSingleRecovery(operationId, expectedRevision, holderId) {
        return this.tx(() => {
            const op = this.ops.get(operationId);
            if (!op || op.revision !== expectedRevision)
                return null;
            if (op.recovery !== 'needed' || op.currentExecutionAuthority)
                return null;
            op.recovery = 'running';
            op.revision += 1;
            const last = op.attempts[op.attempts.length - 1];
            op.currentExecutionAuthority = { holderId, attemptId: last.attemptId, ownerRevision: op.revision, kind: 'read_recovery_only' };
            this.touch(op, undefined, false);
            return clone(op.currentExecutionAuthority);
        });
    }
    async releaseRecovery(operationId, holderId, outcome) {
        return this.tx(() => {
            const op = this.mustOp(operationId);
            if (op.currentExecutionAuthority?.holderId !== holderId || op.currentExecutionAuthority.kind !== 'read_recovery_only') {
                throw new Error('recovery authority not held');
            }
            delete op.currentExecutionAuthority;
            if (outcome === 'resolved') {
                op.recovery = 'none';
            }
            else {
                op.recoveryAttempts += 1;
                op.recovery = op.recoveryAttempts >= this.o.maxRecoveryAttempts ? 'blocked' : 'needed';
            }
            this.touch(op);
            return clone(op);
        });
    }
    async readRecoveryRecord(operationId) {
        const op = this.ops.get(operationId);
        return op ? clone(op) : undefined;
    }
    async listRecoverable() {
        return [...this.ops.values()].filter((o) => o.recovery === 'needed').map(clone);
    }
    // ======================================================= pending/confirm
    async createPending(pending, confirmation) {
        return this.tx(() => {
            if (!this.ensureCapacity(sizeOf(pending) + (confirmation ? sizeOf(confirmation) : 0))) {
                throw new Error('capacity exhausted: cannot record pending');
            }
            this.pendings.set(pending.pendingId, clone(pending));
            this.emitPending(pending);
            if (confirmation) {
                this.confirmations.set(confirmation.confirmationId, clone(confirmation));
                this.emitConfirmation(confirmation);
            }
        });
    }
    async getPending(id) {
        const p = this.pendings.get(id);
        return p ? clone(p) : undefined;
    }
    async getConfirmation(id) {
        const c = this.confirmations.get(id);
        return c ? clone(c) : undefined;
    }
    async listWaitingPendingsByConversation(conversationId) {
        return [...this.pendings.values()].filter((p) => p.conversationId === conversationId && p.state === 'waiting').map(clone);
    }
    async getConfirmationForPending(pendingId) {
        const c = this.confirmationForPending(pendingId);
        return c ? clone(c) : undefined;
    }
    async listWaitingPendings(requestId) {
        return [...this.pendings.values()].filter((p) => p.requestId === requestId && p.state === 'waiting').map(clone);
    }
    async markQuestionDelivered(pendingId, outputId, ev) {
        return this.tx(() => {
            const p = this.pendings.get(pendingId);
            if (!p || p.state !== 'waiting' || p.outputId !== outputId)
                return undefined;
            if (p.questionDeliveryEvidence)
                return clone(p); // 중복 이벤트
            p.questionDeliveryEvidence = clone(ev);
            p.revision += 1;
            this.emitPending(p);
            const conf = this.confirmationForPending(pendingId);
            if (conf && conf.state === 'waiting') {
                conf.deliveredContentAndChannelEvidence = clone(ev);
                conf.revision += 1;
                this.emitConfirmation(conf);
            }
            return clone(p);
        });
    }
    async markSpeechStarted(pendingId, atIso) {
        return this.tx(() => {
            const p = this.pendings.get(pendingId);
            if (!p || p.state !== 'waiting')
                return undefined;
            // 무응답 타이머만 멈춘다. expiresAt은 연장하지 않는다.
            p.speechStartedAt = atIso;
            p.revision += 1;
            this.emitPending(p);
            return clone(p);
        });
    }
    async closePending(pendingId, to, reason) {
        return this.tx(() => {
            const p = this.pendings.get(pendingId);
            if (!p)
                return undefined;
            if (p.state !== 'waiting')
                return clone(p);
            p.state = to;
            p.closedReason = reason;
            p.revision += 1;
            this.emitPending(p);
            const conf = this.confirmationForPending(pendingId);
            if (conf && conf.state === 'waiting' && to !== 'consumed') {
                conf.state = to;
                conf.revision += 1;
                this.emitConfirmation(conf);
            }
            return clone(p);
        });
    }
    async atomicCommitAnswerAndClaim(cmd) {
        return this.tx(() => {
            const p = this.pendings.get(cmd.pendingId);
            if (!p)
                return { ok: false, reason: 'not_found' };
            if (p.requestId !== cmd.requestId || p.conversationId !== cmd.conversationId) {
                return { ok: false, reason: 'mismatch', pending: clone(p) };
            }
            if (p.state !== 'waiting')
                return { ok: false, reason: 'not_waiting', pending: clone(p) };
            if (p.revision !== cmd.expectedPendingRevision)
                return { ok: false, reason: 'stale_revision', pending: clone(p) };
            if (!p.questionDeliveryEvidence)
                return { ok: false, reason: 'question_not_delivered', pending: clone(p) };
            if (cmd.answeredAtMs > Date.parse(p.expiresAt)) {
                // 만료는 같은 직렬화 경계에서 확정한다
                p.state = 'expired';
                p.closedReason = 'answer_after_expiry';
                p.revision += 1;
                this.emitPending(p);
                const c = this.confirmationForPending(p.pendingId);
                if (c && c.state === 'waiting') {
                    c.state = 'expired';
                    c.revision += 1;
                    this.emitConfirmation(c);
                }
                return { ok: false, reason: 'expired', pending: clone(p) };
            }
            // 저장 경계에서도 다시 확인한다: 범위와 다른 문장으로 전달된 확인 질문의 답은 받지 않는다 (감사 F-01)
            if (p.kind === 'confirmation' && p.scope && !deliveredQuestionMatches(p.scope, p.questionDeliveryEvidence.deliveredText)) {
                return { ok: false, reason: 'question_not_delivered', pending: clone(p) };
            }
            const d = cmd.decision;
            if (d.kind === 'clarification_answer') {
                if (p.kind !== 'clarification')
                    return { ok: false, reason: 'mismatch', pending: clone(p) };
                this.consume(p, 'answered');
                return { ok: true, pending: clone(p) };
            }
            if (p.kind !== 'confirmation')
                return { ok: false, reason: 'mismatch', pending: clone(p) };
            const conf = this.confirmations.get(d.confirmationId);
            if (!conf)
                return { ok: false, reason: 'confirmation_not_found', pending: clone(p) };
            if (conf.pendingId !== p.pendingId)
                return { ok: false, reason: 'mismatch', pending: clone(p), confirmation: clone(conf) };
            if (conf.state !== 'waiting')
                return { ok: false, reason: 'not_waiting', pending: clone(p), confirmation: clone(conf) };
            let prepared;
            if (d.verdict === 'approved' && d.prepare) {
                // 판정 전에 공간 예약을 검사해 all-or-nothing을 보장한다
                const probe = sizeOf(d.prepare) * 2 + (d.prepare.isWrite ? this.o.recoveryBudgetBytes : 0);
                if (!this.ensureCapacity(probe)) {
                    return { ok: false, reason: 'capacity_exhausted', pending: clone(p), confirmation: clone(conf) };
                }
            }
            conf.answerTurnId = cmd.answerTurnId;
            conf.currentInputAndConfidenceEvidence = clone(d.evidence);
            conf.answerAndRationale = { rawText: d.rawText, rationale: d.rationale };
            conf.verdict = d.verdict;
            conf.state = d.verdict === 'approved' ? 'approved' : d.verdict === 'rejected' ? 'rejected' : 'revoked';
            conf.revision += 1;
            this.emitConfirmation(conf);
            this.consume(p, `confirmation_${d.verdict}`);
            if (d.verdict === 'approved' && d.prepare) {
                prepared = this.prepareSync({ ...d.prepare, confirmationRef: conf.confirmationId });
            }
            return { ok: true, pending: clone(p), confirmation: clone(this.confirmations.get(conf.confirmationId)), ...(prepared ? { prepared } : {}) };
        });
    }
    // ================================================================= query
    async getOperation(id) {
        const op = this.ops.get(id);
        return op ? clone(op) : undefined;
    }
    async findOperationByConfirmation(confirmationId) {
        const c = this.confirmations.get(confirmationId);
        if (!c?.operationId)
            return undefined;
        return this.getOperation(c.operationId);
    }
    async readProjectionSnapshot() {
        // 동기 본문 안에서 세 맵을 함께 읽으므로 같은 시점의 상태다
        return { operations: [...this.ops.values()].map(clone), pendings: [...this.pendings.values()].map(clone), confirmations: [...this.confirmations.values()].map(clone) };
    }
    async listOperations(requestId) {
        return [...this.ops.values()].filter((o) => !requestId || o.requestId === requestId).map(clone);
    }
    async getDedupRecord(id) {
        const d = this.dedup.get(id);
        return d ? clone(d) : undefined;
    }
    async getTurnResult(turnId) {
        const r = this.turnResults.get(turnId);
        return r ? clone(r.result) : undefined;
    }
    async recordTurnResult(turnId, result) {
        return this.tx(() => {
            this.turnResults.set(turnId, { recordedAtMs: this.o.clock.nowMs(), result: clone(result) });
        });
    }
    async getLastPipelineRevision(requestId) {
        return this.pipelineRevs.get(requestId);
    }
    async setLastPipelineRevision(requestId, revision) {
        return this.tx(() => {
            this.pipelineRevs.set(requestId, revision);
        });
    }
    // ============================================================ retention
    async protectByStateAndReferences() {
        return this.protectedIds();
    }
    async evictEligibleLRU(neededBytes) {
        return this.tx(() => {
            return this.evictSync(neededBytes);
        });
    }
    async compactEligibleRecord(operationId) {
        return this.tx(() => {
            if (this.protectedIds().has(operationId))
                return false;
            return this.compact(operationId) > 0;
        });
    }
    async usage() {
        const prot = this.protectedIds();
        return {
            usedBytes: this.usedBytes(),
            reservedBytes: this.reservedBytes(prot),
            capacityBytes: this.o.capacityBytes,
            protectedCount: prot.size,
            compactedCount: this.compacted,
        };
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    // ======================================================= restart (test)
    /**
     * 재시작 복구. 실행자는 모두 사라졌다고 본다(같은 프로세스).
     * may_have_been_sent는 전송 여부가 확인되지 않는 한 unknown으로 복구하고 재전송하지 않는다.
     */
    simulateRestart() {
        this.recoverAfterRestart();
    }
    /**
     * 재시작 복구: 이전 프로세스의 실행 권한은 모두 사라졌다고 보고 정리한 뒤 기록한다.
     * openDurable이 시작 시 호출한다.
     */
    recoverAfterRestart() {
        this.tx(() => this.recoverSync());
    }
    recoverSync() {
        for (const op of this.ops.values()) {
            const hadAuthority = !!op.currentExecutionAuthority;
            delete op.currentExecutionAuthority;
            const last = op.attempts[op.attempts.length - 1];
            if (op.recovery === 'running')
                op.recovery = 'needed';
            if (op.actionResult && op.assessment === 'assessed') {
                if (hadAuthority)
                    this.touch(op);
                continue;
            }
            if (last.dispatchState === 'may_have_been_sent' || last.dispatchState === 'sent') {
                if (op.executionPhase === 'response_received' && last.responseEvidence) {
                    // 응답 증거는 있으나 센서 판정 전 → 판정 대기 유지, 재검사 필요
                    op.assessment = 'pending';
                    op.recovery = 'needed';
                }
                else {
                    op.executionPhase = 'stopped';
                    op.assessment = 'assessed';
                    op.recovery = 'needed';
                    op.actionResult = this.result(op, 'unknown', last.dispatchState, {
                        stage: 'restart_recovery',
                        provisionalCode: op.target.kind === 'github_pr' ? 'GITHUB_RESULT_UNKNOWN' : 'EUREKA_TIMEOUT_RESULT_UNKNOWN',
                        message: 'process restarted after durable may_have_been_sent; dispatch not confirmed',
                        operationId: op.operationId,
                        attemptId: last.attemptId,
                        nextAction: 'reconcile',
                    });
                }
            }
            else {
                // ack 이전이므로 전송하지 않았다 (Gateway는 ack 없이 전송하지 않는다)
                last.notSentProof = last.notSentProof ?? 'restart_before_durable_ack';
                op.executionPhase = 'stopped';
                op.assessment = 'assessed';
                op.actionResult = this.result(op, 'failed', 'not_sent', {
                    stage: 'restart_recovery',
                    provisionalCode: 'INTERNAL',
                    message: 'process restarted before dispatch',
                    operationId: op.operationId,
                    attemptId: last.attemptId,
                    nextAction: 'none',
                });
            }
            this.touch(op);
        }
    }
    // ============================================================== helpers
    consume(p, reason) {
        p.state = 'consumed';
        p.closedReason = reason;
        p.revision += 1;
        this.emitPending(p);
    }
    confirmationForPending(pendingId) {
        for (const c of this.confirmations.values())
            if (c.pendingId === pendingId)
                return c;
        return undefined;
    }
    result(op, status, dispatchState, error) {
        return {
            operationId: op.operationId,
            action: op.action,
            target: clone(op.target),
            status,
            dispatchState,
            facts: {},
            externalRefs: [],
            observedAt: this.o.clock.nowIso(),
            ...(error ? { error } : {}),
        };
    }
    mustOp(id) {
        const op = this.ops.get(id);
        if (!op)
            throw new Error(`operation ${id} not found`);
        return op;
    }
    touch(op, now = this.o.clock.nowIso(), bump = true) {
        if (bump)
            op.revision += 1;
        op.updatedAt = now;
        op.lastMeaningfulAccessAt = now;
        this.emitOp(op);
    }
    isTerminal(op) {
        return (!op.currentExecutionAuthority &&
            (op.executionPhase === 'stopped' || op.executionPhase === 'response_received') &&
            op.assessment === 'assessed' &&
            op.recovery === 'none' &&
            !!op.actionResult &&
            op.actionResult.status !== 'unknown');
    }
    protectedIds() {
        const now = this.o.clock.nowMs();
        const out = new Set();
        const referenced = new Set();
        for (const op of this.ops.values()) {
            if (!this.isTerminal(op)) {
                const ref = op.actualRequest['approvalOperationId'];
                if (typeof ref === 'string')
                    referenced.add(ref);
            }
        }
        for (const c of this.confirmations.values()) {
            if (c.operationId && (c.state === 'waiting' || c.state === 'approved')) {
                const op = this.ops.get(c.operationId);
                if (op && !this.isTerminal(op))
                    referenced.add(c.operationId);
            }
        }
        for (const op of this.ops.values()) {
            const young = now - Date.parse(op.updatedAt) < this.o.minRetentionMs;
            if (!this.isTerminal(op) || referenced.has(op.operationId) || young)
                out.add(op.operationId);
        }
        return out;
    }
    usedBytes() {
        let n = 0;
        for (const v of this.ops.values())
            n += sizeOf(v);
        for (const v of this.pendings.values())
            n += sizeOf(v);
        for (const v of this.confirmations.values())
            n += sizeOf(v);
        for (const v of this.dedup.values())
            n += sizeOf(v);
        return n;
    }
    reservedBytes(prot) {
        let n = 0;
        for (const op of this.ops.values())
            if (prot.has(op.operationId) && !this.isTerminal(op))
                n += op.reservedRecoveryBytes;
        return n;
    }
    ensureCapacity(needed) {
        const free = () => this.o.capacityBytes - this.usedBytes() - this.reservedBytes(this.protectedIds());
        if (free() >= needed)
            return true;
        this.evictSync(needed - free());
        return free() >= needed;
    }
    evictSync(neededBytes) {
        const prot = this.protectedIds();
        const eligible = [...this.ops.values()]
            .filter((o) => !prot.has(o.operationId))
            .sort((a, b) => Date.parse(a.lastMeaningfulAccessAt) - Date.parse(b.lastMeaningfulAccessAt));
        let freed = 0;
        for (const op of eligible) {
            if (freed >= neededBytes)
                break;
            freed += this.compact(op.operationId);
        }
        return freed;
    }
    /** 종료·참조 해제된 기록을 최소 중복 방지 기록으로 축약한다. 반환: 해제한 바이트 */
    compact(operationId) {
        const op = this.ops.get(operationId);
        if (!op || !op.actionResult)
            return 0;
        const before = this.usedBytes();
        const sha = op.target.kind === 'github_pr' ? op.expectedOutcome.expectedVersion?.headSha : undefined;
        const rec = {
            operationId,
            ...(op.confirmationRef ? { confirmationId: op.confirmationRef } : {}),
            target: op.target,
            action: op.action,
            ...(sha ? { shaOrChangeScope: sha } : {}),
            result: op.actionResult.status,
            externalIds: op.actionResult.externalRefs.map((r) => `${r.system}:${r.kind}:${r.id}`),
            keyTimestamps: { createdAt: op.createdAt, completedAt: op.updatedAt },
        };
        this.ops.delete(operationId);
        this.dedup.set(operationId, rec);
        if (op.confirmationRef) {
            this.confirmations.delete(op.confirmationRef);
            this.dedupByConfirmation.set(op.confirmationRef, operationId);
        }
        this.compacted += 1;
        this.emit({ entityType: 'operation', entityId: operationId, revision: op.revision + 1, state: {}, deleted: true });
        return Math.max(0, before - this.usedBytes());
    }
    emitOp(op) {
        this.emit({ entityType: 'operation', entityId: op.operationId, revision: op.revision, state: clone(op) });
    }
    emitPending(p) {
        this.emit({ entityType: 'pending', entityId: p.pendingId, revision: p.revision, state: clone(p) });
    }
    emitConfirmation(c) {
        this.emit({ entityType: 'confirmation', entityId: c.confirmationId, revision: c.revision, state: clone(c) });
    }
    emit(c) {
        if (this.queuedEvents)
            this.queuedEvents.push(c);
        else
            for (const l of this.listeners)
                l(c);
    }
    // ============================================================ retention
    /** 보존 정책에 따라 정리한다. 반환: 지운·축약한 레코드 수 */
    async maintain() {
        return this.tx(() => {
            this.lastMaintenanceMs = this.o.clock.nowMs();
            return this.maintainSync();
        });
    }
    maintainSync() {
        const r = this.retention;
        const now = this.o.clock.nowMs();
        let n = 0;
        // 1) 종료·참조 해제·보존 기간이 지난 operation → 최소 중복 방지 기록
        if (r.compactTerminalOps) {
            const prot = this.protectedIds();
            for (const id of [...this.ops.keys()])
                if (!prot.has(id) && this.compact(id) > 0)
                    n += 1;
        }
        // 2) 오래된 최소 중복 방지 기록 (기간 초과 또는 개수 초과분, 오래된 것부터)
        const dedups = [...this.dedup.values()].sort((a, b) => Date.parse(a.keyTimestamps.completedAt ?? a.keyTimestamps.createdAt ?? '') - Date.parse(b.keyTimestamps.completedAt ?? b.keyTimestamps.createdAt ?? ''));
        dedups.forEach((d, i) => {
            const at = Date.parse(d.keyTimestamps.completedAt ?? d.keyTimestamps.createdAt ?? '') || 0;
            if (now - at > r.dedupRetentionMs || dedups.length - i > r.maxDedupRecords) {
                this.dedup.delete(d.operationId);
                if (d.confirmationId)
                    this.dedupByConfirmation.delete(d.confirmationId);
                n += 1;
            }
        });
        // 3) 턴 결과
        const turns = [...this.turnResults.entries()].sort((a, b) => a[1].recordedAtMs - b[1].recordedAtMs);
        turns.forEach(([k, t], i) => {
            if (now - t.recordedAtMs > r.turnResultRetentionMs || turns.length - i > r.maxTurnResults) {
                this.turnResults.delete(k);
                n += 1;
            }
        });
        // 4) 닫힌(또는 오래전에 만료된) confirmation·pending. 살아 있는 operation이 참조하면 남긴다
        const expiredLongAgo = (iso) => now - Date.parse(iso) > r.closedRecordRetentionMs;
        for (const c of [...this.confirmations.values()]) {
            if (c.operationId && this.ops.has(c.operationId))
                continue;
            if ((c.state !== 'waiting' && c.state !== 'approved') || expiredLongAgo(c.expiresAt)) {
                if (expiredLongAgo(c.expiresAt)) {
                    this.confirmations.delete(c.confirmationId);
                    this.emit({ entityType: 'confirmation', entityId: c.confirmationId, revision: c.revision + 1, state: {}, deleted: true });
                    n += 1;
                }
            }
        }
        for (const p of [...this.pendings.values()]) {
            if (!expiredLongAgo(p.expiresAt))
                continue;
            const conf = this.confirmationForPending(p.pendingId);
            if (conf?.operationId && this.ops.has(conf.operationId))
                continue;
            this.pendings.delete(p.pendingId);
            this.emit({ entityType: 'pending', entityId: p.pendingId, revision: p.revision + 1, state: {}, deleted: true });
            n += 1;
        }
        // 5) 남은 pending·operation이 없는 요청의 파이프라인 순서
        const live = new Set([...[...this.pendings.values()].map((p) => p.requestId), ...[...this.ops.values()].map((o) => o.requestId)]);
        for (const k of [...this.pipelineRevs.keys()]) {
            if (!live.has(k)) {
                this.pipelineRevs.delete(k);
                n += 1;
            }
        }
        return n;
    }
    // ============================================================ journal
    /**
     * 변경 트랜잭션. fn의 동기 본문이 끝나면 바뀐 레코드를 한 번에 기록한다.
     * fn이 던지거나 기록이 실패하면 메모리를 마지막 기록 상태로 되돌리고 알림을 버린다.
     * 중첩 호출(예: 답변 커밋 안의 prepare)은 바깥 트랜잭션에 합쳐진다.
     */
    tx(fn, onStorageError) {
        if (this.queuedEvents)
            return fn();
        this.queuedEvents = [];
        try {
            let result;
            try {
                result = fn();
                const now = this.o.clock.nowMs();
                if (now - this.lastMaintenanceMs >= this.retention.maintenanceIntervalMs) {
                    this.maintainSync();
                    this.lastMaintenanceMs = now;
                }
            }
            catch (e) {
                this.rollback();
                throw e;
            }
            const { upserts, deletes } = this.diff();
            if (upserts.length || deletes.length) {
                try {
                    this.persistence.commit(upserts, deletes);
                }
                catch (e) {
                    this.rollback();
                    const err = new StoreStorageError(e instanceof Error ? e.message : String(e));
                    if (onStorageError) {
                        this.queuedEvents = [];
                        return onStorageError(err);
                    }
                    throw err;
                }
                for (const r of upserts)
                    this.persisted.set(rowKey(r.cat, r.key), r.json);
                for (const d of deletes)
                    this.persisted.delete(rowKey(d.cat, d.key));
            }
            const events = this.queuedEvents;
            this.queuedEvents = null;
            for (const c of events)
                for (const l of this.listeners)
                    l(c);
            return result;
        }
        finally {
            this.queuedEvents = null;
        }
    }
    *rows() {
        for (const [k, v] of this.ops)
            yield ['op', k, v];
        for (const [k, v] of this.pendings)
            yield ['pending', k, v];
        for (const [k, v] of this.confirmations)
            yield ['conf', k, v];
        for (const [k, v] of this.dedup)
            yield ['dedup', k, v];
        for (const [k, v] of this.dedupByConfirmation)
            yield ['dedupConf', k, v];
        for (const [k, v] of this.turnResults)
            yield ['turn', k, v];
        for (const [k, v] of this.pipelineRevs)
            yield ['pipe', k, v];
        yield ['meta', 'compacted', this.compacted];
    }
    diff() {
        const upserts = [];
        const seen = new Set();
        for (const [cat, key, v] of this.rows()) {
            const rk = rowKey(cat, key);
            seen.add(rk);
            const json = JSON.stringify(v);
            if (this.persisted.get(rk) !== json)
                upserts.push({ cat, key, json });
        }
        const deletes = [];
        for (const rk of this.persisted.keys())
            if (!seen.has(rk))
                deletes.push(splitRowKey(rk));
        return { upserts, deletes };
    }
    /** 마지막 기록 상태로 되돌린다 */
    rollback() {
        const { upserts, deletes } = this.diff();
        for (const r of upserts) {
            const prev = this.persisted.get(rowKey(r.cat, r.key));
            if (prev === undefined)
                this.deleteRow(r.cat, r.key);
            else
                this.setRow(r.cat, r.key, JSON.parse(prev));
        }
        for (const d of deletes)
            this.setRow(d.cat, d.key, JSON.parse(this.persisted.get(rowKey(d.cat, d.key))));
    }
    setRow(cat, key, v) {
        switch (cat) {
            case 'op':
                this.ops.set(key, v);
                break;
            case 'pending':
                this.pendings.set(key, v);
                break;
            case 'conf':
                this.confirmations.set(key, v);
                break;
            case 'dedup':
                this.dedup.set(key, v);
                break;
            case 'dedupConf':
                this.dedupByConfirmation.set(key, v);
                break;
            case 'turn': {
                // 이전 형식(HarnessResult만 저장)은 기록 시각을 모르므로 다음 정리 때 지운다
                const t = v;
                this.turnResults.set(key, typeof t.recordedAtMs === 'number' && t.result ? t : { recordedAtMs: 0, result: v });
                break;
            }
            case 'pipe':
                this.pipelineRevs.set(key, v);
                break;
            case 'meta':
                if (key === 'compacted')
                    this.compacted = v;
                break;
        }
    }
    deleteRow(cat, key) {
        switch (cat) {
            case 'op':
                this.ops.delete(key);
                break;
            case 'pending':
                this.pendings.delete(key);
                break;
            case 'conf':
                this.confirmations.delete(key);
                break;
            case 'dedup':
                this.dedup.delete(key);
                break;
            case 'dedupConf':
                this.dedupByConfirmation.delete(key);
                break;
            case 'turn':
                this.turnResults.delete(key);
                break;
            case 'pipe':
                this.pipelineRevs.delete(key);
                break;
            case 'meta': break;
        }
    }
}
const rowKey = (cat, key) => `${cat}\u0000${key}`;
const splitRowKey = (rk) => {
    const i = rk.indexOf('\u0000');
    return { cat: rk.slice(0, i), key: rk.slice(i + 1) };
};
