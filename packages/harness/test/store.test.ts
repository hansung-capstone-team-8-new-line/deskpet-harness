import { beforeAll, describe, expect, it } from 'vitest';
import type { ConfirmationRecord, Pending } from '@deskpet/contracts';
import {
  DEFAULT_POLICY,
  FakeClock,
  InMemoryOperationStore,
  SequentialIdGen,
  SqlitePersistence,
  StoreDispatchOwner,
  type PrepareCommand,
} from '@deskpet/harness';
import { PR, REPO, SHA_A, T0 } from '../../../tests/support/builders.js';

const target = { kind: 'github_pr' as const, repository: { ...REPO }, prNumber: PR };

/** 같은 테스트를 메모리 전용과 SQLite 저널(:memory: DB) 두 경로로 돌린다 */
const BACKENDS = ['memory', 'sqlite'] as const;
let backend: (typeof BACKENDS)[number] = 'memory';

function setup(over: Partial<{ capacityBytes: number; minRetentionMs: number }> = {}) {
  const clock = new FakeClock(T0);
  const store = new InMemoryOperationStore({
    ...(backend === 'sqlite' ? { persistence: new SqlitePersistence(':memory:') } : {}),
    clock,
    ids: new SequentialIdGen(),
    capacityBytes: over.capacityBytes ?? DEFAULT_POLICY.storeCapacityBytes,
    recoveryBudgetBytes: 2_000,
    minRetentionMs: over.minRetentionMs ?? 0,
    maxRecoveryAttempts: 2,
  });
  return { clock, store };
}

const writeCmd = (over: Partial<PrepareCommand> = {}): PrepareCommand => ({
  owner: 'harness',
  requestId: 'req-1',
  action: 'submit_approval',
  target,
  isWrite: true,
  expectedOutcome: {
    action: 'submit_approval',
    target,
    expectedVersion: { headSha: SHA_A },
    postconditions: ['approval.review_state_approved'],
    requiredEvidence: ['review_id'],
    completenessRequirement: { sections: [], allowTruncation: false },
  },
  checkRuleVersion: 'rules-0.1',
  actualRequest: { repository: REPO, prNumber: PR, commitId: SHA_A, event: 'APPROVE' },
  priorEvidence: {},
  holderId: 'harness-1',
  ...over,
});

function pendingAndConfirmation(expiresAt = '2026-10-04T10:02:00.000Z'): { pending: Pending; conf: ConfirmationRecord } {
  const pending: Pending = {
    pendingId: 'p-1',
    requestId: 'req-1',
    conversationId: 'conv-1',
    contextId: 'ctx-1',
    contextVersion: 1,
    revision: 0,
    kind: 'confirmation',
    state: 'waiting',
    purpose: 'approve',
    requiredSlots: [],
    scope: { action: 'submit_approval', target, headSha: SHA_A },
    outputId: 'out-1',
    expiresAt,
  };
  const conf: ConfirmationRecord = {
    confirmationId: 'c-1',
    pendingId: 'p-1',
    requestId: 'req-1',
    conversationId: 'conv-1',
    revision: 0,
    scope: { action: 'submit_approval', target, headSha: SHA_A },
    requiredQuestionMeaning: 'approve PR 42 at a1b2c3d',
    outputId: 'out-1',
    state: 'waiting',
    expiresAt,
  };
  return { pending, conf };
}

const evidence = { inputChannel: 'voice' as const, sttConfidenceState: 'provided' as const, sttConfidence: 0.95 };
/** 실제로 전달한 확인 질문 문장 (고정 범위 문구 포함) */
const DELIVERED = { deliveredAt: T0, channel: 'speech' as const, sourceMessageId: 'ev-1', deliveredText: `${REPO.owner}/${REPO.name} PR ${PR}번, 현재 커밋 ${SHA_A.slice(0, 7)}을 승인할까요?` };


