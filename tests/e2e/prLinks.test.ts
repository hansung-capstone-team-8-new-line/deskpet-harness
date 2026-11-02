import { describe, expect, it } from 'vitest';
import { PipelineHarnessResult, PrLinkLookup, extractPrLinks, parseEnvelope, type PipelineHarnessRequest } from '@deskpet/contracts';
import { OutputService } from '@deskpet/output';
import { EurekaGateway, FakeEurekaServer, type FakeStage } from '@deskpet/gateways';
import { DEFAULT_POLICY, FakeClock, InMemoryOperationStore, SequentialIdGen } from '@deskpet/harness';
import { EurekaBridge, PipelineBridge, harnessContextFromLink } from '@deskpet/server';
import { ITEM_ID, PR, REPO, STAGE_ID, T0 } from '../support/builders.js';
import { createWorld } from '../support/world.js';

/**
 * G-01 시작부: Eureka 업무 단계 기록(note)에 적힌 PR 주소로 연결된 PR을 찾는다 (eureka.links, P-19)
 */
const DEADLINE = '2026-10-04T10:05:00.000Z';
const PR15 = 'https://github.com/ehgjs0866/personal_MCP_test/pull/15';

function setup(stages: FakeStage[]) {
  const clock = new FakeClock(T0);
  const server = new FakeEurekaServer(() => clock.nowMs());
  server.addItem({ id: '1000020', name: 'LLM_Test_only', dueAt: Date.parse('2026-10-05T14:59:00.000Z'), stages });
  const store = new InMemoryOperationStore({ clock, ids: new SequentialIdGen(), capacityBytes: DEFAULT_POLICY.storeCapacityBytes, recoveryBudgetBytes: DEFAULT_POLICY.recoveryBudgetBytes, minRetentionMs: DEFAULT_POLICY.minRetentionMs, maxRecoveryAttempts: 3 });
  const eureka = new EurekaGateway({ http: server, now: () => clock.nowMs() });
  return { server, bridge: new EurekaBridge({ eureka, store, clock }) };
}

describe('extractPrLinks — 기록 본문에서 PR 주소만 뽑는다', () => {
  it('PR 주소만 뽑고 같은 PR은 하나로 합친다', () => {
    expect(extractPrLinks(`PR: ${PR15}\n다시: ${PR15}/files 그리고 https://github.com/a/b/pull/2`)).toEqual([
      { owner: 'ehgjs0866', name: 'personal_MCP_test', prNumber: 15, url: PR15 },
      { owner: 'a', name: 'b', prNumber: 2, url: 'https://github.com/a/b/pull/2' },
    ]);
  });
  it('PR이 아닌 주소·http·다른 호스트·숫자 아닌 번호는 무시한다', () => {
    expect(extractPrLinks('https://github.com/a/b 와 https://github.com/a/b/issues/3 와 http://github.com/a/b/pull/4 와 https://evil.example/a/b/pull/5 와 https://github.com/a/b/pull/x')).toEqual([]);
  });
  it('주소 뒤에 다른 경로가 이어지면(/pull/15abc) PR로 보지 않는다', () => {
    expect(extractPrLinks('https://github.com/a/b/pull/15abc')).toEqual([]);
  });
});

describe('eureka.links — 업무 단계 기록 → 연결된 PR', () => {
  it('기록 하나에 PR 하나: linked. 그 기록이 붙은 단계를 함께 준다. 기록 원문은 결과에 없다', async () => {
    const { bridge } = setup([
      { id: '1000195', name: '목표와 범위 정리', status: 'done', order: 1, notes: [{ id: 'n1', content: '기록 테스트' }] },
      { id: '1000196', name: '실행', status: 'todo', order: 2, notes: [{ id: '1000018', content: `PR: ${PR15}` }, { id: '1000017', content: `PR: ${PR15}` }] },
      { id: '1000197', name: '검토와 보완', status: 'todo', order: 3 },
    ]);
    const r = PrLinkLookup.parse(await bridge.links('1000020', DEADLINE));
    expect(r.status).toBe('linked');
    expect(r.links).toEqual([
      { repository: { owner: 'ehgjs0866', name: 'personal_MCP_test' }, prNumber: 15, url: PR15, itemId: '1000020', stageId: '1000196', stageName: '실행', stageStatus: 'todo', noteId: '1000018' },
    ]);
    expect(JSON.stringify(r)).not.toContain('PR: ');
  });

  it('서로 다른 PR 또는 같은 PR이 두 단계에: ambiguous, 후보 전체를 준다 (추측하지 않음)', async () => {
    const a = setup([
      { id: 's1', name: '실행', status: 'todo', order: 1, notes: [{ id: 'n1', content: `${PR15} https://github.com/a/b/pull/2` }] },
    ]);
    const ra = await a.bridge.links('1000020', DEADLINE);
    expect(ra.status).toBe('ambiguous');
    expect(ra.links.map((l) => l.prNumber)).toEqual([15, 2]);
    const b = setup([
      { id: 's1', name: '실행', status: 'todo', order: 1, notes: [{ id: 'n1', content: PR15 }] },
      { id: 's2', name: '검토', status: 'todo', order: 2, notes: [{ id: 'n2', content: PR15 }] },
    ]);
    expect((await b.bridge.links('1000020', DEADLINE)).status).toBe('ambiguous');
  });

  it('기록에 PR 없음: none. 기록 없는 단계는 조회하지 않는다', async () => {
    const { bridge, server } = setup([
      { id: 's1', name: '실행', status: 'todo', order: 1, notes: [{ id: 'n1', content: '진행 중' }] },
      { id: 's2', name: '검토', status: 'todo', order: 2 },
    ]);
    expect((await bridge.links('1000020', DEADLINE)).status).toBe('none');
    expect(server.calls.filter((c) => c.path === '/_api_/notes/0/list')).toHaveLength(1);
  });

  it('삭제된 기록은 쓰지 않는다', async () => {
    const { bridge } = setup([{ id: 's1', name: '실행', status: 'todo', order: 1, notes: [{ id: 'n1', content: PR15, deletedAt: 123 }] }]);
    expect((await bridge.links('1000020', DEADLINE)).status).toBe('none');
  });

  it('기록 조회 실패: partial(확정하지 않음). 업무 목록 실패: failed. 없는 업무: not_found', async () => {
    const { bridge, server } = setup([
      { id: 's1', name: '실행', status: 'todo', order: 1, notes: [{ id: 'n1', content: PR15 }] },
      { id: 's2', name: '검토', status: 'todo', order: 2, notes: [{ id: 'n2', content: '메모' }] },
    ]);
    server.injectFault((r) => r.path === '/_api_/notes/0/list' && r.query?.['stageId'] === 's2', { kind: 'status', status: 500, body: '{}' }, 2);
    const r = await bridge.links('1000020', DEADLINE);
    expect(r.status).toBe('partial');
    expect(r.links).toHaveLength(1);
    expect((await bridge.links('9999', DEADLINE)).status).toBe('not_found');
    server.injectFault((r2) => r2.path === '/_api_/items/0/list', { kind: 'status', status: 403, body: '{"message":"Forbidden"}' });
    expect((await bridge.links('1000020', DEADLINE)).status).toBe('failed');
  });

  it('봉투 종류 eureka.links: requestId·itemId가 필요하다', () => {
    const base = { schemaVersion: '1.0', messageId: 'm1', requestId: 'R1', createdAt: T0, kind: 'eureka.links' };
    expect(parseEnvelope({ ...base, payload: { requestId: 'R1', itemId: '1000020' } }).ok).toBe(true);
    expect(parseEnvelope({ ...base, payload: { requestId: 'R1' } }).ok).toBe(false);
  });
});

