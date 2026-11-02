import type {
  ActionResult,
  ConfirmationRecord,
  ExecutionAuthority,
  HarnessResult,
  MinimumDedupRecord,
  OperationRecord,
  Pending,
  QuestionDeliveryEvidence,
} from '@deskpet/contracts';
import { deliveredQuestionMatches } from '@deskpet/contracts';
import type { Clock, IdGen } from '../runtime/clock.js';
import type {
  AckResult,
  AnswerCommand,
  AnswerResult,
  OperationEvidence,
  OperationStore,
  PrepareCommand,
  PrepareResult,
  StoreChange,
  StoreUsage,
} from './OperationStore.js';
import { NoopPersistence, StoreStorageError, type PersistedRow, type StoreCategory, type StorePersistence } from './persistence.js';
import { SqlitePersistence } from './SqlitePersistence.js';

export interface InMemoryStoreOptions {
  clock: Clock;
  ids: IdGen;
  capacityBytes: number;
  recoveryBudgetBytes: number;
  minRetentionMs: number;
  maxRecoveryAttempts: number;
  /** 영속 계층. 없으면 메모리 전용 */
  persistence?: StorePersistence;
  /** 보존 정책. 없으면 DEFAULT_RETENTION */
  retention?: Partial<RetentionPolicy>;
}

/**
 * 보존 정책 — 기록이 끝없이 쌓이지 않게 한다 (임베디드 저장 공간·플래시 수명).
 * 진행 중·결과 불명·판정 대기·복구 중·참조 중인 기록은 지우지 않는다 (message-contracts §Operation Record 삭제 보호).
 * 구체 수치는 실측 후 조정한다 (Liability Principles 6).
 */
export interface RetentionPolicy {
  /** 종료된 operation은 minRetentionMs가 지나면 최소 중복 방지 기록으로 축약한다 (용량 압박이 없어도) */
  compactTerminalOps: boolean;
  /** 최소 중복 방지 기록 보존 기간·최대 개수 (오래된 것부터 삭제) */
  dedupRetentionMs: number;
  maxDedupRecords: number;
  /** 턴 결과(같은 턴 재전달 응답용) 보존 기간·최대 개수 */
  turnResultRetentionMs: number;
  maxTurnResults: number;
  /** 닫힌 pending·confirmation 보존 기간 (만료 시각 기준) */
  closedRecordRetentionMs: number;
  /** 정리 주기. 변경 트랜잭션 안에서 이 간격마다 한 번 수행한다 */
  maintenanceIntervalMs: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  compactTerminalOps: true,
  dedupRetentionMs: 7 * 24 * 3600_000,
  maxDedupRecords: 2_000,
  turnResultRetentionMs: 3600_000,
  maxTurnResults: 500,
  closedRecordRetentionMs: 24 * 3600_000,
  maintenanceIntervalMs: 5 * 60_000,
};

interface TurnEntry {
  recordedAtMs: number;
  result: HarnessResult;
}

const clone = <T>(v: T): T => structuredClone(v);
const sizeOf = (v: unknown): number => JSON.stringify(v).length;

/**
 * OperationStore. 판단 로직은 메모리에서 수행하고, 변경은 persistence에 저널로 남긴다 (persistence.ts).
 * - JS 단일 스레드에서 각 메서드의 동기 본문은 원자적이다. `await` 이전에 검사·변경·기록을 모두 끝낸다.
 * - 변경 메서드는 tx()로 감싼다: 끝날 때 바뀐 레코드만 한 트랜잭션으로 기록하고, 실패하면 메모리도 되돌린다.
 *   변경 알림(subscribe)은 기록이 성공한 뒤에만 보낸다.
 * - 영속 저장소: `InMemoryOperationStore.openDurable(path, opts)` → 기존 기록을 불러오고 재시작 복구를 수행한다.
 * - `simulateRestart()`는 테스트용으로 같은 객체에서 재시작 복구만 흉내 낸다.
 */
