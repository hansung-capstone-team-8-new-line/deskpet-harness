/* eslint-disable no-console */
/**
 * 시연용 실행 기록 만들기 (2026-11-14). 켜 둔 Harness 서버에 실제 요청을 차례로 보내 웹 '기록' 탭에 여러 결과를 남긴다.
 * 파이프라인 대신 같은 형식으로 보내고, 사용자 발화 문장(transcript)을 같이 실어 기록에 문장이 보이게 한다.
 *
 *   pnpm start                      # 터미널 1
 *   pnpm demo:seed                  # 터미널 2 — 읽기 + 확인 질문 거절만. 외부에 아무것도 바꾸지 않는다
 *   pnpm demo:seed --reminders      # + 리마인더 예시용 시험 업무 3개를 Eureka에 등록 (쓰기 — 마감 1·3·6일 뒤)
 *   pnpm demo:seed --fixture        # pnpm web:fixture 서버(가짜 GitHub·Eureka)로
 *
 * 기록에 남는 결과: 완료(업무 목록·업무 상태·PR 리뷰), 질문함(업무 등록·PR 승인 확인), 실패(없는 업무·지원하지 않는 삭제), 거절 답변
 * .env: HARNESS_WS_URL(기본 ws://127.0.0.1:8787), HARNESS_WS_TOKEN, GITHUB_TEST_REPO(owner/name), GITHUB_TEST_PR
 */
import { HarnessClient, type Reply } from './harnessClient.js';

const fixture = process.argv.includes('--fixture');
const withReminders = process.argv.includes('--reminders');
try {
  process.loadEnvFile('.env');
} catch {
  if (!fixture) console.log('! .env 파일을 찾지 못했어요. app 폴더에서 실행했는지 확인하세요.');
}
const env = process.env;
if (fixture) {
  env['HARNESS_WS_URL'] = 'ws://127.0.0.1:8788';
  env['HARNESS_WS_TOKEN'] = 'fixture-pipeline-token-123';
  env['GITHUB_TEST_REPO'] = 'NewLine/DeskPet';
  env['GITHUB_TEST_PR'] = '42';
}
const fail = (msg: string): never => {
  console.log(`✗ ${msg}`);
  process.exit(1);
};
const token = env['HARNESS_WS_TOKEN']?.trim() || fail('HARNESS_WS_TOKEN이 비어 있어요');
const runId = Date.now().toString(36);
const client = new HarnessClient(env['HARNESS_WS_URL']?.trim() || 'ws://127.0.0.1:8787', runId);
let n = 0;
const id = (p: string) => `seed-${p}-${runId}-${++n}`;
const deadline = (sec = 60) => new Date(Date.now() + sec * 1000).toISOString();
const conversationId = `seed-conv-${runId}`;

type EurekaResult = { status: string; facts: Record<string, string>; error: { code: string } | null };
type RunResult = { action: { status: string; facts: Record<string, string> }; question: string | null; resultText: string | null };

async function call(kind: string, requestId: string, payload: unknown, withDeadline = true): Promise<unknown> {
  const r: Reply = await client.request(kind, requestId, payload, withDeadline ? deadline() : undefined);
  if (!r.ok) throw new Error(`${kind} 거부: ${r.error?.code} ${r.error?.message}`);
  return r.payload;
}

function line(say: string, status: string, text?: string | null) {
  console.log(`  “${say}” → ${status}${text ? ` — ${text}` : ''}`);
}

/** 직접 Eureka 요청 (라우터 형식). transcript는 기록에 문장을 남기기 위한 Harness 확장 필드 */
async function eureka(say: string, operation: string, heads: Record<string, string> = {}, mutationApproved = false) {
  const requestId = id('eureka');
  const all: Record<string, string> = { intention: 'eureka', modelIntention: 'eureka', operation, ...heads };
  const decision = { headOutputs: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { value: v, confidence: 0.95 }])), overallConfidence: 0.93, missingRequiredSlots: [], route: 'eureka' };
  const payload = { requestId, operationId: id('op'), decision, deadlineAt: deadline(), mutationApproved, transcript: { text: say, isFinal: true, sttConfidence: 0.93 } };
  const r = (await call('eureka.execute', requestId, payload)) as EurekaResult;
  line(say, r.error ? `${r.status} (${r.error.code})` : r.status, r.facts['resultText'] ?? r.facts['question']);
  // 확인 질문에 승인 답을 했을 때 파이프라인이 보내는 것처럼: 같은 요청을 mutationApproved=true로, 문장은 답변
  return { r, again: (answer: string) => call('eureka.execute', requestId, { ...payload, mutationApproved: true, transcript: { text: answer, isFinal: true, sttConfidence: 0.95 } }) as Promise<EurekaResult> };
}

