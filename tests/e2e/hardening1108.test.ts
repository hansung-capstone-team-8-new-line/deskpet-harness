import { describe, expect, it } from 'vitest';
import { EurekaGateway, FakeEurekaServer } from '@deskpet/gateways';
import { DEFAULT_POLICY, FakeClock, InMemoryOperationStore, SequentialIdGen } from '@deskpet/harness';
import { EurekaBridge } from '@deskpet/server';
import { PR, REPO, STAGE_ID, T0, harnessRequest, prContext, voiceTurn } from '../support/builders.js';
import { answer } from '../support/flows.js';
import { createWorld } from '../support/world.js';

/**
 * 2026-11-08 하네스 내부 미구현 보완
 * - 결과 조회는 operationId가 정확히 맞을 때만, operationId 재사용 거절, 등록 결과 itemId, 기록 추가 결과 조회
 * - 업무 연결(taskRefs)이 없으면 단계 기록에서 PR 주소로 연결 단계를 찾는다
 */
const DEADLINE = '2026-10-04T10:05:00.000Z';
const prUrl = `https://github.com/${REPO.owner}/${REPO.name}/pull/${PR}`;

function bridgeSetup() {
  const clock = new FakeClock(T0);
  const server = new FakeEurekaServer(() => clock.nowMs());
  server.addItem({ id: '2001', name: '보고서 제출', dueAt: clock.nowMs() + 86_400_000, stages: [{ id: '20011', name: '작성', status: 'doing', order: 1 }] });
  const store = new InMemoryOperationStore({ clock, ids: new SequentialIdGen(), capacityBytes: DEFAULT_POLICY.storeCapacityBytes, recoveryBudgetBytes: DEFAULT_POLICY.recoveryBudgetBytes, minRetentionMs: DEFAULT_POLICY.minRetentionMs, maxRecoveryAttempts: 3 });
  const bridge = new EurekaBridge({ eureka: new EurekaGateway({ http: server, now: () => clock.nowMs(), allowWrites: true }), store, clock, defaultProcessId: 'general-work-v1@10204' });
  return { server, bridge };
}

const req = (requestId: string, operationId: string, op: string, heads: Record<string, unknown>, approved = true) => ({
  requestId,
  operationId,
  decision: { headOutputs: Object.fromEntries(Object.entries({ intention: `eureka.${op}`, modelIntention: 'eureka', operation: op, ...heads }).map(([k, v]) => [k, { value: v, confidence: 0.95 }])), overallConfidence: 0.9, missingRequiredSlots: [], route: 'eureka' },
  deadlineAt: DEADLINE,
  mutationApproved: approved,
});

describe('EurekaBridge 보완', () => {
  it('같은 operationId로 다른 대상·작업이 오면 이전 결과를 주지 않고 거절한다. 같은 요청이면 기록된 결과', async () => {
    const { bridge, server } = bridgeSetup();
    const first = await bridge.execute(req('R1', 'OP1', 'complete', { target: '보고서 제출' }));
    expect(first.status).toBe('succeeded');
    const same = await bridge.execute(req('R1', 'OP1', 'complete', { target: '보고서 제출' }));
    expect(same.status).toBe('succeeded');
    const other = await bridge.execute(req('R1', 'OP1', 'postpone', { target: '보고서 제출', dueAt: '2026-10-09T23:59:00+09:00' }));
    expect(other).toMatchObject({ status: 'failed', error: { code: 'OPERATION_ID_REUSED' } });
    expect(server.writeCount('/_api_/items')).toBe(1);
  });

  it('결과 조회는 operationId가 정확히 맞는 기록만 본다 (다른 작업 결과로 대신하지 않음)', async () => {
    const { bridge } = bridgeSetup();
    await bridge.execute(req('R2', 'OP-A', 'complete', { target: '보고서 제출' }));
    const r = await bridge.reconcile({ requestId: 'R2', operationId: 'OP-B', decision: req('R2', 'OP-B', 'query', {}).decision, deadlineAt: DEADLINE });
    expect(r).toMatchObject({ status: 'unknown', error: { code: 'RECONCILIATION_UNAVAILABLE' } });
  });

  it('업무 등록 결과에 새 itemId가 들어간다', async () => {
    const { bridge } = bridgeSetup();
    const r = await bridge.execute(req('R3', 'OP3', 'create', { task: '발표 준비' }));
    expect(r.status).toBe('succeeded');
    expect(r.facts['itemId']).toBeTruthy();
  });

  it('단계 기록 추가 응답이 유실되면 결과 조회에서 같은 내용의 기록을 후보로 찾는다 (다시 보내지 않음)', async () => {
    const { bridge, server } = bridgeSetup();
    server.injectFault((r) => r.method === 'POST' && r.path === '/_api_/stages/20011/note', { kind: 'drop_after_apply' });
    const r = await bridge.execute(req('R4', 'OP4', 'add_note', { target: '보고서 제출', note: '초안 공유' }));
    expect(r.status).toBe('unknown');
    const rec = await bridge.reconcile({ requestId: 'R4', operationId: 'OP4', decision: req('R4', 'OP4', 'add_note', {}).decision, deadlineAt: DEADLINE });
    expect(rec.facts).toMatchObject({ linkage: 'candidate_only', recovery: 'still_unknown' });
    expect(server.writeCount('/_api_/stages/20011/note')).toBe(1);
  });
});

