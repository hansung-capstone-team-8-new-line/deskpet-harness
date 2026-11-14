/* eslint-disable no-console */
/**
 * 웹 화면 확인용 fixture 서버 — 실제 GitHub·Eureka 없이 여러 상태(완료·실패·결과 불명·확인 대기)를 만들어
 * viewer로 구독할 수 있게 연다. 외부로 아무것도 보내지 않는다.
 *
 *   pnpm web:fixture        # ws://127.0.0.1:8788, 보기 전용 토큰 fixture-viewer-token-123
 *   pnpm web:dev            # 다른 터미널, http://127.0.0.1:5173 에서 위 주소·토큰 입력
 *   pnpm demo:adapter --fixture reminders   # 파이프라인 문서 형식(adapter)도 이 fixture로 시험 (실행용 토큰 fixture-pipeline-token-123)
 */
import { OutputService } from '@deskpet/output';
import { DirectHarnessInbound, EurekaBridge, HarnessWsServer, HistoryLog, OverviewService, PipelineBridge } from '@deskpet/server';
import { answer, askApproval, review } from '../tests/support/flows.js';
import { createWorld } from '../tests/support/world.js';

const VIEWER = 'fixture-viewer-token-123';
const PIPELINE = 'fixture-pipeline-token-123';
const w = createWorld();
// 리마인더 확인용: 설명·마감이 있는 업무 (fixture)
w.eurekaServer.addItem({ id: '2001', name: '보고서 제출', description: '실험 결과를 비교하고 분석 보고서를 제출한다.', dueAt: w.clock.nowMs() + 26 * 3600_000, stages: [{ id: '20011', name: '작성', status: 'doing', order: 1 }] });
// eureka.links 시험용: 골든 업무(ITEM_ID)의 'PR 승인' 단계 기록에 PR 주소 (pnpm demo:adapter --fixture links 1000006)
{
  const golden = [...w.eurekaServer.items.values()].find((i) => i.name === '캡스톤 PR 검토');
  const st = golden?.stages.find((x) => x.name === 'PR 승인');
  if (st) st.notes = [{ id: 'fixture-note-1', content: 'PR: https://github.com/NewLine/DeskPet/pull/42' }];
}
const step = () => w.clock.advance(20_000);

await review(w, 'req-review-1'); // 완료
step();
const q1 = await askApproval(w, 'req-approve-1');
step();
w.github.failNextSubmit('drop_after_apply'); // 전송 후 응답 유실 → 결과 불명
await answer(w, q1, '응, 승인해');
step();
w.github.failNextRead('pr', 'auth'); // 권한 오류 → 실패
await review(w, 'req-review-2');
step();
const q2 = await askApproval(w, 'req-approve-2'); // 확인 대기
await w.deliverQuestion(q2);

// 세션 기록(D-47) 확인용: 지난 세션 몇 건 + 이번 세션 (fixture 문장, 실제 기록 아님)
const ADMIN = 'fixture-admin-token-123';
const history = new HistoryLog();
{
  const prev = '2026-11-13T05:10:00.000Z';
  const old = [
    { at: '2026-11-13T05:11:02.000Z', input: 'PR 42번 리뷰해 줘', route: 'review_pr', status: 'succeeded', resultText: 'PR 42번, 현재 커밋 abc1234 기준이에요. 변경 파일 3개, 차단 수준 지적은 없어요.' },
    { at: '2026-11-13T05:11:40.000Z', input: 'PR 42번 승인해', route: 'approve_pr', status: 'question', resultText: 'NewLine/DeskPet PR 42번을 승인할까요?' },
    { at: '2026-11-13T05:11:52.000Z', input: '응 승인해', route: 'confirm', status: 'succeeded', resultText: 'PR 42번을 승인했어요.', actions: [{ action: 'submit_approval', status: 'succeeded' }] },
  ] as const;
  // 지난 세션 기록은 파일에서 읽은 것처럼 직접 넣는다
  (history as unknown as { entries: unknown[] }).entries.push(
    ...old.map((e, i) => ({ id: `${prev}#${i + 1}`, sessionId: prev, kind: 'harness.run', requestId: `req-old-${i + 1}`, conversationId: 'conv-fixture', inputChannel: 'voice', sttConfidence: 0.91, ms: 1800 + i * 400, ...e })),
  );
  history.append({ kind: 'harness.run', requestId: 'req-now-1', conversationId: 'conv-fixture', input: '보고서 제출 마감 언제야', inputChannel: 'voice', sttConfidence: 0.88, route: 'query_item', status: 'succeeded', resultText: '보고서 제출 마감은 내일 오후 2시예요.', ms: 1320 });
  history.append({ kind: 'harness.run', requestId: 'req-now-2', input: '마감 하루 미뤄 줘', inputChannel: 'voice', sttConfidence: 0.62, route: 'postpone_item', status: 'failed', errorCode: 'LOW_CONFIDENCE', resultText: '잘 못 들었어요. 다시 말해 주세요.', ms: 410 });
}
// 업데이트 알림(D-49)·버튼(D-50) 확인용 가짜 상태. 업데이트를 누르면 단계만 바뀌고 실제로는 아무것도 하지 않는다
let update: Record<string, unknown> = {
  state: 'available',
  canApply: true,
  current: { commit: 'a62ae9c', subject: 'web: 보기 전용 토큰 없이 접속(D-45)', branch: 'app' },
  upstream: 'origin/app',
  behind: 2,
  ahead: 0,
  commits: [
    { sha: 'f00ba12', subject: 'pipeline: QUEUE_FULL 완화' },
    { sha: 'c0ffee1', subject: 'docs: 시연 순서' },
  ],
  checkedAt: new Date().toISOString(),
};
const repos: string[] = ['NewLine/DeskPet'];
let settingsAt: string | undefined;
const info = () => ({ startedAt: history.sessionId, version: update['current'], update, admin: true, history: { persistent: false }, supervised: false, settings: { allowedRepositories: [...repos], source: settingsAt ? 'file' : 'env', persistent: false, ...(settingsAt ? { updatedAt: settingsAt } : {}) } });