export class InMemoryOperationStore implements OperationStore {
  private ops = new Map<string, OperationRecord>();
  private pendings = new Map<string, Pending>();
  private confirmations = new Map<string, ConfirmationRecord>();
  private dedup = new Map<string, MinimumDedupRecord>();
  private dedupByConfirmation = new Map<string, string>();
  private turnResults = new Map<string, TurnEntry>();
  private pipelineRevs = new Map<string, number>();
  private listeners = new Set<(c: StoreChange) => void>();
  private compacted = 0;
  private readonly persistence: StorePersistence;
  /** 마지막으로 기록된 레코드 JSON (변경 비교·실패 시 되돌리기 기준) */
  private readonly persisted = new Map<string, string>();
  private queuedEvents: StoreChange[] | null = null;
  private readonly retention: RetentionPolicy;
  private lastMaintenanceMs = Number.NEGATIVE_INFINITY;

  /** 테스트 훅: 다음 persistMayHaveBeenSent를 저장 실패로 만든다 */
  failNextPersist = false;

  constructor(private readonly o: InMemoryStoreOptions) {
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
  static openDurable(path: string, o: Omit<InMemoryStoreOptions, 'persistence'>): InMemoryOperationStore {
    const store = new InMemoryOperationStore({ ...o, persistence: new SqlitePersistence(path) });
    store.recoverAfterRestart();
    return store;
  }

  /** 영속 계층을 닫는다. 이후 이 객체를 쓰지 않는다 */
  close(): void {
    this.persistence.close();
  }

  // ================================================================ prepare
  async reserveAndPrepare(cmd: PrepareCommand): Promise<PrepareResult> {
    // 예약 기록 실패는 실행 전 차단이다 (Liability: 예약·필수 저장 실패는 전송을 차단)
    return this.tx(
      () => this.prepareSync(cmd),
      (e) => ({ ok: false, reason: 'capacity_exhausted', detail: `storage error: ${e.message}` }),
    );
  }

  private prepareSync(cmd: PrepareCommand, opts: { skipConfirmationStateCheck?: boolean } = {}): PrepareResult {
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
        if (existing) return { ok: false, reason: 'confirmation_already_linked', existing: clone(existing) };
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
    const op: OperationRecord = {
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
      const conf = this.confirmations.get(cmd.confirmationRef)!;
      conf.operationId = operationId;
      conf.revision += 1;
      this.emitConfirmation(conf);
    }
    this.emitOp(op);
    return { ok: true, operation: clone(op), authority: clone(op.currentExecutionAuthority!) };
  }

  // ======================================================= dispatch boundary
  async persistMayHaveBeenSent(auth: ExecutionAuthority & { operationId: string }): Promise<AckResult> {
    // 디스크 기록이 끝난 뒤에만 ack를 돌려준다. 기록 실패면 ack 없음 → Gateway는 전송하지 않는다
    return this.tx(
      () => this.persistMayHaveBeenSentSync(auth),
      (e) => ({ ok: false, reason: 'storage_error', detail: e.message }),
    );
  }

  private persistMayHaveBeenSentSync(auth: ExecutionAuthority & { operationId: string }): AckResult {
    const op = this.ops.get(auth.operationId);
    if (!op) return { ok: false, reason: 'not_found', detail: auth.operationId };
    const cur = op.currentExecutionAuthority;
    if (!cur) return { ok: false, reason: 'authority_revoked', detail: 'no current execution authority' };
    if (cur.holderId !== auth.holderId || cur.attemptId !== auth.attemptId || cur.ownerRevision !== auth.ownerRevision) {
      return { ok: false, reason: 'stale_authority', detail: 'authority mismatch' };
    }
    if (this.failNextPersist) {
      this.failNextPersist = false;
      return { ok: false, reason: 'storage_error', detail: 'simulated storage failure' };
    }
    const att = op.attempts.find((a) => a.attemptId === auth.attemptId)!;
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

  async appendEvidence(operationId: string, ev: OperationEvidence): Promise<OperationRecord> {
    return this.tx(() => {
      const op = this.mustOp(operationId);
      const att = op.attempts.find((a) => a.attemptId === ev.attemptId);
      if (!att) throw new Error(`attempt ${ev.attemptId} not found on ${operationId}`);
      if (ev.attemptDispatchState) {
        if (ev.attemptDispatchState === 'not_sent') {
          // not_sent는 전송하지 않았다는 확실한 증거가 있을 때만 (message-contracts §Write 3)
          if (!ev.notSentProof) throw new Error('not_sent requires proof');
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
      if (ev.responseEvidence) att.responseEvidence = clone(ev.responseEvidence);
      if (ev.phase) op.executionPhase = ev.phase;
      if (ev.assessment) op.assessment = ev.assessment;
      if (ev.recovery) op.recovery = ev.recovery;
      if (ev.actionResult) op.actionResult = clone(ev.actionResult);
      if (ev.followUp) op.followUp = clone(ev.followUp);
      if (ev.releaseAuthority) delete op.currentExecutionAuthority;
      this.touch(op);
      return clone(op);
    });
  }

  async prepareRetryAttempt(operationId: string, expectedRevision: number, holderId: string): Promise<PrepareResult> {
    return this.tx(() => {
      const op = this.ops.get(operationId);
      if (!op) return { ok: false, reason: 'retry_not_allowed', detail: 'not found' };
      if (op.revision !== expectedRevision) return { ok: false, reason: 'retry_not_allowed', detail: 'stale revision' };
      const last = op.attempts[op.attempts.length - 1]!;
      if (last.dispatchState !== 'not_sent' || !last.notSentProof || last.notSentProof === 'prepared_not_dispatched') {
        return { ok: false, reason: 'retry_not_allowed', detail: 'last attempt not proven not_sent' };
      }
      if (op.attempts.length >= 2) return { ok: false, reason: 'retry_not_allowed', detail: 'retry limit (1) reached' };
      if (op.currentExecutionAuthority) return { ok: false, reason: 'retry_not_allowed', detail: 'authority still held' };
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

  async revokeBeforeDispatch(operationId: string, reason: string): Promise<{ revoked: boolean; operation?: OperationRecord }> {
    return this.tx(() => {
      const op = this.ops.get(operationId);
      if (!op) return { revoked: false };
      const last = op.attempts[op.attempts.length - 1]!;
      if (!op.currentExecutionAuthority || last.dispatchState !== 'not_sent') return { revoked: false, operation: clone(op) };
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
  async claimSingleRecovery(operationId: string, expectedRevision: number, holderId: string): Promise<ExecutionAuthority | null> {
    return this.tx(() => {
      const op = this.ops.get(operationId);
      if (!op || op.revision !== expectedRevision) return null;
      if (op.recovery !== 'needed' || op.currentExecutionAuthority) return null;
      op.recovery = 'running';
      op.revision += 1;
      const last = op.attempts[op.attempts.length - 1]!;
      op.currentExecutionAuthority = { holderId, attemptId: last.attemptId, ownerRevision: op.revision, kind: 'read_recovery_only' };
      this.touch(op, undefined, false);
      return clone(op.currentExecutionAuthority);
    });
  }

  async releaseRecovery(operationId: string, holderId: string, outcome: 'resolved' | 'still_unknown'): Promise<OperationRecord> {
    return this.tx(() => {
      const op = this.mustOp(operationId);
      if (op.currentExecutionAuthority?.holderId !== holderId || op.currentExecutionAuthority.kind !== 'read_recovery_only') {
        throw new Error('recovery authority not held');
      }
      delete op.currentExecutionAuthority;
      if (outcome === 'resolved') {
        op.recovery = 'none';
      } else {
        op.recoveryAttempts += 1;
        op.recovery = op.recoveryAttempts >= this.o.maxRecoveryAttempts ? 'blocked' : 'needed';
      }
      this.touch(op);
      return clone(op);
    });
  }

  async readRecoveryRecord(operationId: string): Promise<OperationRecord | undefined> {
    const op = this.ops.get(operationId);
    return op ? clone(op) : undefined;
  }

  async listRecoverable(): Promise<OperationRecord[]> {
    return [...this.ops.values()].filter((o) => o.recovery === 'needed').map(clone);
  }

  // ======================================================= pending/confirm
  async createPending(pending: Pending, confirmation?: ConfirmationRecord): Promise<void> {
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

  async getPending(id: string) {
    const p = this.pendings.get(id);
    return p ? clone(p) : undefined;
  }

  async getConfirmation(id: string) {
    const c = this.confirmations.get(id);
    return c ? clone(c) : undefined;
  }

  async listWaitingPendingsByConversation(conversationId: string) {
    return [...this.pendings.values()].filter((p) => p.conversationId === conversationId && p.state === 'waiting').map(clone);
  }

  async getConfirmationForPending(pendingId: string) {
    const c = this.confirmationForPending(pendingId);
    return c ? clone(c) : undefined;
  }

  async listWaitingPendings(requestId: string) {
    return [...this.pendings.values()].filter((p) => p.requestId === requestId && p.state === 'waiting').map(clone);
  }

  async markQuestionDelivered(pendingId: string, outputId: string, ev: QuestionDeliveryEvidence) {
    return this.tx(() => {
      const p = this.pendings.get(pendingId);
      if (!p || p.state !== 'waiting' || p.outputId !== outputId) return undefined;
      if (p.questionDeliveryEvidence) return clone(p); // 중복 이벤트
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

  async markSpeechStarted(pendingId: string, atIso: string) {
    return this.tx(() => {
      const p = this.pendings.get(pendingId);
      if (!p || p.state !== 'waiting') return undefined;
      // 무응답 타이머만 멈춘다. expiresAt은 연장하지 않는다.
      p.speechStartedAt = atIso;
      p.revision += 1;
      this.emitPending(p);
      return clone(p);
    });
  }

  async closePending(pendingId: string, to: 'expired' | 'revoked' | 'consumed', reason: string) {
    return this.tx(() => {
      const p = this.pendings.get(pendingId);
      if (!p) return undefined;
      if (p.state !== 'waiting') return clone(p);
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

  async atomicCommitAnswerAndClaim(cmd: AnswerCommand): Promise<AnswerResult> {
    return this.tx(() => {
      const p = this.pendings.get(cmd.pendingId);
      if (!p) return { ok: false, reason: 'not_found' };
      if (p.requestId !== cmd.requestId || p.conversationId !== cmd.conversationId) {
        return { ok: false, reason: 'mismatch', pending: clone(p) };
      }
      if (p.state !== 'waiting') return { ok: false, reason: 'not_waiting', pending: clone(p) };
      if (p.revision !== cmd.expectedPendingRevision) return { ok: false, reason: 'stale_revision', pending: clone(p) };
      if (!p.questionDeliveryEvidence) return { ok: false, reason: 'question_not_delivered', pending: clone(p) };
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
        if (p.kind !== 'clarification') return { ok: false, reason: 'mismatch', pending: clone(p) };
        this.consume(p, 'answered');
        return { ok: true, pending: clone(p) };
      }

      if (p.kind !== 'confirmation') return { ok: false, reason: 'mismatch', pending: clone(p) };
      const conf = this.confirmations.get(d.confirmationId);
      if (!conf) return { ok: false, reason: 'confirmation_not_found', pending: clone(p) };
      if (conf.pendingId !== p.pendingId) return { ok: false, reason: 'mismatch', pending: clone(p), confirmation: clone(conf) };
      if (conf.state !== 'waiting') return { ok: false, reason: 'not_waiting', pending: clone(p), confirmation: clone(conf) };

      let prepared: PrepareResult | undefined;
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
      return { ok: true, pending: clone(p), confirmation: clone(this.confirmations.get(conf.confirmationId)!), ...(prepared ? { prepared } : {}) };
    });
  }

  // ================================================================= query
  async getOperation(id: string) {
    const op = this.ops.get(id);
    return op ? clone(op) : undefined;
  }
  async findOperationByConfirmation(confirmationId: string) {
    const c = this.confirmations.get(confirmationId);
    if (!c?.operationId) return undefined;
    return this.getOperation(c.operationId);
  }
  async readProjectionSnapshot() {
    // 동기 본문 안에서 세 맵을 함께 읽으므로 같은 시점의 상태다
    return { operations: [...this.ops.values()].map(clone), pendings: [...this.pendings.values()].map(clone), confirmations: [...this.confirmations.values()].map(clone) };
  }
  async listOperations(requestId?: string) {
    return [...this.ops.values()].filter((o) => !requestId || o.requestId === requestId).map(clone);
  }
  async getDedupRecord(id: string) {
    const d = this.dedup.get(id);
    return d ? clone(d) : undefined;
  }
  async getTurnResult(turnId: string) {
    const r = this.turnResults.get(turnId);
    return r ? clone(r.result) : undefined;
  }
  async recordTurnResult(turnId: string, result: HarnessResult) {
    return this.tx(() => {
      this.turnResults.set(turnId, { recordedAtMs: this.o.clock.nowMs(), result: clone(result) });
    });
  }
  async getLastPipelineRevision(requestId: string) {
    return this.pipelineRevs.get(requestId);
  }
  async setLastPipelineRevision(requestId: string, revision: number) {
    return this.tx(() => {
      this.pipelineRevs.set(requestId, revision);
    });
  }

  // ============================================================ retention
  async protectByStateAndReferences(): Promise<Set<string>> {
    return this.protectedIds();
  }

  async evictEligibleLRU(neededBytes: number): Promise<number> {
    return this.tx(() => {
      return this.evictSync(neededBytes);
    });
  }

  async compactEligibleRecord(operationId: string): Promise<boolean> {
    return this.tx(() => {
      if (this.protectedIds().has(operationId)) return false;
      return this.compact(operationId) > 0;
    });
  }

  async usage(): Promise<StoreUsage> {
    const prot = this.protectedIds();
    return {
      usedBytes: this.usedBytes(),
      reservedBytes: this.reservedBytes(prot),
      capacityBytes: this.o.capacityBytes,
      protectedCount: prot.size,
      compactedCount: this.compacted,
    };
  }

  subscribe(listener: (c: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ======================================================= restart (test)
  /**
   * 재시작 복구. 실행자는 모두 사라졌다고 본다(같은 프로세스).
   * may_have_been_sent는 전송 여부가 확인되지 않는 한 unknown으로 복구하고 재전송하지 않는다.
   */
  simulateRestart(): void {
    this.recoverAfterRestart();
  }

  /**
   * 재시작 복구: 이전 프로세스의 실행 권한은 모두 사라졌다고 보고 정리한 뒤 기록한다.
   * openDurable이 시작 시 호출한다.
   */
  recoverAfterRestart(): void {
    this.tx(() => this.recoverSync());
  }

  private recoverSync(): void {
    for (const op of this.ops.values()) {
      const hadAuthority = !!op.currentExecutionAuthority;
      delete op.currentExecutionAuthority;
      const last = op.attempts[op.attempts.length - 1]!;
      if (op.recovery === 'running') op.recovery = 'needed';
      if (op.actionResult && op.assessment === 'assessed') {
        if (hadAuthority) this.touch(op);
        continue;
      }
      if (last.dispatchState === 'may_have_been_sent' || last.dispatchState === 'sent') {
        if (op.executionPhase === 'response_received' && last.responseEvidence) {
          // 응답 증거는 있으나 센서 판정 전 → 판정 대기 유지, 재검사 필요
          op.assessment = 'pending';
          op.recovery = 'needed';
        } else {
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
      } else {
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
  private consume(p: Pending, reason: string) {
    p.state = 'consumed';
    p.closedReason = reason;
    p.revision += 1;
    this.emitPending(p);
  }

  private confirmationForPending(pendingId: string): ConfirmationRecord | undefined {
    for (const c of this.confirmations.values()) if (c.pendingId === pendingId) return c;
    return undefined;
  }

  private result(op: OperationRecord, status: ActionResult['status'], dispatchState: ActionResult['dispatchState'], error?: ActionResult['error']): ActionResult {
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

  private mustOp(id: string): OperationRecord {
    const op = this.ops.get(id);
    if (!op) throw new Error(`operation ${id} not found`);
    return op;
  }

  private touch(op: OperationRecord, now = this.o.clock.nowIso(), bump = true) {
    if (bump) op.revision += 1;
    op.updatedAt = now;
    op.lastMeaningfulAccessAt = now;
    this.emitOp(op);
  }

  private isTerminal(op: OperationRecord): boolean {
    return (
      !op.currentExecutionAuthority &&
      (op.executionPhase === 'stopped' || op.executionPhase === 'response_received') &&
      op.assessment === 'assessed' &&
      op.recovery === 'none' &&
      !!op.actionResult &&
      op.actionResult.status !== 'unknown'
    );
  }

  private protectedIds(): Set<string> {
    const now = this.o.clock.nowMs();
    const out = new Set<string>();
    const referenced = new Set<string>();
    for (const op of this.ops.values()) {
      if (!this.isTerminal(op)) {
        const ref = op.actualRequest['approvalOperationId'];
        if (typeof ref === 'string') referenced.add(ref);
      }
    }
    for (const c of this.confirmations.values()) {
      if (c.operationId && (c.state === 'waiting' || c.state === 'approved')) {
        const op = this.ops.get(c.operationId);
        if (op && !this.isTerminal(op)) referenced.add(c.operationId);
      }
    }
    for (const op of this.ops.values()) {
      const young = now - Date.parse(op.updatedAt) < this.o.minRetentionMs;
      if (!this.isTerminal(op) || referenced.has(op.operationId) || young) out.add(op.operationId);
    }
    return out;
  }

  private usedBytes(): number {
    let n = 0;
    for (const v of this.ops.values()) n += sizeOf(v);
    for (const v of this.pendings.values()) n += sizeOf(v);
    for (const v of this.confirmations.values()) n += sizeOf(v);
    for (const v of this.dedup.values()) n += sizeOf(v);
    return n;
  }

  private reservedBytes(prot: Set<string>): number {
    let n = 0;
    for (const op of this.ops.values()) if (prot.has(op.operationId) && !this.isTerminal(op)) n += op.reservedRecoveryBytes;
    return n;
  }

  private ensureCapacity(needed: number): boolean {
    const free = () => this.o.capacityBytes - this.usedBytes() - this.reservedBytes(this.protectedIds());
    if (free() >= needed) return true;
    this.evictSync(needed - free());
    return free() >= needed;
  }

  private evictSync(neededBytes: number): number {
    const prot = this.protectedIds();
    const eligible = [...this.ops.values()]
      .filter((o) => !prot.has(o.operationId))
      .sort((a, b) => Date.parse(a.lastMeaningfulAccessAt) - Date.parse(b.lastMeaningfulAccessAt));
    let freed = 0;
    for (const op of eligible) {
      if (freed >= neededBytes) break;
      freed += this.compact(op.operationId);
    }
    return freed;
  }

  /** 종료·참조 해제된 기록을 최소 중복 방지 기록으로 축약한다. 반환: 해제한 바이트 */
  private compact(operationId: string): number {
    const op = this.ops.get(operationId);
    if (!op || !op.actionResult) return 0;
    const before = this.usedBytes();
    const sha = op.target.kind === 'github_pr' ? op.expectedOutcome.expectedVersion?.headSha : undefined;
    const rec: MinimumDedupRecord = {
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

  private emitOp(op: OperationRecord) {
    this.emit({ entityType: 'operation', entityId: op.operationId, revision: op.revision, state: clone(op) as unknown as Record<string, unknown> });
  }
  private emitPending(p: Pending) {
    this.emit({ entityType: 'pending', entityId: p.pendingId, revision: p.revision, state: clone(p) as unknown as Record<string, unknown> });
  }
  private emitConfirmation(c: ConfirmationRecord) {
    this.emit({ entityType: 'confirmation', entityId: c.confirmationId, revision: c.revision, state: clone(c) as unknown as Record<string, unknown> });
  }
  private emit(c: StoreChange) {
    if (this.queuedEvents) this.queuedEvents.push(c);
    else for (const l of this.listeners) l(c);
  }

  // ============================================================ retention
  /** 보존 정책에 따라 정리한다. 반환: 지운·축약한 레코드 수 */
  async maintain(): Promise<number> {
    return this.tx(() => {
      this.lastMaintenanceMs = this.o.clock.nowMs();
      return this.maintainSync();
    });
  }

  private maintainSync(): number {
    const r = this.retention;
    const now = this.o.clock.nowMs();
    let n = 0;
    // 1) 종료·참조 해제·보존 기간이 지난 operation → 최소 중복 방지 기록
    if (r.compactTerminalOps) {
      const prot = this.protectedIds();
      for (const id of [...this.ops.keys()]) if (!prot.has(id) && this.compact(id) > 0) n += 1;
    }
    // 2) 오래된 최소 중복 방지 기록 (기간 초과 또는 개수 초과분, 오래된 것부터)
    const dedups = [...this.dedup.values()].sort((a, b) => Date.parse(a.keyTimestamps.completedAt ?? a.keyTimestamps.createdAt ?? '') - Date.parse(b.keyTimestamps.completedAt ?? b.keyTimestamps.createdAt ?? ''));
    dedups.forEach((d, i) => {
      const at = Date.parse(d.keyTimestamps.completedAt ?? d.keyTimestamps.createdAt ?? '') || 0;
      if (now - at > r.dedupRetentionMs || dedups.length - i > r.maxDedupRecords) {
        this.dedup.delete(d.operationId);
        if (d.confirmationId) this.dedupByConfirmation.delete(d.confirmationId);
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
    const expiredLongAgo = (iso: string) => now - Date.parse(iso) > r.closedRecordRetentionMs;
    for (const c of [...this.confirmations.values()]) {
      if (c.operationId && this.ops.has(c.operationId)) continue;
      if ((c.state !== 'waiting' && c.state !== 'approved') || expiredLongAgo(c.expiresAt)) {
        if (expiredLongAgo(c.expiresAt)) {
          this.confirmations.delete(c.confirmationId);
          this.emit({ entityType: 'confirmation', entityId: c.confirmationId, revision: c.revision + 1, state: {}, deleted: true });
          n += 1;
        }
      }
    }
    for (const p of [...this.pendings.values()]) {
      if (!expiredLongAgo(p.expiresAt)) continue;
      const conf = this.confirmationForPending(p.pendingId);
      if (conf?.operationId && this.ops.has(conf.operationId)) continue;
      this.pendings.delete(p.pendingId);
      this.emit({ entityType: 'pending', entityId: p.pendingId, revision: p.revision + 1, state: {}, deleted: true });
      n += 1;
    }
    // 5) 남은 pending·operation이 없는 요청의 파이프라인 순서
    const live = new Set<string>([...[...this.pendings.values()].map((p) => p.requestId), ...[...this.ops.values()].map((o) => o.requestId)]);
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
  private tx<T>(fn: () => T, onStorageError?: (e: Error) => T): T {
    if (this.queuedEvents) return fn();
    this.queuedEvents = [];
    try {
      let result: T;
      try {
        result = fn();
        const now = this.o.clock.nowMs();
        if (now - this.lastMaintenanceMs >= this.retention.maintenanceIntervalMs) {
          this.maintainSync();
          this.lastMaintenanceMs = now;
        }
      } catch (e) {
        this.rollback();
        throw e;
      }
      const { upserts, deletes } = this.diff();
      if (upserts.length || deletes.length) {
        try {
          this.persistence.commit(upserts, deletes);
        } catch (e) {
          this.rollback();
          const err = new StoreStorageError(e instanceof Error ? e.message : String(e));
          if (onStorageError) {
            this.queuedEvents = [];
            return onStorageError(err);
          }
          throw err;
        }
        for (const r of upserts) this.persisted.set(rowKey(r.cat, r.key), r.json);
        for (const d of deletes) this.persisted.delete(rowKey(d.cat, d.key));
      }
      const events = this.queuedEvents;
      this.queuedEvents = null;
      for (const c of events) for (const l of this.listeners) l(c);
      return result;
    } finally {
      this.queuedEvents = null;
    }
  }

  private *rows(): Generator<[StoreCategory, string, unknown]> {
    for (const [k, v] of this.ops) yield ['op', k, v];
    for (const [k, v] of this.pendings) yield ['pending', k, v];
    for (const [k, v] of this.confirmations) yield ['conf', k, v];
    for (const [k, v] of this.dedup) yield ['dedup', k, v];
    for (const [k, v] of this.dedupByConfirmation) yield ['dedupConf', k, v];
    for (const [k, v] of this.turnResults) yield ['turn', k, v];
    for (const [k, v] of this.pipelineRevs) yield ['pipe', k, v];
    yield ['meta', 'compacted', this.compacted];
  }

  private diff(): { upserts: PersistedRow[]; deletes: { cat: StoreCategory; key: string }[] } {
    const upserts: PersistedRow[] = [];
    const seen = new Set<string>();
    for (const [cat, key, v] of this.rows()) {
      const rk = rowKey(cat, key);
      seen.add(rk);
      const json = JSON.stringify(v);
      if (this.persisted.get(rk) !== json) upserts.push({ cat, key, json });
    }
    const deletes: { cat: StoreCategory; key: string }[] = [];
    for (const rk of this.persisted.keys()) if (!seen.has(rk)) deletes.push(splitRowKey(rk));
    return { upserts, deletes };
  }

  /** 마지막 기록 상태로 되돌린다 */
  private rollback(): void {
    const { upserts, deletes } = this.diff();
    for (const r of upserts) {
      const prev = this.persisted.get(rowKey(r.cat, r.key));
      if (prev === undefined) this.deleteRow(r.cat, r.key);
      else this.setRow(r.cat, r.key, JSON.parse(prev));
    }
    for (const d of deletes) this.setRow(d.cat, d.key, JSON.parse(this.persisted.get(rowKey(d.cat, d.key))!));
  }

  private setRow(cat: StoreCategory, key: string, v: unknown): void {
    switch (cat) {
      case 'op': this.ops.set(key, v as OperationRecord); break;
      case 'pending': this.pendings.set(key, v as Pending); break;
      case 'conf': this.confirmations.set(key, v as ConfirmationRecord); break;
      case 'dedup': this.dedup.set(key, v as MinimumDedupRecord); break;
      case 'dedupConf': this.dedupByConfirmation.set(key, v as string); break;
      case 'turn': {
        // 이전 형식(HarnessResult만 저장)은 기록 시각을 모르므로 다음 정리 때 지운다
        const t = v as Partial<TurnEntry> & Record<string, unknown>;
        this.turnResults.set(key, typeof t.recordedAtMs === 'number' && t.result ? (t as TurnEntry) : { recordedAtMs: 0, result: v as HarnessResult });
        break;
      }
      case 'pipe': this.pipelineRevs.set(key, v as number); break;
      case 'meta': if (key === 'compacted') this.compacted = v as number; break;
    }
  }

  private deleteRow(cat: StoreCategory, key: string): void {
    switch (cat) {
      case 'op': this.ops.delete(key); break;
      case 'pending': this.pendings.delete(key); break;
      case 'conf': this.confirmations.delete(key); break;
      case 'dedup': this.dedup.delete(key); break;
      case 'dedupConf': this.dedupByConfirmation.delete(key); break;
      case 'turn': this.turnResults.delete(key); break;
      case 'pipe': this.pipelineRevs.delete(key); break;
      case 'meta': break;
    }
  }
}

const rowKey = (cat: StoreCategory, key: string) => `${cat}\u0000${key}`;
const splitRowKey = (rk: string): { cat: StoreCategory; key: string } => {
  const i = rk.indexOf('\u0000');
  return { cat: rk.slice(0, i) as StoreCategory, key: rk.slice(i + 1) };
};
