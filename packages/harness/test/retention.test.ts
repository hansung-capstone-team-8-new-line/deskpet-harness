import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfirmationRecord, Pending } from '@deskpet/contracts';
import { FakeClock, InMemoryOperationStore, SequentialIdGen, SqlitePersistence, type PrepareCommand, type RetentionPolicy } from '@deskpet/harness';
import { PR, REPO, SHA_A, T0 } from '../../../tests/support/builders.js';

/** 보존 정책: 요청이 계속 들어와도 기록·파일이 끝없이 커지지 않는다 (임베디드 저장 공간) */
const H = 3600_000;
const target = { kind: 'github_pr' as const, repository: { ...REPO }, prNumber: PR };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(retention: Partial<RetentionPolicy> = {}, persistence?: SqlitePersistence) {
  const clock = new FakeClock(T0);
  const store = new InMemoryOperationStore({
    clock,
    ids: new SequentialIdGen(),
    capacityBytes: 64 * 1024 * 1024,
    recoveryBudgetBytes: 2_000,
    minRetentionMs: 24 * H,
    maxRecoveryAttempts: 3,
    retention: { maintenanceIntervalMs: 0, ...retention },
    ...(persistence ? { persistence } : {}),
  });
  return { clock, store };
}

const cmd = (requestId: string, isWrite = false): PrepareCommand => ({
  owner: 'harness',
  requestId,
  action: isWrite ? 'submit_approval' : 'get_review_context',
  target,
  isWrite,
  expectedOutcome: { action: 'submit_approval', target, expectedVersion: { headSha: SHA_A }, postconditions: [], requiredEvidence: [], completenessRequirement: { sections: [], allowTruncation: false } },
  checkRuleVersion: 'rules-0.1',
  actualRequest: { commitId: SHA_A },
  priorEvidence: {},
  holderId: 'h',
});

/** 요청 하나를 흉내 낸다: 조회 operation 완료 + 질문(pending·confirmation) 닫힘 + 턴 결과 + 파이프라인 순서 */
async function oneRequest(store: InMemoryOperationStore, clock: FakeClock, i: number) {
  const req = `req-${i}`;
  const r = await store.reserveAndPrepare(cmd(req));
  if (!r.ok) throw new Error(r.reason);
  await store.appendEvidence(r.operation.operationId, {
    attemptId: r.authority.attemptId,
    attemptDispatchState: 'sent',
    phase: 'stopped',
    assessment: 'assessed',
    actionResult: { operationId: r.operation.operationId, action: 'get_review_context', target, status: 'succeeded', dispatchState: 'sent', facts: {}, externalRefs: [], observedAt: clock.nowIso() },
    releaseAuthority: true,
  });
  const exp = new Date(clock.nowMs() + 2 * 60_000).toISOString();
  const pending = { pendingId: `p-${i}`, requestId: req, conversationId: 'c', contextId: 'x', contextVersion: 1, revision: 0, kind: 'confirmation', state: 'waiting', purpose: 'approve', requiredSlots: [], outputId: `o-${i}`, expiresAt: exp } as unknown as Pending;
  const conf = { confirmationId: `c-${i}`, pendingId: `p-${i}`, revision: 0, state: 'waiting', scope: { action: 'submit_approval', target, headSha: SHA_A }, expiresAt: exp } as unknown as ConfirmationRecord;
  await store.createPending(pending, conf);
  await store.closePending(`p-${i}`, 'revoked', 'user_declined');
  await store.recordTurnResult(`t-${i}`, { requestId: req, disposition: 'completed', actionResults: [], facts: {}, sources: [], processingErrors: [] });
  await store.setLastPipelineRevision(req, 1);
  return r.operation.operationId;
}

