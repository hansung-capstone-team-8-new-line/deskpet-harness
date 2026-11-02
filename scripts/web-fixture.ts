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
import { DirectHarnessInbound, EurekaBridge, HarnessWsServer, PipelineBridge } from '@deskpet/server';
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

const server = new HarnessWsServer({
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
console.log(`fixture 서버: ws://127.0.0.1:${port}  보기 전용 토큰: ${VIEWER}  실행용 토큰: ${PIPELINE}  (fixture 전용 값, 실제 토큰 아님)`);
process.on('SIGINT', () => void server.stop(1_000).then(() => process.exit(0)));
