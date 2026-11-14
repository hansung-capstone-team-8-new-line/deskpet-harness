import { describe, expect, it } from 'vitest';
import { EurekaGateway, FakeEurekaServer } from '@deskpet/gateways';
import { DEFAULT_POLICY, FakeClock, InMemoryOperationStore, SequentialIdGen } from '@deskpet/harness';
import { EurekaBridge, PrAutoLinker, findMarkers } from '@deskpet/server';
import { T0 } from '../support/builders.js';
import { fakeGitHub, goldenPr } from '../support/github.js';

/** D-57 PR ↔ Eureka 자동 연결 (A: EU-업무번호 표시, C: 단계 기록에 PR 주소 자동 기록) */
describe('Eureka 표시 찾기', () => {
  it('제목·본문·브랜치의 EU-업무번호[.단계순서], 대소문자 무시, 단계 번호가 있는 쪽 우선', () => {
    expect(findMarkers('[EU-1000074] 케이스 도면')).toEqual([{ itemId: '1000074' }]);
    expect(findMarkers('도면', 'Eureka: EU-1000074.2', 'eu-1000074/case')).toEqual([{ itemId: '1000074', stageOrder: 2 }]);
    expect(findMarkers('no marker', 'EU- 비어 있음', 'feature/x')).toEqual([]);
    expect(findMarkers('EU-1000074 and EU-1000075')).toHaveLength(2);
    // 다른 낱말의 일부(DEU-)는 표시가 아니다
    expect(findMarkers('DEU-1000074')).toEqual([]);
  });
});

function setup() {
  const clock = new FakeClock(T0);
  const server = new FakeEurekaServer(() => clock.nowMs());
  server.addItem({ id: '1000074', name: '시연 업무', stages: [{ id: 's1', name: '자료', status: 'done', order: 1 }, { id: 's2', name: '케이스', status: 'doing', order: 2 }, { id: 's3', name: '보고서', status: 'todo', order: 3 }] });
  server.addItem({ id: '1000080', name: '끝난 업무', stages: [{ id: 'z1', name: '끝', status: 'done', order: 1 }] });
  const store = new InMemoryOperationStore({ clock, ids: new SequentialIdGen(), capacityBytes: DEFAULT_POLICY.storeCapacityBytes, recoveryBudgetBytes: DEFAULT_POLICY.recoveryBudgetBytes, minRetentionMs: DEFAULT_POLICY.minRetentionMs, maxRecoveryAttempts: 3 });
  const eureka = new EurekaGateway({ http: server, now: () => clock.nowMs(), allowWrites: true });
  const bridge = new EurekaBridge({ eureka, store, clock });
  const github = fakeGitHub('rest', () => clock.nowMs(), goldenPr());
  const pr = (number: number, title: string, extra: { body?: string; branch?: string } = {}) => ({ number, title, author: 'hansol', url: `https://github.com/NewLine/DeskPet/pull/${number}`, draft: false, reviewRequested: false, ...extra });
  const linker = new PrAutoLinker({ github, bridge, repos: () => [{ owner: 'NewLine', name: 'DeskPet' }], now: () => clock.nowMs() });
  const notes = (stageId: string) => server.items.get('1000074')!.stages.find((s) => s.id === stageId)!.notes ?? [];
  return { server, github, linker, pr, notes, bridge, clock };
}

describe('자동 연결', () => {
  it('표시가 있는 PR을 진행 중 단계(또는 지정 단계) 기록에 한 번만 남기고, 이미 있으면 쓰지 않는다', async () => {
    const { github, linker, pr, notes, server } = setup();
    github.openPrs = [pr(50, '[EU-1000074] 케이스 수정'), pr(51, '보고서', { body: 'Eureka: EU-1000074.3' }), pr(52, '표시 없음')];
    const r = await linker.run();
    expect(r.map((x) => [x.pr, x.outcome])).toEqual([
      ['newline/deskpet#50', 'written'],
      ['newline/deskpet#51', 'written'],
    ]);
    expect(notes('s2').map((n) => n.content)).toEqual(['PR: https://github.com/NewLine/DeskPet/pull/50 (자동 연결: [EU-1000074] 케이스 수정)']);
    expect(notes('s3')[0]!.content).toContain('/pull/51');
    // 다시 돌아도 다시 쓰지 않는다
    await linker.run();
    expect(server.writeCount('/_api_/stages/')).toBe(2);
  });

  it('사람이 이미 적어 둔 PR, 없는 업무·단계 번호, 여러 업무 표시는 쓰지 않는다', async () => {
    const { github, linker, pr, server } = setup();
    server.items.get('1000074')!.stages[0]!.notes = [{ id: 'n0', content: 'https://github.com/NewLine/DeskPet/pull/60' }];
    github.openPrs = [pr(60, 'EU-1000074 이미 연결'), pr(61, 'EU-9999999 없는 업무'), pr(62, 'EU-1000074.9 없는 단계'), pr(63, 'EU-1000074 EU-1000080 둘')];
    const r = await linker.run();
    expect(r.map((x) => x.outcome)).toEqual(['already_linked', 'skipped', 'skipped', 'skipped']);
    expect(server.writeCount('/_api_/stages/')).toBe(0);
  });

  it('새로 만든 연결기도(서버 재시작) 같은 PR을 다시 쓰지 않는다', async () => {
    const { github, linker, pr, server, bridge, clock } = setup();
    github.openPrs = [pr(70, 'EU-1000074')];
    await linker.run();
    const again = new PrAutoLinker({ github, bridge, repos: () => [{ owner: 'NewLine', name: 'DeskPet' }], now: () => clock.nowMs() });
    expect((await again.run())[0]!.outcome).toBe('already_linked');
    expect(server.writeCount('/_api_/stages/')).toBe(1);
  });
});