// 현황(D-51) 확인용: 가짜 Eureka 업무 + 가짜 GitHub 열린 PR
w.github.openPrs = [
  { number: 42, title: 'feat: 승인 흐름 정리', author: 'hansol', url: 'https://github.com/NewLine/DeskPet/pull/42', draft: false, updatedAt: new Date().toISOString(), reviewRequested: true },
  { number: 43, title: 'wip: 센서 보정', author: 'jongha', url: 'https://github.com/NewLine/DeskPet/pull/43', draft: true, reviewRequested: false },
];
const overview = new OverviewService({
  eureka: w.eurekaGw,
  github: w.github,
  repos: () => repos.map((r) => ({ owner: r.split('/')[0]!, name: r.split('/')[1]! })),
  allowedRepositories: repos,
  eurekaWebUrl: 'https://api.eureka.codes/flw-v1',
  now: () => w.clock.nowMs(),
  onChange: () => server.publishOverview(),
});

const server = new HarnessWsServer({
  history,
  overview,
  info,
  adminToken: ADMIN,
  settings: async (s) => {
    repos.splice(0, repos.length, ...s.allowedRepositories);
    settingsAt = new Date().toISOString();
    server.publishInfo();
    void overview.refresh(true);
    return { ok: true, message: '적용했어요 (fixture — 파일에 저장하지 않음)' };
  },
  admin: async (action) => {
    if (action === 'update.check') return { ok: true, message: 'checked' };
    for (const step of ['새 코드 받기', '웹 화면 빌드']) {
      update = { ...update, state: 'updating', step };
      server.publishInfo();
      await new Promise((r) => setTimeout(r, 800));
    }
    update = { ...update, state: 'restart_required', step: undefined, behind: 0, commits: [], message: 'f00ba12로 업데이트했어요 (fixture — 실제 변경 없음)' };
    server.publishInfo();
    return { ok: true, message: String(update['message']) };
  },
  inbound: new DirectHarnessInbound({
    harness: w.harness,
    output: new OutputService(),
    bridge: new PipelineBridge({ harness: w.harness, store: w.store, output: new OutputService() }),
    // fixture의 Eureka는 가짜 서버라 쓰기도 그 안에서만 일어난다
    eurekaBridge: new EurekaBridge({ eureka: w.eurekaGw, store: w.store, clock: w.clock, defaultProcessId: 'general-work-v1@10204' }),
  }),
  store: w.store,
  token: PIPELINE,
  viewerToken: VIEWER,
  port: Number(process.env['WEB_FIXTURE_PORT']) || 8788,
  allowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'],
  log: (l) => console.log(`[fixture] ${l}`),
});
const { port } = await server.start();
overview.start(60 * 60_000);
console.log(`fixture 서버: ws://127.0.0.1:${port}  보기 전용 토큰: ${VIEWER}  실행용 토큰: ${PIPELINE}  관리 토큰: ${ADMIN}  (fixture 전용 값, 실제 토큰 아님)`);
process.on('SIGINT', () => void server.stop(1_000).then(() => process.exit(0)));
