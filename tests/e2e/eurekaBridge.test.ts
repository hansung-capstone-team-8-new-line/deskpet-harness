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
    expect(await bridge.execute(req('eureka.add_task', { name: '보고서 제출' }, { mutationApproved: true }))).toMatchObject({ status: 'failed', error: { code: 'EUREKA_OPERATION_NOT_IMPLEMENTED' } });
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

describe('EurekaAdapter — 라우터 Operation 라벨 (wiki small-router-model, 2026-11-03)', () => {
  it('intention=eureka + operation 라벨을 받는다. query는 대상이 있으면 상태, 없으면 목록', async () => {
    const { bridge } = setup();
    const status = await bridge.execute(req('eureka', { operation: 'query', name: '보고서 제출' }));
    expect(status).toMatchObject({ status: 'succeeded', facts: { itemId: '2001', itemStatus: 'doing' } });
    const list = await bridge.execute(req('eureka', { operation: 'query' }));
    expect(list.facts['count']).toBe('2');
  });

  it('지원하지 않는 라벨은 실행하지 않고, 무엇을 안 했는지·지원 범위를 말한다', async () => {
    const { bridge, server } = setup();
    for (const op of ['add_task', 'move_stage_up', 'nonsense']) {
      const r = await bridge.execute(req('eureka', { operation: op, name: '보고서 제출' }, { mutationApproved: true }));
      // 라우터 24개 라벨 중 미구현은 EUREKA_OPERATION_NOT_IMPLEMENTED, 목록에 없는 값은 POLICY_BLOCKED
      expect(r).toMatchObject({ status: 'failed', error: { code: op === 'nonsense' ? 'POLICY_BLOCKED' : 'EUREKA_OPERATION_NOT_IMPLEMENTED' } });
      expect(r.facts['resultText']).toContain('실행하지 않았어요. 지금은 업무 조회·등록·기한·우선순위·이름 변경·완료·보류·재개·삭제, 단계 시작·되돌리기·건너뛰기와 기록 추가를 할 수 있어요.');
    }
    expect((await bridge.execute(req('eureka', { operation: 'query_actors' }))).facts['resultText']).toContain('담당자 조회는 아직');
    expect(server.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('단계 시작·되돌리기·건너뛰기·update_stage (2026-11-14): 단계를 고르고 묻고 승인 뒤 POST status 1번', async () => {
    const { bridge, server } = setup();
    server.addItem({ id: '2004', name: '세 단계 업무', stages: [{ id: 's1', name: '설계', status: 'done', order: 1 }, { id: 's2', name: '구현', status: 'todo', order: 2 }, { id: 's3', name: '검토', status: 'todo', order: 3 }] });
    // 구형 헤드(modelIntention 없음)라 단계 이름은 stage 헤드. 시작: 이름이 없으면 첫 대기 단계
    expect((await bridge.execute(req('eureka', { operation: 'start_stage', target: '세 단계 업무' }))).facts['question']).toBe("'세 단계 업무' 업무의 '구현' 단계를 시작할까요?");
    expect(await bridge.execute(req('eureka', { operation: 'start_stage', target: '세 단계 업무' }, { mutationApproved: true }))).toMatchObject({ status: 'succeeded', facts: { action: 'set_stage_status', resultText: "'구현' 단계를 시작했어요." } });
    expect(server.items.get('2004')!.stages[1]!.status).toBe('doing');
    // 건너뛰기: 이름 지정
    expect(await bridge.execute(req('eureka', { operation: 'skip_stage', target: '세 단계 업무', stage: '검토' }, { mutationApproved: true }))).toMatchObject({ status: 'succeeded' });
    expect(server.items.get('2004')!.stages[2]!.status).toBe('skip');
    // 되돌리기: 진행 중 단계
    expect(await bridge.execute(req('eureka', { operation: 'reset_stage', target: '세 단계 업무' }, { mutationApproved: true }))).toMatchObject({ status: 'succeeded' });
    expect(server.items.get('2004')!.stages[1]!.status).toBe('todo');
    // update_stage: 상태 낱말이 없으면 묻고, 있으면 그 상태로
    expect((await bridge.execute(req('eureka', { operation: 'update_stage', target: '세 단계 업무', stage: '구현' }))).facts['question']).toContain('어떤 상태로');
    expect(await bridge.execute(req('eureka', { operation: 'update_stage', target: '세 단계 업무', stage: '구현', task: '완료로' }, { mutationApproved: true }))).toMatchObject({ status: 'succeeded' });
    expect(server.items.get('2004')!.stages[1]!.status).toBe('done');
    // 이미 그 상태면 보내지 않는다
    expect(await bridge.execute(req('eureka', { operation: 'update_stage', target: '세 단계 업무', stage: '구현', task: '완료' }, { mutationApproved: true }))).toMatchObject({ status: 'failed', error: { code: 'POLICY_BLOCKED' } });
    expect(server.calls.filter((c) => c.method === 'POST' && c.path.includes('/stages/'))).toHaveLength(4);
  });

  it('우선순위·이름 변경 (2026-11-14): 묻고 승인 뒤 PUT 1번, 모르는 값은 다시 묻는다', async () => {
    const { bridge, server } = setup();
    expect((await bridge.execute(req('eureka', { operation: 'update_priority', target: '보고서 제출', priority: '아무거나' }))).facts['question']).toContain('무엇으로 바꿀까요');
    expect((await bridge.execute(req('eureka', { operation: 'update_priority', target: '보고서 제출', priority: '높음' }))).facts['question']).toBe("'보고서 제출' 업무 우선순위를 높음으로 바꿀까요?");
    expect(await bridge.execute(req('eureka', { operation: 'update_priority', target: '보고서 제출', priority: 'high' }, { mutationApproved: true }))).toMatchObject({ status: 'succeeded', facts: { action: 'set_item_priority' } });
    expect(server.items.get('2001')!.priority).toBe('high');
    expect((await bridge.execute(req('eureka', { operation: 'update_item', target: '보고서 제출', task: '최종 보고서 제출' }))).facts['question']).toBe("'보고서 제출' 업무 이름을 '최종 보고서 제출'로 바꿀까요?");
    expect(await bridge.execute(req('eureka', { operation: 'update_item', target: '보고서 제출', task: '최종 보고서 제출' }, { mutationApproved: true }))).toMatchObject({ status: 'succeeded', facts: { action: 'rename_item' } });
    expect(server.items.get('2001')!.name).toBe('최종 보고서 제출');
  });

  it('hold·resume (2026-11-14): 묻고 승인 뒤 PUT status 1번, 이미 보류·완료면 보내지 않는다', async () => {
    const { bridge, server } = setup();
    const q = await bridge.execute(req('eureka', { operation: 'hold', name: '보고서 제출' }));
    expect(q.facts['question']).toBe("'보고서 제출' 업무를 보류할까요?");
    const h = await bridge.execute(req('eureka', { operation: 'hold', name: '보고서 제출' }, { mutationApproved: true }));
    expect(h).toMatchObject({ status: 'succeeded', facts: { action: 'hold_item', resultText: "'보고서 제출' 업무를 보류했어요." } });
    expect(server.items.get('2001')!.status).toBe('hold');
    expect(await bridge.execute(req('eureka', { operation: 'hold', name: '보고서 제출' }, { mutationApproved: true }))).toMatchObject({ status: 'failed', error: { code: 'POLICY_BLOCKED' } });
    expect((await bridge.execute(req('eureka', { operation: 'resume', name: '보고서 제출' }))).facts['question']).toBe("'보고서 제출' 업무를 다시 진행할까요?");
    const r = await bridge.execute(req('eureka', { operation: 'resume', name: '보고서 제출' }, { mutationApproved: true }));
    expect(r).toMatchObject({ status: 'succeeded', facts: { action: 'resume_item' } });
    expect(server.items.get('2001')!.status).toBe('doing');
    expect(await bridge.execute(req('eureka', { operation: 'hold', name: '끝난 업무' }, { mutationApproved: true }))).toMatchObject({ status: 'failed', error: { code: 'POLICY_BLOCKED' } });
    expect(server.calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });

  it('delete (2026-11-14): 되돌릴 수 없다고 묻고, 승인 뒤 DELETE 1번. 완료된 업무도 지울 수 있고 다시 보내지 않는다', async () => {
    const { bridge, server } = setup();
    const q = await bridge.execute(req('eureka', { operation: 'delete', name: '끝난 업무' }));
    expect(q).toMatchObject({ status: 'needs_clarification' });
    expect(q.facts['question']).toBe("'끝난 업무' 업무를 삭제할까요? 삭제하면 되돌릴 수 없어요.");
    expect(server.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    const r = await bridge.execute(req('eureka', { operation: 'delete', name: '끝난 업무' }, { mutationApproved: true, requestId: 'REQ-DEL', operationId: 'OP-DEL' }));
    expect(r).toMatchObject({ status: 'succeeded', facts: { action: 'delete_item', resultText: "'끝난 업무' 업무를 삭제했어요." } });
    expect(server.items.has('2003')).toBe(false);
    // 같은 operationId 재요청은 기록된 결과를 돌려주고 다시 지우지 않는다
    expect(await bridge.execute(req('eureka', { operation: 'delete', name: '끝난 업무' }, { mutationApproved: true, requestId: 'REQ-DEL', operationId: 'OP-DEL' }))).toMatchObject({ status: 'succeeded' });
    expect(server.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
    // 없는 업무는 묻지도 않는다
    expect(await bridge.execute(req('eureka', { operation: 'delete', name: '끝난 업무' }))).toMatchObject({ status: 'failed', error: { code: 'EUREKA_NOT_FOUND' } });
  });

  it('add_note: 확인 질문 → 승인 뒤 진행 중 단계에 기록 1건. 같은 operationId 재요청은 다시 쓰지 않는다', async () => {
    const { bridge, server } = setup();
    const q = await bridge.execute(req('eureka', { operation: 'add_note', name: '보고서 제출', note: '초안 공유 완료' }));
    expect(q.status).toBe('needs_clarification');
    expect(q.facts['question']).toBe(`'보고서 제출' 업무의 '작성' 단계에 "초안 공유 완료"라고 기록을 남길까요?`);
    expect(server.writeCount('/_api_/stages')).toBe(0);
    const ok = await bridge.execute(req('eureka', { operation: 'add_note', name: '보고서 제출', note: '초안 공유 완료' }, { mutationApproved: true, operationId: 'OP-NOTE', requestId: 'REQ-NOTE' }));
    expect(ok).toMatchObject({ status: 'succeeded', facts: { itemId: '2001', stageId: '20011', resultText: "'작성' 단계에 기록을 남겼어요." } });
    expect(ok.facts['noteId']).toBeTruthy();
    const again = await bridge.execute(req('eureka', { operation: 'add_note', name: '보고서 제출', note: '초안 공유 완료' }, { mutationApproved: true, operationId: 'OP-NOTE', requestId: 'REQ-NOTE' }));
    expect(again.status).toBe('succeeded');
    expect(server.writeCount('/_api_/stages/20011/note')).toBe(1);
  });

  it('add_note: 내용이 없으면 묻고, 없는 단계 이름이면 다시 묻는다', async () => {
    const { bridge } = setup();
    expect((await bridge.execute(req('eureka', { operation: 'add_note', name: '보고서 제출' }))).status).toBe('needs_clarification');
    const r = await bridge.execute(req('eureka', { operation: 'add_note', name: '보고서 제출', note: '메모', stage: '없는 단계' }));
    expect(r.facts['question']).toContain("'없는 단계' 단계를 찾지 못했어요");
  });

  it('query_processes: 업무 유형 목록', async () => {
    const { bridge } = setup();
    const r = await bridge.execute(req('eureka', { operation: 'query_processes' }));
    expect(r).toMatchObject({ status: 'succeeded', facts: { count: '1' } });
    expect(r.facts['resultText']).toBe('등록할 수 있는 업무 유형은 일반 업무예요.');
  });
});

describe('EurekaAdapter — 새 헤드 의미 (wiki interface-contracts 2026-11-01)', () => {
  // 새 형식: intention=eureka.<op>, modelIntention=eureka, operation=<op>. target=업무, name=단계, task=이름·요약, note=설명
  const nreq = (op: string, heads: Record<string, unknown>, o: { mutationApproved?: boolean } = {}) =>
    req(`eureka.${op}`, { modelIntention: 'eureka', operation: op, ...heads }, o);

  it('업무는 target으로 찾는다. name(단계 이름)을 업무 이름으로 쓰지 않는다', async () => {
    const { bridge } = setup();
    const r = await bridge.execute(nreq('query', { target: '보고서 제출', name: '작성' }));
    expect(r).toMatchObject({ status: 'succeeded', facts: { itemId: '2001' } });
    // target 없이 단계 이름만 있으면 업무 대상이 없는 것으로 보고 목록을 준다
    const list = await bridge.execute(nreq('query', { name: '보고서 제출' }));
    expect(list.facts['count']).toBe('2');
  });

  it('add_note: 단계는 name 헤드, 내용은 note 헤드', async () => {
    const { bridge, server } = setup();
    server.items.get('2001')!.stages.push({ id: '20012', name: '검토', status: 'todo', order: 2 });
    const q = await bridge.execute(nreq('add_note', { target: '보고서 제출', name: '검토', note: '피드백 반영 예정' }));
    expect(q.facts['question']).toBe(`'보고서 제출' 업무의 '검토' 단계에 "피드백 반영 예정"라고 기록을 남길까요?`);
  });

  it('create: 새 업무 이름은 task(이름·요약), 없으면 target. task를 업무 유형 이름으로 쓰지 않는다', async () => {
    const { bridge, server } = setup();
    const q = await bridge.execute(nreq('create', { task: '발표 자료 만들기', target: '발표' }));
    expect(q.facts['question']).toBe("'발표 자료 만들기' 업무를 새로 등록할까요?");
    const ok = await bridge.execute(nreq('create', { task: '발표 자료 만들기' }, { mutationApproved: true }));
    expect(ok.status).toBe('succeeded');
    expect(server.calls.find((c) => c.path === '/_api_/items/0/start')?.body).toMatchObject({ processId: 'general-work-v1@10204', name: '발표 자료 만들기' });
    expect(server.calls.some((c) => c.path === '/_api_/processes/0/list')).toBe(false);
  });

  it('구형 형식(modelIntention 없음)은 지금처럼 name을 업무 이름으로 본다', async () => {
    const { bridge } = setup();
    expect(await bridge.execute(req('eureka.status', { name: '보고서 제출' }))).toMatchObject({ status: 'succeeded', facts: { itemId: '2001' } });
  });
});
