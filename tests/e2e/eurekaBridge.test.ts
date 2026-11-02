import { describe, expect, it } from 'vitest';
import { PipelineActionResult, PipelineRemindersResult, parseEnvelope, type PipelineEurekaActionRequest } from '@deskpet/contracts';
import { EurekaGateway, FakeEurekaServer } from '@deskpet/gateways';
import { DEFAULT_POLICY, FakeClock, InMemoryOperationStore, SequentialIdGen } from '@deskpet/harness';
import { EurekaBridge } from '@deskpet/server';
import { T0 } from '../support/builders.js';

/**
 * 파이프라인 문서의 EurekaAdapter (execute / reconcile / reminders / reminder) — docs/pipeline-bridge.md
 */
const DEADLINE = '2026-10-04T10:05:00.000Z';
const DUE_MS = Date.parse('2026-10-05T14:59:00.000Z'); // 2026-10-05 23:59 KST

function setup(o: { allowWrites?: boolean } = {}) {
  const clock = new FakeClock(T0);
  const server = new FakeEurekaServer(() => clock.nowMs());
  server.addItem({ id: '2001', name: '보고서 제출', description: '실험 결과를 비교하고 분석 보고서를 제출한다.', dueAt: DUE_MS, stages: [{ id: '20011', name: '작성', status: 'doing', order: 1 }] });
  server.addItem({ id: '2002', name: '설명 없는 업무', dueAt: DUE_MS + 3600_000, stages: [{ id: '20021', name: '시작', status: 'todo', order: 1 }] });
  server.addItem({ id: '2003', name: '끝난 업무', description: '이미 끝남', dueAt: DUE_MS, stages: [{ id: '20031', name: '끝', status: 'done', order: 1 }] });
  const store = new InMemoryOperationStore({ clock, ids: new SequentialIdGen(), capacityBytes: DEFAULT_POLICY.storeCapacityBytes, recoveryBudgetBytes: DEFAULT_POLICY.recoveryBudgetBytes, minRetentionMs: DEFAULT_POLICY.minRetentionMs, maxRecoveryAttempts: 3 });
  const eureka = new EurekaGateway({ http: server, now: () => clock.nowMs(), allowWrites: o.allowWrites ?? true });
  const bridge = new EurekaBridge({ eureka, store, clock, defaultProcessId: 'general-work-v1@10204' });
  return { clock, server, store, bridge };
}

let n = 0;
function req(intention: string, heads: Record<string, unknown> = {}, o: { mutationApproved?: boolean; requestId?: string; operationId?: string; resolvedTarget?: unknown } = {}): PipelineEurekaActionRequest {
  n += 1;
  return {
    requestId: o.requestId ?? `REQ-E${n}`,
    operationId: o.operationId ?? `OP-E${n}`,
    decision: {
      headOutputs: Object.fromEntries([['intention', { value: intention, confidence: 0.95 }], ...Object.entries(heads).map(([k, v]) => [k, { value: v, confidence: 0.9 }])]),
      overallConfidence: 0.93,
      missingRequiredSlots: [],
      route: 'eureka',
      ...(o.resolvedTarget ? { resolvedTarget: o.resolvedTarget } : {}),
    },
    deadlineAt: DEADLINE,
    mutationApproved: o.mutationApproved ?? false,
  };
}

describe('EurekaAdapter — 조회', () => {
  it('목록: 열린 업무 수와 가장 가까운 마감을 고정 문장으로 준다', async () => {
    const { bridge } = setup();
    const r = PipelineActionResult.parse(await bridge.execute(req('eureka.list')));
    expect(r.status).toBe('succeeded');
    expect(r.facts['count']).toBe('2');
    expect(r.facts['resultText']).toBe("진행 중인 업무가 2개 있어요. 마감이 가장 가까운 건 '보고서 제출'이고 2026년 10월 5일 밤 11시 59분까지예요.");
  });

  it('상태: 이름으로 업무를 찾아 단계 진행을 알려 준다. 없는 이름은 찾지 못했다고 한다', async () => {
    const { bridge } = setup();
    const r = await bridge.execute(req('eureka.status', { name: '보고서 제출' }));
    expect(r).toMatchObject({ status: 'succeeded', facts: { itemId: '2001', itemStatus: 'doing' } });
    expect(r.facts['resultText']).toContain("'보고서 제출' 업무는 진행 중이고, 단계 1개 중 0개가 끝났어요.");
    expect(await bridge.execute(req('eureka.status', { name: '없는 업무' }))).toMatchObject({ status: 'failed', error: { code: 'EUREKA_NOT_FOUND' } });
  });

  it('리마인더: 설명과 시간대가 붙은 마감이 있는 열린 업무만. 설명 없는 업무는 업무명으로 대체하지 않고 뺀다', async () => {
    const { bridge } = setup();
    const r = PipelineRemindersResult.parse(await bridge.reminders(DEADLINE));
    expect(r.items).toEqual([
      { itemId: '2001', reminderKey: '2001:2026-10-05T23:59:00+09:00', name: '보고서 제출', description: '실험 결과를 비교하고 분석 보고서를 제출한다.', dueAt: '2026-10-05T23:59:00+09:00', timezone: 'Asia/Seoul', state: 'doing' },
    ]);
    expect(r.skipped).toBe(1);
    expect(await bridge.reminder('2001', DEADLINE)).toMatchObject({ itemId: '2001' });
    expect(await bridge.reminder('2002', DEADLINE)).toBeNull();
    expect(await bridge.reminder('2003', DEADLINE)).toBeNull();
  });
});