describe('업무 연결이 없을 때 단계 기록에서 연결 단계 찾기', () => {
  const noRefs = () => ({ ...prContext(), taskRefs: [] });

  async function approveWithoutRefs(w: ReturnType<typeof createWorld>) {
    await w.harness.handle(harnessRequest('req-r', voiceTurn('t-r1', '그 PR 리뷰해서 읽어줘', { intention: 'llm' }), noRefs()));
    const q = await w.harness.handle(harnessRequest('req-a', voiceTurn('t-a1', '그 PR 승인해줘', { intention: 'llm' }), noRefs()));
    return answer(w, q, '응, 승인해');
  }

  it('기록에 이 PR 주소가 있는 단계가 하나면 그 단계로 Eureka 반영 질문을 한다', async () => {
    const w = createWorld();
    w.eurekaServer.items.get('1000006')!.stages.find((s) => s.id === STAGE_ID)!.notes = [{ id: '700', content: `PR: ${prUrl}` }];
    const r = await approveWithoutRefs(w);
    expect(r.actionResults.find((a) => a.action === 'submit_approval')).toMatchObject({ action: 'submit_approval', status: 'succeeded' });
    expect(r.pending?.purpose).toBe('confirm_stage_completion');
  });

  it('기록이 없으면 지금처럼 건너뛰고, 두 단계에 있으면 추측하지 않는다', async () => {
    const w = createWorld();
    const r = await approveWithoutRefs(w);
    expect(r.facts['followUp']).toMatchObject({ eligibility: 'not_applicable', reason: 'no_linked_eureka_stage' });

    const w2 = createWorld();
    w2.eurekaServer.addItem({ id: '1000099', name: '다른 업무', stages: [{ id: '1000991', name: '검토', status: 'doing', order: 1, notes: [{ id: '701', content: prUrl }] }] });
    w2.eurekaServer.items.get('1000006')!.stages.find((s) => s.id === STAGE_ID)!.notes = [{ id: '702', content: prUrl }];
    const r2 = await approveWithoutRefs(w2);
    expect(r2.facts['followUp']).toMatchObject({ eligibility: 'not_applicable', reason: 'linked_stage_ambiguous' });
  });
});

describe('파이프라인 미연결 때 알림 보관', () => {
  it('받을 연결이 없으면 보관했다가 다음 pipeline 연결 직후 한 번 보낸다', async () => {
    const { HarnessWsServer, DirectHarnessInbound } = await import('@deskpet/server');
    const { OutputService } = await import('@deskpet/output');
    const w = createWorld();
    const TOKEN = 'held-notice-token-0123456789';
    const server = new HarnessWsServer({ inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }), store: w.store, token: TOKEN, port: 0 });
    const { port } = await server.start();
    try {
      expect(server.notify({ noticeId: 'n1' }, '늦게 끝난 결과')).toBe(0);
      expect(server.heldNoticeCount()).toBe(1);
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const frames: Record<string, unknown>[] = [];
      ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>));
      await new Promise<void>((r) => ws.addEventListener('open', () => r(), { once: true }));
      ws.send(JSON.stringify({ type: 'hello', token: TOKEN, role: 'pipeline' }));
      for (let i = 0; i < 100 && !frames.some((f) => f['type'] === 'notice'); i++) await new Promise((r) => setTimeout(r, 10));
      expect(frames.find((f) => f['type'] === 'notice')).toMatchObject({ notice: { noticeId: 'n1' }, resultText: '늦게 끝난 결과', held: true });
      expect(server.heldNoticeCount()).toBe(0);
      ws.close();
    } finally {
      await server.stop(500);
    }
  });
});

describe('업무 수정 시각 보존', () => {
  it('Eureka 응답의 updatedAt을 ISO 시각으로 남긴다', async () => {
    const { normalizeItem } = await import('@deskpet/gateways');
    const t = normalizeItem({ id: 1, name: '업무', updatedAt: Date.parse('2026-11-08T01:00:00Z'), 'stage$$': [] });
    expect(t.updatedAt).toBe('2026-11-08T01:00:00.000Z');
    expect(normalizeItem({ id: 2, name: '업무', 'stage$$': [] }).updatedAt).toBeUndefined();
  });
});