describe('G-01 시작부: 기록에서 찾은 PR로 리뷰 → 승인 → 그 기록이 붙은 단계 완료', () => {
  it('eureka.links → harness.run(resolvedTarget·taskRefs) → GitHub 승인 → 기록 단계만 done', async () => {
    const w = createWorld();
    const item = w.eurekaServer.items.get(ITEM_ID)!;
    item.stages.find((s) => s.id === STAGE_ID)!.notes = [{ id: 'N-1', content: `이번 단계 PR: https://github.com/${REPO.owner}/${REPO.name}/pull/${PR}` }];
    const eurekaBridge = new EurekaBridge({ eureka: w.eurekaGw, store: w.store, clock: w.clock });
    const bridge = new PipelineBridge({ harness: w.harness, store: w.store, output: new OutputService() });

    const lookup = await eurekaBridge.links(ITEM_ID, DEADLINE);
    expect(lookup).toMatchObject({ status: 'linked', links: [{ prNumber: PR, stageId: STAGE_ID, stageName: 'PR 승인' }] });
    const ctx = harnessContextFromLink(lookup.links[0]!);

    let n = 0;
    let seq = 0;
    const run = (text: string, intention: string, requestId: string, mutationApproved = false): PipelineHarnessRequest => {
      n += 1;
      const transcript = { text, isFinal: true, sttConfidence: 0.95 };
      return {
        action: { requestId, operationId: `OP-L${n}`, decision: { headOutputs: { intention: { value: intention, confidence: 0.95 } }, overallConfidence: 0.95, missingRequiredSlots: [], route: 'harness', resolvedTarget: ctx.resolvedTarget }, deadlineAt: DEADLINE },
        transcript,
        context: { requestId, turnId: `TURN-L${n}`, transcript, stamp: { conversationId: 'conv-link' }, turns: [] },
        wikiSearchAllowed: false,
        mutationApproved,
        taskRefs: ctx.taskRefs,
      } as PipelineHarnessRequest;
    };
    const delivered = async (r: PipelineHarnessResult) => {
      const f = r.action.facts;
      expect(await w.harness.onPipelineEvent({ messageId: `ev-L${++seq}`, requestId: f['harnessRequestId']!, pendingId: f['pendingId']!, outputId: f['outputId']!, sourceRevision: seq, occurredAt: w.clock.nowIso(), kind: 'question_delivered', channel: 'speech', deliveredText: r.question! })).toMatchObject({ applied: true });
    };

    expect((await bridge.run(run('그 PR 리뷰해줘', 'pr.review', 'REQ-L1'))).action.status).toBe('succeeded');
    const ask = PipelineHarnessResult.parse(await bridge.run(run('승인해줘', 'pr.approve', 'REQ-L2')));
    await delivered(ask);
    const approved = PipelineHarnessResult.parse(await bridge.run(run('응, 승인해', 'confirm.approve', 'REQ-L2', true)));
    expect(w.github.submitCount).toBe(1);
    expect(approved.question).toContain("Eureka의 'PR 승인' 단계를 완료로 반영할까요?");
    await delivered(approved);
    const done = PipelineHarnessResult.parse(await bridge.run(run('네', 'confirm.approve', 'REQ-L2', true)));
    expect(done.action).toMatchObject({ status: 'succeeded', facts: { action: 'complete_stage' } });
    expect(w.eurekaServer.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([`/_api_/stages/${STAGE_ID}/status`]);
  });
});
