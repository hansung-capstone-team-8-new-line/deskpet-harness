import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfirmationRecord, Pending } from '@deskpet/contracts';
import { DEFAULT_POLICY, FakeClock, InMemoryOperationStore, SequentialIdGen, SqlitePersistence, StoreDispatchOwner, StoreLockedError, type IdGen, type PersistedRow, type PrepareCommand, type StorePersistence } from '@deskpet/harness';
import { PR, REPO, SHA_A, T0 } from '../../../tests/support/builders.js';

/** 실제 디스크(SQLite 파일)에 남는지, 다시 열었을 때 재전송 없이 복구되는지 검사한다 */
const dirs: string[] = [];
const tmpDb = () => {
  const d = mkdtempSync(join(tmpdir(), 'deskpet-store-'));
  dirs.push(d);
  return join(d, 'harness.db');
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const target = { kind: 'github_pr' as const, repository: { ...REPO }, prNumber: PR };
const opts = (ids: IdGen = new SequentialIdGen()) => ({
  clock: new FakeClock(T0),
  ids,
  capacityBytes: DEFAULT_POLICY.storeCapacityBytes,
  recoveryBudgetBytes: 2_000,
  minRetentionMs: 3600_000,
  maxRecoveryAttempts: 3,
});
/** 재시작해도 겹치지 않는 결정적 ID (앞 프로세스와 다른 접두사) */
const idsWithPrefix = (p: string) => {
  let n = 0;
  return { next: (prefix: string) => `${prefix}-${p}${++n}` };
};
const writeCmd = (): PrepareCommand => ({
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
});

describe('SQLite 영속 저장소 — 다시 열기', () => {
  it('ack 뒤 종료 → 다시 열면 unknown + 복구 필요, 실행 권한 없음, 재전송 경로 없음', async () => {
    const path = tmpDb();
    const a = InMemoryOperationStore.openDurable(path, opts(idsWithPrefix('a')));
    const r = await a.reserveAndPrepare(writeCmd());
    if (!r.ok) throw new Error();
    const ack = await a.persistMayHaveBeenSent({ ...r.authority, operationId: r.operation.operationId });
    expect(ack.ok).toBe(true);
    a.close();

    const b = InMemoryOperationStore.openDurable(path, opts(idsWithPrefix('b')));
    const op = (await b.getOperation(r.operation.operationId))!;
    expect(op.actionResult).toMatchObject({ status: 'unknown', dispatchState: 'may_have_been_sent' });
    expect(op.recovery).toBe('needed');
    expect(op.currentExecutionAuthority).toBeUndefined();
    expect((await b.prepareRetryAttempt(op.operationId, op.revision, 'h2')).ok).toBe(false);
    // 이전 프로세스의 권한으로는 ack를 다시 받을 수 없다
    expect((await b.persistMayHaveBeenSent({ ...r.authority, operationId: op.operationId })).ok).toBe(false);
    b.close();
  });

  it('ack 전 종료 → 다시 열면 failed + not_sent (전송하지 않았음)', async () => {
    const path = tmpDb();
    const a = InMemoryOperationStore.openDurable(path, opts(idsWithPrefix('a')));
    const r = await a.reserveAndPrepare(writeCmd());
    if (!r.ok) throw new Error();
    a.close();
    const b = InMemoryOperationStore.openDurable(path, opts(idsWithPrefix('b')));
    expect((await b.getOperation(r.operation.operationId))!.actionResult).toMatchObject({ status: 'failed', dispatchState: 'not_sent' });
    b.close();
  });

  it('pending·confirmation·턴 결과·파이프라인 순서·축약 기록이 다시 열어도 남는다', async () => {
    const path = tmpDb();
    const a = InMemoryOperationStore.openDurable(path, { ...opts(idsWithPrefix('a')), minRetentionMs: 0 });
    const pending = { pendingId: 'p-1', requestId: 'req-1', conversationId: 'c', contextId: 'x', contextVersion: 1, revision: 0, kind: 'confirmation', state: 'waiting', purpose: 'approve', requiredSlots: [], outputId: 'o-1', expiresAt: '2026-10-04T10:02:00.000Z' } as unknown as Pending;
    const conf = { confirmationId: 'c-1', pendingId: 'p-1', revision: 0, state: 'waiting', scope: { action: 'submit_approval', target, headSha: SHA_A }, expiresAt: '2026-10-04T10:02:00.000Z' } as unknown as ConfirmationRecord;
    await a.createPending(pending, conf);
    await a.recordTurnResult('t-1', { requestId: 'req-1', disposition: 'completed', actionResults: [], facts: {}, sources: [], processingErrors: [] });
    await a.setLastPipelineRevision('req-1', 7);
    const done = await a.reserveAndPrepare({ ...writeCmd(), isWrite: false, action: 'get_review_context' });
    if (!done.ok) throw new Error();
    await a.appendEvidence(done.operation.operationId, {
      attemptId: done.authority.attemptId,
      attemptDispatchState: 'sent',
      phase: 'stopped',
      assessment: 'assessed',
      actionResult: { operationId: done.operation.operationId, action: 'get_review_context', target, status: 'succeeded', dispatchState: 'sent', facts: {}, externalRefs: [], observedAt: T0 },
      releaseAuthority: true,
    });
    expect(await a.compactEligibleRecord(done.operation.operationId)).toBe(true);
    a.close();

    const b = InMemoryOperationStore.openDurable(path, { ...opts(idsWithPrefix('b')), minRetentionMs: 0 });
    expect((await b.getPending('p-1'))!.state).toBe('waiting');
    expect((await b.getConfirmation('c-1'))!.state).toBe('waiting');
    expect(await b.getTurnResult('t-1')).toMatchObject({ disposition: 'completed' });
    expect(await b.getLastPipelineRevision('req-1')).toBe(7);
    expect(await b.getDedupRecord(done.operation.operationId)).toMatchObject({ result: 'succeeded' });
    expect((await b.usage()).compactedCount).toBe(1);
    b.close();
  });

  it('재시작 뒤 ID가 겹치는 생성기는 거부한다 (기존 기록을 덮어쓰지 않음)', async () => {
    const path = tmpDb();
    const a = InMemoryOperationStore.openDurable(path, opts());
    const r = await a.reserveAndPrepare(writeCmd());
    if (!r.ok) throw new Error();
    a.close();
    const b = InMemoryOperationStore.openDurable(path, opts()); // 같은 SequentialIdGen → op-1 다시 생성
    await expect(b.reserveAndPrepare(writeCmd())).rejects.toThrow(/id collision/);
    expect((await b.listOperations()).length).toBe(1);
    b.close();
  });
});

describe('기록 실패 시 되돌리기', () => {
  class FlakyPersistence implements StorePersistence {
    failNext = false;
    commits = 0;
    constructor(private readonly inner: StorePersistence) {}
    loadAll(): PersistedRow[] {
      return this.inner.loadAll();
    }
    commit(u: PersistedRow[], d: { cat: PersistedRow['cat']; key: string }[]): void {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('disk full');
      }
      this.commits += 1;
      this.inner.commit(u, d);
    }
    close(): void {
      this.inner.close();
    }
  }

  it('may_have_been_sent 기록 실패 → ack 없음(storage_error), 메모리도 되돌림, 알림 없음 → Gateway 전송 안 함', async () => {
    const p = new FlakyPersistence(new SqlitePersistence(':memory:'));
    const o = opts();
    const store = new InMemoryOperationStore({ ...o, persistence: p });
    const r = await store.reserveAndPrepare(writeCmd());
    if (!r.ok) throw new Error();
    const events: string[] = [];
    store.subscribe((c) => events.push(`${c.entityType}:${c.revision}`));
    p.failNext = true;
    const owner = new StoreDispatchOwner(store, o.clock, 'harness-1', async () => null);
    const ack = await owner.handleFor(r.authority, r.operation.operationId).beforeDispatch();
    expect(ack).toMatchObject({ ok: false, reason: 'storage_error' });
    const op = (await store.getOperation(r.operation.operationId))!;
    expect(op.attempts[0]!.dispatchState).toBe('not_sent');
    expect(op.executionPhase).toBe('prepared');
    expect(op.revision).toBe(r.operation.revision);
    expect(events).toEqual([]);
    // 다음 시도는 정상 기록
    const ack2 = await owner.handleFor(r.authority, r.operation.operationId).beforeDispatch();
    expect(ack2.ok).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('예약 기록 실패 → 실행 전 차단, operation이 남지 않음', async () => {
    const p = new FlakyPersistence(new SqlitePersistence(':memory:'));
    const store = new InMemoryOperationStore({ ...opts(), persistence: p });
    p.failNext = true;
    const r = await store.reserveAndPrepare(writeCmd());
    expect(r).toMatchObject({ ok: false, reason: 'capacity_exhausted' });
    expect(await store.listOperations()).toEqual([]);
  });

  it('검사 오류로 중간에 던지면 일부만 바뀐 상태를 남기지 않는다', async () => {
    const store = new InMemoryOperationStore(opts());
    const r = await store.reserveAndPrepare(writeCmd());
    if (!r.ok) throw new Error();
    await store.appendEvidence(r.operation.operationId, { attemptId: r.authority.attemptId, attemptDispatchState: 'sent' });
    const before = await store.getOperation(r.operation.operationId);
    await expect(store.appendEvidence(r.operation.operationId, { attemptId: r.authority.attemptId, attemptDispatchState: 'not_sent', notSentProof: 'x' })).rejects.toThrow('cannot downgrade');
    expect(await store.getOperation(r.operation.operationId)).toEqual(before);
  });
});

describe('실제 프로세스 강제 종료 (SIGKILL)', () => {
  /** 정상 종료·예외 종료가 아니라 강제 종료였는지 (Windows는 signal 대신 비정상 종료 코드) */
  const expectKilled = (c: ReturnType<typeof spawnSync>) => {
    expect(String(c.stderr)).not.toMatch(/Error/);
    expect(c.signal === 'SIGKILL' || (c.status !== null && c.status !== 0)).toBe(true);
  };
  const runChild = (path: string, stage: string) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'tests/support/crashChild.ts', path, stage], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });

  it('ack 직후 강제 종료된 프로세스의 쓰기는 다른 프로세스가 열었을 때 unknown으로 복구된다', () => {
    const path = tmpDb();
    const child = runChild(path, 'after_ack');
    expectKilled(child);
    const opId = child.stdout.trim();
    expect(opId).toMatch(/^op-/);
    const b = InMemoryOperationStore.openDurable(path, opts(idsWithPrefix('b')));
    return b.getOperation(opId).then((op) => {
      expect(op!.actionResult).toMatchObject({ status: 'unknown', dispatchState: 'may_have_been_sent' });
      expect(op!.recovery).toBe('needed');
      b.close();
    });
  });

  it('ack 전에 강제 종료되면 전송하지 않은 것으로 복구된다', async () => {
    const path = tmpDb();
    const child = runChild(path, 'before_ack');
    expectKilled(child);
    const b = InMemoryOperationStore.openDurable(path, opts(idsWithPrefix('b')));
    expect((await b.getOperation(child.stdout.trim()))!.actionResult).toMatchObject({ status: 'failed', dispatchState: 'not_sent' });
    b.close();
  });
});

describe('단일 기록자 잠금 (감사 F-04)', () => {
  it('같은 DB 파일은 한 번에 하나만 쓰기용으로 열 수 있다', () => {
    const path = tmpDb();
    const a = InMemoryOperationStore.openDurable(path, opts());
    expect(() => InMemoryOperationStore.openDurable(path, opts())).toThrow(StoreLockedError);
    a.close();
    const b = InMemoryOperationStore.openDurable(path, opts());
    b.close();
  });

  it('같은 컴퓨터에서 이미 끝난 프로세스의 잠금은 넘겨받는다', () => {
    const path = tmpDb();
    InMemoryOperationStore.openDurable(path, opts()).close();
    // 끝난 프로세스 pid를 얻는다
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: dead, host: hostname(), startedAt: T0 }));
    const s = InMemoryOperationStore.openDurable(path, opts());
    s.close();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('다른 컴퓨터 이름의 잠금은 넘겨받지 않는다', () => {
    const path = tmpDb();
    InMemoryOperationStore.openDurable(path, opts()).close();
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 1, host: 'other-host', startedAt: T0 }));
    expect(() => InMemoryOperationStore.openDurable(path, opts())).toThrow(/other-host/);
  });
});