describe('EurekaAdapter — 쓰기 (직접 경로)', () => {
  const newDue = '2026-10-09T23:59:00+09:00';

  it('mutationApproved가 없으면 보내지 않고 고정 확인 질문을 돌려준다', async () => {
    const { bridge, server } = setup();
    const r = await bridge.execute(req('eureka.postpone', { name: '보고서 제출', dueAt: newDue }));
    expect(r).toMatchObject({ status: 'needs_clarification', facts: { questionKind: 'confirmation', question: "'보고서 제출' 업무 마감을 2026년 10월 9일 밤 11시 59분으로 바꿀까요?", dueAt: newDue } });
    expect(server.writeCount('/')).toBe(0);
  });

  it('승인되면 operation을 기록하고 한 번 보낸다. 같은 operationId 재요청은 다시 보내지 않는다', async () => {
    const { bridge, server, store } = setup();
    const a = req('eureka.postpone', { name: '보고서 제출', dueAt: newDue }, { mutationApproved: true, requestId: 'REQ-P', operationId: 'OP-P' });
    const r = await bridge.execute(a);
    expect(r).toMatchObject({ operationId: 'OP-P', status: 'succeeded', facts: { action: 'postpone_item', itemId: '2001', dueAt: newDue } });
    expect(r.facts['resultText']).toBe("'보고서 제출' 업무 마감을 2026년 10월 9일 밤 11시 59분으로 바꿨어요.");
    expect(server.writeCount('/_api_/items/2001')).toBe(1);
    const ops = await store.listOperations('REQ-P');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ owner: 'pipeline_eureka_module', action: 'postpone_item', recovery: 'none' });
    const again = await bridge.execute(a);
    expect(again.status).toBe('succeeded');
    expect(server.writeCount('/')).toBe(1);
  });

  it('응답 유실은 unknown, reconcile은 조회만 하고 다시 보내지 않는다', async () => {
    const { bridge, server } = setup();
    server.injectFault((r) => r.method === 'PUT', { kind: 'drop_after_apply' });
    const a = req('eureka.postpone', { name: '보고서 제출', dueAt: newDue }, { mutationApproved: true, requestId: 'REQ-U', operationId: 'OP-U' });
    const r = await bridge.execute(a);
    expect(r.status).toBe('unknown');
    expect(r.facts['resultText']).toBe("'보고서 제출' 업무 마감 변경 결과를 아직 확인하지 못했어요. 다시 보내지 않고 상태를 확인할게요.");
    const rec = await bridge.reconcile({ ...a, operationId: 'OP-U' });
    // 마감이 요청 값과 같아도 Eureka에 멱등키가 없어 후보 수준 → unknown 유지 (README C-09)
    expect(rec).toMatchObject({ status: 'unknown', facts: { linkage: 'candidate_only', currentDueAt: newDue } });
    expect(server.writeCount('/')).toBe(1);
  });

  it('쓰기가 꺼져 있으면 보내지 않았다고 말한다', async () => {
    const { bridge, server } = setup({ allowWrites: false });
    const r = await bridge.execute(req('eureka.complete', { name: '보고서 제출' }, { mutationApproved: true }));
    expect(r).toMatchObject({ status: 'failed', error: { code: 'POLICY_BLOCKED' } });
    expect(r.facts['resultText']).toBe("쓰기가 꺼져 있어서 '보고서 제출' 업무 완료 처리 요청은 보내지 않았어요.");
    expect(server.writeCount('/')).toBe(0);
  });

  it('등록: 기본 프로세스로 등록하고 새 itemId를 증거로 남긴다', async () => {
    const { bridge, server } = setup();
    const ask = await bridge.execute(req('eureka.register', { name: '발표 자료', dueAt: newDue }));
    expect(ask.facts['question']).toBe("'발표 자료' 업무를 마감 2026년 10월 9일 밤 11시 59분으로 새로 등록할까요?");
    const r = await bridge.execute(req('eureka.register', { name: '발표 자료', dueAt: newDue }, { mutationApproved: true }));
    expect(r).toMatchObject({ status: 'succeeded', facts: { action: 'register_item' } });
    expect(server.writeCount('/_api_/items/0/start')).toBe(1);
  });

  it('지원하지 않는 의도·빠진 슬롯·시간대 없는 마감은 보내지 않는다', async () => {
    const { bridge, server } = setup();
    expect(await bridge.execute(req('eureka.delete', { name: '보고서 제출' }, { mutationApproved: true }))).toMatchObject({ status: 'failed', error: { code: 'POLICY_BLOCKED' } });
    expect(await bridge.execute(req('eureka.postpone', { name: '보고서 제출', dueAt: '2026-10-09 23:59' }, { mutationApproved: true }))).toMatchObject({ status: 'needs_clarification' });
    expect(server.writeCount('/')).toBe(0);
  });
});

describe('EurekaAdapter — 봉투', () => {
  it('eureka.execute는 deadlineAt 필수, 봉투 requestId와 payload requestId가 같아야 한다', () => {
    const payload = req('eureka.list', {}, { requestId: 'REQ-ENV' });
    const env = { schemaVersion: '1.0', messageId: 'm-1', kind: 'eureka.execute', requestId: 'REQ-ENV', createdAt: T0, deadlineAt: DEADLINE, payload };
    expect(parseEnvelope(env).ok).toBe(true);
    expect(parseEnvelope({ ...env, deadlineAt: undefined }).ok).toBe(false);
    expect(parseEnvelope({ ...env, requestId: 'REQ-OTHER' }).ok).toBe(false);
    expect(parseEnvelope({ ...env, kind: 'eureka.reminders', payload: { requestId: 'REQ-ENV' } }).ok).toBe(true);
  });
});