describe('보존 정책', () => {
  it('종료된 operation은 보존 기간이 지나면 축약되고, 결과 불명·진행 중은 남는다', async () => {
    const { clock, store } = setup();
    const done = await oneRequest(store, clock, 1);
    const w = await store.reserveAndPrepare(cmd('req-w', true));
    if (!w.ok) throw new Error();
    await store.persistMayHaveBeenSent({ ...w.authority, operationId: w.operation.operationId });
    store.simulateRestart(); // → unknown, recovery needed
    clock.advance(25 * H);
    await store.maintain();
    expect(await store.getOperation(done)).toBeUndefined();
    expect(await store.getDedupRecord(done)).toMatchObject({ result: 'succeeded' });
    expect((await store.getOperation(w.operation.operationId))!.actionResult!.status).toBe('unknown');
  });

  it('턴 결과는 보존 기간 안에서만 남는다 (같은 턴 재전달에는 같은 결과)', async () => {
    const { clock, store } = setup({ turnResultRetentionMs: H });
    await oneRequest(store, clock, 1);
    clock.advance(30 * 60_000);
    await store.maintain();
    expect(await store.getTurnResult('t-1')).toBeDefined();
    clock.advance(31 * 60_000);
    await store.maintain();
    expect(await store.getTurnResult('t-1')).toBeUndefined();
  });

  it('닫힌 pending·confirmation과 그 요청의 파이프라인 순서는 보존 기간 뒤 지운다. 기다리는 질문은 남긴다', async () => {
    const { clock, store } = setup({ closedRecordRetentionMs: 2 * H });
    await oneRequest(store, clock, 1);
    const exp = new Date(clock.nowMs() + 10 * H).toISOString();
    await store.createPending({ pendingId: 'p-live', requestId: 'req-live', conversationId: 'c', contextId: 'x', contextVersion: 1, revision: 0, kind: 'clarification', state: 'waiting', purpose: 'identify_pr', requiredSlots: [], outputId: 'o', expiresAt: exp } as unknown as Pending);
    await store.setLastPipelineRevision('req-live', 3);
    clock.advance(3 * H);
    await store.maintain();
    expect(await store.getPending('p-1')).toBeUndefined();
    expect(await store.getConfirmation('c-1')).toBeUndefined();
    // 같은 요청의 operation이 아직 남아 있으면 순서 기록도 남긴다
    expect(await store.getLastPipelineRevision('req-1')).toBe(1);
    expect((await store.getPending('p-live'))!.state).toBe('waiting');
    expect(await store.getLastPipelineRevision('req-live')).toBe(3);
    clock.advance(22 * H); // operation 보존 기간(24시간) 경과 → 축약 → 순서 기록도 정리
    await store.maintain();
    expect(await store.getLastPipelineRevision('req-1')).toBeUndefined();
  });

  it('최소 중복 방지 기록은 기간·개수 상한을 넘으면 오래된 것부터 지운다', async () => {
    const { clock, store } = setup({ maxDedupRecords: 3, dedupRetentionMs: 10 * 24 * H });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await oneRequest(store, clock, i));
      clock.advance(H);
    }
    clock.advance(25 * H);
    await store.maintain();
    expect((await Promise.all(ids.map((id) => store.getDedupRecord(id)))).map(Boolean)).toEqual([false, false, true, true, true]);
    clock.advance(10 * 24 * H);
    await store.maintain();
    expect((await Promise.all(ids.map((id) => store.getDedupRecord(id)))).every((d) => !d)).toBe(true);
  });

  it('요청이 계속 들어와도 SQLite 레코드 수와 파일 크기가 일정 수준에서 멈춘다', async () => {
    const d = mkdtempSync(join(tmpdir(), 'deskpet-ret-'));
    dirs.push(d);
    const persistence = new SqlitePersistence(join(d, 'h.db'));
    const { clock, store } = setup({ maxDedupRecords: 50, maxTurnResults: 20, closedRecordRetentionMs: 2 * H, turnResultRetentionMs: H }, persistence);
    const sample: { rows: number; pages: number }[] = [];
    for (let i = 0; i < 400; i++) {
      await oneRequest(store, clock, i);
      clock.advance(H); // 한 시간에 한 번 요청 → 400시간 (약 17일)
      if (i === 199 || i === 399) {
        const s = persistence.stats();
        sample.push({ rows: s.rows, pages: s.pages - s.freePages });
      }
    }
    const [mid, end] = sample as [{ rows: number; pages: number }, { rows: number; pages: number }];
    // 24시간치 operation + 최대 50개 축약 기록 + 몇 개의 pending·턴 정도에서 멈춘다
    expect(end.rows).toBeLessThan(150);
    expect(Math.abs(end.rows - mid.rows)).toBeLessThanOrEqual(5);
    expect(end.pages).toBeLessThanOrEqual(mid.pages + 5);
    store.close();
  });

  it('이전 형식의 턴 결과(기록 시각 없음)를 읽으면 다음 정리 때 지운다', async () => {
    const d = mkdtempSync(join(tmpdir(), 'deskpet-ret-'));
    dirs.push(d);
    const p = new SqlitePersistence(join(d, 'h.db'));
    p.commit([{ cat: 'turn', key: 't-old', json: JSON.stringify({ requestId: 'r', disposition: 'completed', actionResults: [], facts: {}, sources: [], processingErrors: [] }) }], []);
    const { store } = setup({}, p);
    expect(await store.getTurnResult('t-old')).toMatchObject({ disposition: 'completed' });
    await store.maintain();
    expect(await store.getTurnResult('t-old')).toBeUndefined();
    store.close();
  });
});
