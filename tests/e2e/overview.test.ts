import { describe, expect, it } from 'vitest';
import { EurekaGateway, FakeEurekaServer } from '@deskpet/gateways';
import { FakeClock } from '@deskpet/harness';
import { OverviewService, parseRepoList } from '@deskpet/server';
import { dDay, pickFocus } from '../../apps/web/src/lib/server-info.js';
import { T0 } from '../support/builders.js';
import { fakeGitHub, goldenPr } from '../support/github.js';

/**
 * D-51 웹 현황 (2026-11-14 사용자 결정): 진행 중 업무 하나 + 리마인더 + 링크(Eureka 홈, 저장소·열린 PR). 읽기만 한다
 */
const DAY = 86_400_000;

function setup(o: { failList?: boolean } = {}) {
  const clock = new FakeClock(T0);
  const server = new FakeEurekaServer(() => clock.nowMs());
  server.addItem({ id: 'a', name: '할 일만 있는 업무', dueAt: clock.nowMs() + 2 * DAY, stages: [{ id: 'a1', name: '시작', status: 'todo', order: 1 }] });
  server.addItem({
    id: 'b',
    name: '진행 중 업무',
    dueAt: clock.nowMs() + 20 * DAY,
    stages: [
      { id: 'b1', name: '설계', status: 'done', order: 1 },
      { id: 'b2', name: '구현', status: 'doing', order: 2, notes: [{ id: 'n1', content: 'PR https://github.com/NewLine/DeskPet/pull/42 그리고 https://github.com/evil/repo/pull/9' }] },
      { id: 'b3', name: '검토', status: 'todo', order: 3 },
    ],
  });
  server.addItem({ id: 'c', name: '마감 지난 업무', dueAt: clock.nowMs() - DAY, stages: [{ id: 'c1', name: '하기', status: 'todo', order: 1 }] });
  server.addItem({ id: 'd', name: '끝난 업무', stages: [{ id: 'd1', name: '끝', status: 'done', order: 1 }] });
  const eureka = new EurekaGateway({ http: server, now: () => clock.nowMs() });
  if (o.failList) eureka.listTasks = async () => ({ ok: false, result: { error: { provisionalCode: 'EUREKA_AUTH_ERROR' } } }) as never;
  const github = fakeGitHub('rest', () => clock.nowMs(), goldenPr());
  github.openPrs = [{ number: 42, title: 'feat', author: 'hansol', url: 'u', draft: false, reviewRequested: true }];
  const changes: number[] = [];
  const svc = new OverviewService({
    eureka,
    github,
    repos: [{ owner: 'NewLine', name: 'DeskPet' }],
    allowedRepositories: ['NewLine/DeskPet'],
    eurekaWebUrl: 'https://eureka.example',
    now: () => clock.nowMs(),
    onChange: () => changes.push(1),
  });
  return { svc, clock, github, changes };
}

describe('웹 현황 (D-51)', () => {
  it('열린 업무만, 진행 중 업무를 먼저 고르고 단계·연결 PR 상태를 붙인다', async () => {
    const { svc } = setup();
    await svc.refresh(true);
    const o = svc.get();
    expect(o.state).toBe('ok');
    expect(o.items.map((i) => i.itemId)).toEqual(['b', 'c', 'a']);
    expect(o.autoFocusId).toBe('b');
    const b = o.items[0]!;
    expect(b).toMatchObject({ doneStages: 1, currentStage: '구현' });
    // 허용 저장소 밖 PR(evil/repo)은 빼고, PR 상태·제목을 GitHub에서 읽어 붙인다
    expect(b.prs).toHaveLength(1);
    expect(b.prs[0]).toMatchObject({ owner: 'NewLine', name: 'DeskPet', prNumber: 42, stageName: '구현', state: 'open' });
    expect(b.prs[0]!.title).toBeTruthy();
  });

  it('리마인더: 마감이 지났거나 7일 안, 가까운 순', async () => {
    const { svc } = setup();
    await svc.refresh(true);
    expect(svc.get().reminders.map((r) => [r.itemId, r.overdue])).toEqual([
      ['c', true],
      ['a', false],
    ]);
  });

  it('리마인더: 끝나지 않은 단계의 마감도 단계 이름과 함께 (2026-11-14)', async () => {
    const { svc, clock } = setup();
    const s = (svc as unknown as { opt: { eureka: { o: { http: FakeEurekaServer } } } }).opt.eureka.o.http;
    s.addItem({ id: 'e', name: '발표 준비', stages: [{ id: 'e1', name: '자료', status: 'todo', order: 1, dueAt: clock.nowMs() + 2 * DAY }, { id: 'e2', name: '끝난 단계', status: 'done', order: 2, dueAt: clock.nowMs() + DAY }] });
    await svc.refresh(true);
    const r = svc.get().reminders.filter((x) => x.itemId === 'e');
    expect(r).toEqual([expect.objectContaining({ name: '발표 준비', stageName: '자료', overdue: false, daysLeft: 2 })]);
    expect(svc.get().items.find((i) => i.itemId === 'e')!.stages[0]!.dueAt).toBeTruthy();
  });

  it('링크: Eureka 홈, 저장소와 열린 PR', async () => {
    const { svc } = setup();
    await svc.refresh(true);
    expect(svc.get().links).toMatchObject({ eurekaWebUrl: 'https://eureka.example', repos: [{ owner: 'NewLine', name: 'DeskPet', url: 'https://github.com/NewLine/DeskPet', openPrs: [{ number: 42, reviewRequested: true }] }] });
  });

  it('한쪽이 실패해도 나머지를 보여 주고 이유를 남긴다', async () => {
    const { svc, github } = setup({ failList: true });
    github.failNextRead('open_prs', 'not_found');
    await svc.refresh(true);
    const o = svc.get();
    expect(o.items).toEqual([]);
    expect(o.problems[0]).toContain('EUREKA_AUTH_ERROR');
    expect(o.links.repos[0]!.error).toContain('저장소를 찾지 못했어요');
    expect(o.state).toBe('failed');
  });

  it('수동 새로 고침은 30초 안에 다시 누르면 건너뛴다', async () => {
    const { svc, clock, changes } = setup();
    await svc.refresh(true);
    const n = changes.length;
    await svc.refresh();
    expect(changes.length).toBe(n);
    clock.advance(31_000);
    await svc.refresh();
    expect(changes.length).toBeGreaterThan(n);
  });

  it('화면: 고른 업무가 닫혔으면 자동 선택으로, D-day 표기', async () => {
    const { svc, clock } = setup();
    await svc.refresh(true);
    expect(pickFocus(svc.get(), 'a')?.itemId).toBe('a');
    expect(pickFocus(svc.get(), 'd')?.itemId).toBe('b');
    const now = clock.nowMs();
    expect(dDay(new Date(now).toISOString(), now)).toBe('D-day');
    expect(dDay(new Date(now + 3 * DAY).toISOString(), now)).toBe('D-3');
    expect(dDay(new Date(now - 2 * DAY).toISOString(), now)).toBe('2일 지남');
  });

  it('저장소 목록 형식', () => {
    expect(parseRepoList(' NewLine/DeskPet, bad, a/b ')).toEqual([
      { owner: 'NewLine', name: 'DeskPet' },
      { owner: 'a', name: 'b' },
    ]);
  });
});