async function harnessRun(requestId: string, say: string, intention: string, target: unknown, mutationApproved = false) {
  const transcript = { text: say, isFinal: true, sttConfidence: 0.94 };
  const r = (await call('harness.run', requestId, {
    action: { requestId, operationId: id('op'), decision: { headOutputs: { intention: { value: intention, confidence: 0.95 } }, overallConfidence: 0.93, missingRequiredSlots: [], route: 'harness', resolvedTarget: target }, deadlineAt: deadline() },
    transcript,
    context: { requestId, turnId: id('turn'), transcript, stamp: { conversationId }, turns: [] },
    wikiSearchAllowed: false,
    mutationApproved,
  })) as RunResult;
  line(say, r.action.status, r.question ?? r.resultText);
  return r;
}

async function main() {
  await client.connect(token, 'pipeline');
  console.log(`시연 기록 만들기 (${fixture ? 'fixture' : '실제 서버'})`);

  console.log('\n[Eureka]');
  const list = await eureka('지금 진행 중인 업무 뭐 있어?', 'list');
  // 목록 결과에서 업무 이름 하나를 골라 상태를 묻는다 (없으면 건너뜀)
  let firstName = env['SEED_ITEM_NAME'];
  try {
    firstName ??= (JSON.parse(list.r.facts['items'] ?? '[]') as { name?: string }[])[0]?.name;
  } catch {
    /* 목록 형식이 다르면 건너뜀 */
  }
  if (firstName) await eureka(`${firstName} 업무 어디까지 했어?`, 'query', { target: firstName });
  await eureka('우주선 발사 준비 업무 상태 알려줘', 'query', { target: '우주선 발사 준비' });
  await eureka('그 업무 삭제해 줘', 'delete', { target: '아무 업무' });
  // 확인 질문까지만: 답을 거절하므로 등록하지 않는다
  await eureka('발표 리허설 업무 새로 만들어 줘', 'create', { task: '발표 리허설', dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });

  if (withReminders) {
    console.log('\n[리마인더 예시 업무 등록 — Eureka 쓰기]');
    const plan: [string, number][] = [
      ['[시연] 중간 발표 자료 정리', 1],
      ['[시연] 하드웨어 케이스 출력', 3],
      ['[시연] 최종 보고서 초안', 6],
    ];
    for (const [name, days] of plan) {
      const due = new Date(Date.now() + days * 86_400_000);
      due.setHours(18, 0, 0, 0);
      const q = await eureka(`${name.replace('[시연] ', '')} 업무 ${days}일 뒤 마감으로 등록해 줘`, 'create', { task: name, dueAt: due.toISOString() });
      if (q.r.status === 'needs_clarification') {
        const done = await q.again('응, 등록해');
        line('응, 등록해', done.error ? `${done.status} (${done.error.code})` : done.status, done.facts['resultText']);
      }
    }
  }

  const [owner, name] = (env['GITHUB_TEST_REPO'] ?? '').split('/');
  const prNumber = Number(env['GITHUB_TEST_PR']);
  if (owner && name && prNumber) {
    console.log('\n[GitHub]');
    const target = { kind: 'github_pr', repository: { owner, name }, prNumber };
    await harnessRun(id('review'), `PR ${prNumber}번 리뷰해 줘`, 'pr.review', target);
    const approveId = id('approve');
    const q = await harnessRun(approveId, `PR ${prNumber}번 승인해 줘`, 'pr.approve', target);
    if (q.action.status === 'needs_clarification' && q.question) {
      // 질문이 사용자에게 전달됐다고 보고한 뒤 거절한다 (승인하지 않음)
      const f = q.action.facts;
      await call('pipeline.event', f['harnessRequestId']!, { messageId: id('ev'), requestId: f['harnessRequestId'], pendingId: f['pendingId'], outputId: f['outputId'], sourceRevision: 1, occurredAt: new Date().toISOString(), kind: 'question_delivered', channel: 'speech', deliveredText: q.question }, false);
      await harnessRun(approveId, '아니, 아직 보류해', 'confirm.reject', target);
    }
  } else console.log('\n[GitHub] GITHUB_TEST_REPO·GITHUB_TEST_PR이 없어 PR 기록은 건너뜀');

  console.log('\n끝. 웹 → 기록 탭에서 확인하세요.' + (withReminders ? ' 리마인더는 현황 새로 고침 뒤 작업 탭 아래에 보여요.' : ''));
}

main()
  .catch((e: unknown) => {
    console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => client.close());