describe.each(BACKENDS)('store backend: %s', (b) => {
  beforeAll(() => {
    backend = b;
  });

  describe('InMemoryOperationStore — prepare & dispatch boundary', () => {
    it('reserveAndPrepare creates prepared op with write authority and not_sent attempt', async () => {
      const { store } = setup();
      const r = await store.reserveAndPrepare(writeCmd());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.operation.executionPhase).toBe('prepared');
      expect(r.operation.attempts[0]!.dispatchState).toBe('not_sent');
      expect(r.authority.kind).toBe('write');
      expect(r.operation.reservedRecoveryBytes).toBe(2_000);
    });

    it('persistMayHaveBeenSent returns DurableAck only for the current authority', async () => {
      const { store } = setup();
      const r = await store.reserveAndPrepare(writeCmd());
      if (!r.ok) throw new Error();
      const stale = await store.persistMayHaveBeenSent({ ...r.authority, ownerRevision: 99, operationId: r.operation.operationId });
      expect(stale.ok).toBe(false);
      const ack = await store.persistMayHaveBeenSent({ ...r.authority, operationId: r.operation.operationId });
      expect(ack.ok).toBe(true);
      const op = await store.getOperation(r.operation.operationId);
      expect(op!.attempts[0]!.dispatchState).toBe('may_have_been_sent');
      expect(op!.executionPhase).toBe('dispatching');
    });

    it('storage failure on persist yields no ack (gateway must not send)', async () => {
      const { store } = setup();
      const r = await store.reserveAndPrepare(writeCmd());
      if (!r.ok) throw new Error();
      store.failNextPersist = true;
      const ack = await store.persistMayHaveBeenSent({ ...r.authority, operationId: r.operation.operationId });
      expect(ack).toMatchObject({ ok: false, reason: 'storage_error' });
    });

    it('not_sent evidence requires proof', async () => {
      const { store } = setup();
      const r = await store.reserveAndPrepare(writeCmd());
      if (!r.ok) throw new Error();
      await expect(
        store.appendEvidence(r.operation.operationId, { attemptId: r.authority.attemptId, attemptDispatchState: 'not_sent' }),
      ).rejects.toThrow(/proof/);
    });

    it('allows exactly one conditional retry after proven not_sent', async () => {
      const { store } = setup();
      const r = await store.reserveAndPrepare(writeCmd());
      if (!r.ok) throw new Error();
      const id = r.operation.operationId;
      let op = await store.appendEvidence(id, {
        attemptId: r.authority.attemptId,
        attemptDispatchState: 'not_sent',
        notSentProof: 'connection_refused_before_request',
        releaseAuthority: true,
      });
      const retry = await store.prepareRetryAttempt(id, op.revision, 'harness-1');
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      op = await store.appendEvidence(id, {
        attemptId: retry.authority.attemptId,
        attemptDispatchState: 'not_sent',
        notSentProof: 'connection_refused_before_request',
        releaseAuthority: true,
      });
      const again = await store.prepareRetryAttempt(id, op.revision, 'harness-1');
      expect(again).toMatchObject({ ok: false, reason: 'retry_not_allowed' });
    });

    it('refuses retry when the last attempt may have been sent', async () => {
      const { store } = setup();
      const r = await store.reserveAndPrepare(writeCmd());
      if (!r.ok) throw new Error();
      await store.persistMayHaveBeenSent({ ...r.authority, operationId: r.operation.operationId });
      const op = await store.appendEvidence(r.operation.operationId, { attemptId: r.authority.attemptId, releaseAuthority: true });
      const retry = await store.prepareRetryAttempt(op.operationId, op.revision, 'harness-1');
      expect(retry.ok).toBe(false);
    });

    it('revokeBeforeDispatch works only before the dispatch boundary', async () => {
      const { store } = setup();
      const a = await store.reserveAndPrepare(writeCmd());
      if (!a.ok) throw new Error();
      expect((await store.revokeBeforeDispatch(a.operation.operationId, 'user_cancel')).revoked).toBe(true);
      const op = await store.getOperation(a.operation.operationId);
      expect(op!.actionResult).toMatchObject({ status: 'cancelled', dispatchState: 'not_sent' });

      const b = await store.reserveAndPrepare(writeCmd());
      if (!b.ok) throw new Error();
      await store.persistMayHaveBeenSent({ ...b.authority, operationId: b.operation.operationId });
      expect((await store.revokeBeforeDispatch(b.operation.operationId, 'user_cancel')).revoked).toBe(false);
    });
  });

  describe('InMemoryOperationStore — crash recovery', () => {
    it('may_have_been_sent becomes unknown + recovery needed after restart, no authority', async () => {
      const { store } = setup();
      const r = await store.reserveAndPrepare(writeCmd());
      if (!r.ok) throw new Error();
      await store.persistMayHaveBeenSent({ ...r.authority, operationId: r.operation.operationId });
      store.simulateRestart();
      const op = await store.getOperation(r.operation.operationId);
      expect(op!.actionResult).toMatchObject({ status: 'unknown', dispatchState: 'may_have_been_sent' });
      expect(op!.recovery).toBe('needed');
      expect(op!.currentExecutionAuthority).toBeUndefined();
      // 재전송 경로 없음
      const retry = await store.prepareRetryAttempt(op!.operationId, op!.revision, 'harness-2');
      expect(retry.ok).toBe(false);
    });

    it('prepared-but-unacked becomes failed + not_sent after restart', async () => {
      const { store } = setup();
      const r = await store.reserveAndPrepare(writeCmd());
      if (!r.ok) throw new Error();
      store.simulateRestart();
      const op = await store.getOperation(r.operation.operationId);
      expect(op!.actionResult).toMatchObject({ status: 'failed', dispatchState: 'not_sent' });
    });

    it('claimSingleRecovery grants exactly one read-only recovery authority', async () => {
      const { store } = setup();
      const r = await store.reserveAndPrepare(writeCmd());
      if (!r.ok) throw new Error();
      await store.persistMayHaveBeenSent({ ...r.authority, operationId: r.operation.operationId });
      store.simulateRestart();
      const op = (await store.getOperation(r.operation.operationId))!;
      const first = await store.claimSingleRecovery(op.operationId, op.revision, 'rec-a');
      const second = await store.claimSingleRecovery(op.operationId, op.revision, 'rec-b');
      expect(first?.kind).toBe('read_recovery_only');
      expect(second).toBeNull();
      // 복구 권한으로는 쓰기 ack를 받을 수 없다: 다른 holder / write 권한 아님
      const ack = await store.persistMayHaveBeenSent({ ...first!, operationId: op.operationId, holderId: 'rec-b' });
      expect(ack.ok).toBe(false);
    });

    it('recovery reaching the limit becomes blocked', async () => {
      const { store } = setup();
      const r = await store.reserveAndPrepare(writeCmd());
      if (!r.ok) throw new Error();
      await store.persistMayHaveBeenSent({ ...r.authority, operationId: r.operation.operationId });
      store.simulateRestart();
      for (let i = 0; i < 2; i++) {
        const op = (await store.getOperation(r.operation.operationId))!;
        const auth = await store.claimSingleRecovery(op.operationId, op.revision, `rec-${i}`);
        expect(auth).not.toBeNull();
        await store.releaseRecovery(op.operationId, `rec-${i}`, 'still_unknown');
      }
      const op = (await store.getOperation(r.operation.operationId))!;
      expect(op.recovery).toBe('blocked');
    });
  });

  describe('InMemoryOperationStore — pending / confirmation atomicity', () => {
    it('rejects answer before the question was delivered', async () => {
      const { store } = setup();
      const { pending, conf } = pendingAndConfirmation();
      await store.createPending(pending, conf);
      const r = await store.atomicCommitAnswerAndClaim({
        pendingId: 'p-1',
        expectedPendingRevision: 0,
        requestId: 'req-1',
        conversationId: 'conv-1',
        answerTurnId: 't-2',
        answeredAtMs: Date.parse(T0),
        decision: { kind: 'confirmation', confirmationId: 'c-1', verdict: 'approved', evidence, rawText: '응', rationale: 'yes' },
      });
      expect(r).toMatchObject({ ok: false, reason: 'question_not_delivered' });
    });

    it('refuses an answer when the delivered sentence named a different target (audit F-01)', async () => {
      const { store } = setup();
      const { pending, conf } = pendingAndConfirmation();
      await store.createPending(pending, conf);
      const p = await store.markQuestionDelivered('p-1', 'out-1', { ...DELIVERED, deliveredText: '다른 저장소 Other/Repo PR 999번을 승인할까요?' });
      const r = await store.atomicCommitAnswerAndClaim({
        pendingId: 'p-1',
        expectedPendingRevision: p!.revision,
        requestId: 'req-1',
        conversationId: 'conv-1',
        answerTurnId: 't-2',
        answeredAtMs: Date.parse(T0),
        decision: { kind: 'confirmation', confirmationId: 'c-1', verdict: 'approved', evidence, rawText: '네', rationale: 'yes', prepare: writeCmd() },
      });
      expect(r).toMatchObject({ ok: false, reason: 'question_not_delivered' });
      expect(await store.listOperations()).toHaveLength(0);
    });

    it('approves, consumes pending and links exactly one operation atomically', async () => {
      const { store } = setup();
      const { pending, conf } = pendingAndConfirmation();
      await store.createPending(pending, conf);
      const p = await store.markQuestionDelivered('p-1', 'out-1', DELIVERED);
      const cmd = {
        pendingId: 'p-1',
        expectedPendingRevision: p!.revision,
        requestId: 'req-1',
        conversationId: 'conv-1',
        answerTurnId: 't-2',
        answeredAtMs: Date.parse(T0),
        decision: {
          kind: 'confirmation' as const,
          confirmationId: 'c-1',
          verdict: 'approved' as const,
          evidence,
          rawText: '응 승인해',
          rationale: 'explicit approval',
          prepare: writeCmd(),
        },
      };
      const r = await store.atomicCommitAnswerAndClaim(cmd);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.pending.state).toBe('consumed');
      expect(r.confirmation!.state).toBe('approved');
      expect(r.prepared?.ok).toBe(true);
      // 같은 revision으로 다시 답변: 낡은 revision → 현재 상태 반환, 새 operation 없음
      const dup = await store.atomicCommitAnswerAndClaim({ ...cmd, answerTurnId: 't-3' });
      expect(dup).toMatchObject({ ok: false });
      expect((await store.listOperations()).length).toBe(1);
      // 같은 confirmation으로 두 번째 operation 불가
      const second = await store.reserveAndPrepare(writeCmd({ confirmationRef: 'c-1' }));
      expect(second).toMatchObject({ ok: false, reason: 'confirmation_already_linked' });
    });

    it('answer after expiresAt expires pending and confirmation in the same commit', async () => {
      const { store, clock } = setup();
      const { pending, conf } = pendingAndConfirmation('2026-10-04T10:01:00.000Z');
      await store.createPending(pending, conf);
      const p = await store.markQuestionDelivered('p-1', 'out-1', DELIVERED);
      clock.advance(120_000);
      const r = await store.atomicCommitAnswerAndClaim({
        pendingId: 'p-1',
        expectedPendingRevision: p!.revision,
        requestId: 'req-1',
        conversationId: 'conv-1',
        answerTurnId: 't-2',
        answeredAtMs: clock.nowMs(),
        decision: { kind: 'confirmation', confirmationId: 'c-1', verdict: 'approved', evidence, rawText: '응', rationale: 'yes' },
      });
      expect(r).toMatchObject({ ok: false, reason: 'expired' });
      expect((await store.getConfirmation('c-1'))!.state).toBe('expired');
    });

    it('speech_started does not extend expiresAt', async () => {
      const { store } = setup();
      const { pending, conf } = pendingAndConfirmation();
      await store.createPending(pending, conf);
      await store.markQuestionDelivered('p-1', 'out-1', DELIVERED);
      const p = await store.markSpeechStarted('p-1', T0);
      expect(p!.expiresAt).toBe(pending.expiresAt);
    });

    it('closePending(revoked) also revokes the unconsumed confirmation', async () => {
      const { store } = setup();
      const { pending, conf } = pendingAndConfirmation();
      await store.createPending(pending, conf);
      await store.closePending('p-1', 'revoked', 'target_changed');
      expect((await store.getConfirmation('c-1'))!.state).toBe('revoked');
    });
  });

  describe('InMemoryOperationStore — retention', () => {
    it('never evicts protected (unknown) records and blocks new writes when full', async () => {
      const { store } = setup({ capacityBytes: 9_000 });
      const r = await store.reserveAndPrepare(writeCmd());
      if (!r.ok) throw new Error();
      await store.persistMayHaveBeenSent({ ...r.authority, operationId: r.operation.operationId });
      store.simulateRestart(); // unknown → protected
      let blocked = false;
      for (let i = 0; i < 5; i++) {
        const n = await store.reserveAndPrepare(writeCmd({ requestId: `req-${i + 2}` }));
        if (!n.ok) {
          expect(n.reason).toBe('capacity_exhausted');
          blocked = true;
          break;
        }
      }
      expect(blocked).toBe(true);
      expect(await store.getOperation(r.operation.operationId)).toBeDefined();
    });

    it('compacts terminal unreferenced records into MinimumDedupRecord', async () => {
      const { store } = setup();
      const r = await store.reserveAndPrepare(writeCmd());
      if (!r.ok) throw new Error();
      const id = r.operation.operationId;
      await store.persistMayHaveBeenSent({ ...r.authority, operationId: id });
      await store.appendEvidence(id, {
        attemptId: r.authority.attemptId,
        attemptDispatchState: 'sent',
        phase: 'stopped',
        assessment: 'assessed',
        releaseAuthority: true,
        actionResult: {
          operationId: id,
          action: 'submit_approval',
          target,
          status: 'succeeded',
          dispatchState: 'sent',
          facts: {},
          externalRefs: [{ system: 'github', kind: 'review', id: '9001' }],
          observedAt: T0,
        },
      });
      expect(await store.compactEligibleRecord(id)).toBe(true);
      expect(await store.getOperation(id)).toBeUndefined();
      expect(await store.getDedupRecord(id)).toMatchObject({ result: 'succeeded', externalIds: ['github:review:9001'], shaOrChangeScope: SHA_A });
    });
  });

  describe('StoreDispatchOwner', () => {
    it('validity failure revokes authority and returns no ack', async () => {
      const { store, clock } = setup();
      const owner = new StoreDispatchOwner(store, clock, 'harness-1', async () => 'deadline_exceeded');
      const r = await owner.prepareOperation(writeCmd());
      if (!r.ok) throw new Error();
      const h = owner.handleFor(r.authority, r.operation.operationId);
      const ack = await h.beforeDispatch();
      expect(ack.ok).toBe(false);
      const op = await store.getOperation(r.operation.operationId);
      expect(op!.actionResult).toMatchObject({ status: 'cancelled', dispatchState: 'not_sent' });
    });

    it('valid dispatch yields DurableAck', async () => {
      const { store, clock } = setup();
      const owner = new StoreDispatchOwner(store, clock, 'harness-1', async () => null);
      const r = await owner.prepareOperation(writeCmd());
      if (!r.ok) throw new Error();
      const ack = await owner.handleFor(r.authority, r.operation.operationId).beforeDispatch();
      expect(ack.ok && ack.ack.kind).toBe('may_have_been_sent');
    });
  });

  describe('InMemoryOperationStore — projection snapshot (scope = source 전체)', () => {
    it('reads operations, pendings and confirmations together as copies', async () => {
      const { store } = setup();
      const { pending, conf } = pendingAndConfirmation();
      await store.createPending(pending, conf);
      const snap = await store.readProjectionSnapshot();
      expect(snap.pendings.map((p) => p.pendingId)).toEqual(['p-1']);
      expect(snap.confirmations.map((c) => c.confirmationId)).toEqual(['c-1']);
      expect(snap.operations).toEqual([]);
      snap.pendings[0]!.revision = 99;
      expect((await store.getPending('p-1'))!.revision).not.toBe(99);
    });
  });
});
