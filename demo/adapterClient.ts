/* eslint-disable no-console */
/**
 * 파이프라인 문서 형식(adapter) 로컬 시험 클라이언트. Swift 파이프라인 대신 같은 모양의 메시지를 보낸다.
 * demo/ 폴더는 서버와 무관하게 통째로 지울 수 있다. docs/pipeline-bridge.md 참고.
 *
 *   pnpm harness                                         # 다른 터미널에서 먼저 실행
 *   pnpm demo:adapter reminders                          # EurekaAdapter.reminders()
 *   pnpm demo:adapter reminder <itemId>                  # EurekaAdapter.reminder(itemId)
 *   pnpm demo:adapter links <itemId>                     # eureka.links: 단계 기록의 PR 주소 → 연결된 PR (P-19)
 *   pnpm demo:adapter eureka list                        # execute: eureka.list
 *   pnpm demo:adapter eureka status "업무 이름"            # execute: eureka.status
 *   pnpm demo:adapter eureka postpone "업무 이름" 2026-10-20T23:59:00+09:00 [--approve]
 *                                                        # 쓰기: --approve 없으면 확인 질문만, 있어도 서버에서 Eureka 쓰기는 꺼져 있음
 *   pnpm demo:adapter harness [PR번호] [--answer "응, 승인해"]
 *   pnpm demo:adapter harness --item <itemId>            # 위와 같되 대상 PR·완료할 단계를 eureka.links로 찾는다
 *                                                        # HarnessAdapter.run: 리뷰 → 승인 질문 → output.generate → 전달 보고 → 답변
 *
 * .env: HARNESS_WS_URL(기본 ws://127.0.0.1:8787), HARNESS_WS_TOKEN, GITHUB_TEST_REPO, GITHUB_TEST_PR
 *
 * --fixture: pnpm web:fixture 서버(가짜 GitHub·Eureka)에 붙는다. 주소·토큰·PR을 fixture 값으로 바꾼다 (.env 불필요)
 *   pnpm demo:adapter --fixture harness --answer "응, 승인해"
 */
import { createInterface } from 'node:readline/promises';
import { HarnessClient, type Reply } from './harnessClient.js';

try {
  process.loadEnvFile('.env');
} catch {
  if (!process.argv.includes('--fixture')) console.log('! .env 파일을 찾지 못했어요. app 폴더에서 실행했는지 확인하세요.');
}
const env = process.env;
const fixture = process.argv.includes('--fixture');
const args = process.argv.slice(2).filter((a) => a !== '--fixture');
if (fixture) {
  env['HARNESS_WS_URL'] = 'ws://127.0.0.1:8788';
  env['HARNESS_WS_TOKEN'] = 'fixture-pipeline-token-123';
  env['GITHUB_TEST_REPO'] = 'NewLine/DeskPet';
  env['GITHUB_TEST_PR'] = '42';
}
const flag = (f: string) => args.includes(f);
const valueOf = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg: string): never => {
  console.log(`✗ ${msg}`);
  process.exit(1);
};

const token = env['HARNESS_WS_TOKEN']?.trim() || fail('HARNESS_WS_TOKEN이 비어 있어요 (서버와 같은 값)');
const runId = Date.now().toString(36);
const client = new HarnessClient(env['HARNESS_WS_URL']?.trim() || 'ws://127.0.0.1:8787', runId);
const deadline = (sec = 60) => new Date(Date.now() + sec * 1000).toISOString();
let n = 0;
const id = (p: string) => `${p}-${runId}-${++n}`;

async function call(kind: string, requestId: string, payload: unknown, withDeadline = true): Promise<unknown> {
  const r: Reply = await client.request(kind, requestId, payload, withDeadline ? deadline() : undefined);
  if (!r.ok) fail(`${kind} 거부: ${r.error?.code} ${r.error?.message}${r.error?.issues ? ` (${r.error.issues.join('; ')})` : ''}`);
  return r.payload;
}

function show(title: string, v: unknown) {
  console.log(`\n── ${title} ──`);
  console.log(JSON.stringify(v, null, 2));
}

/** 라우터 결과 흉내 (실제 라우터 미연결) */
function decision(intention: string, heads: Record<string, unknown> = {}, resolvedTarget?: unknown) {
  return {
    headOutputs: Object.fromEntries([['intention', { value: intention, confidence: 0.95 }], ...Object.entries(heads).map(([k, v]) => [k, { value: v, confidence: 0.9 }])]),
    overallConfidence: 0.93,
    missingRequiredSlots: [],
    route: intention.split('.')[0] === 'eureka' ? 'eureka' : 'harness',
    ...(resolvedTarget ? { resolvedTarget } : {}),
  };
}

async function ask(q: string): Promise<string | undefined> {
  const preset = valueOf('--answer');
  if (preset !== undefined) {
    console.log(`  > ${preset}  (--answer)`);
    return preset;
  }
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`  ${q}\n  > `);
  rl.close();
  return a.trim() || undefined;
}

// ---------------------------------------------------------------- eureka
async function eureka() {
  const sub = args[1];
  const requestId = id('adapter-eureka');
  if (sub === 'list') return show('eureka.execute (list)', await call('eureka.execute', requestId, { requestId, operationId: id('op'), decision: decision('eureka.list'), deadlineAt: deadline() }));
  const name = args[2] ?? fail('업무 이름이 필요해요 (따옴표로 감싸세요)');
  if (sub === 'status') return show('eureka.execute (status)', await call('eureka.execute', requestId, { requestId, operationId: id('op'), decision: decision('eureka.status', { name }), deadlineAt: deadline() }));
  if (sub === 'postpone') {
    const dueAt = args[3] ?? fail('새 마감이 필요해요 (예: 2026-10-20T23:59:00+09:00)');
    const payload = { requestId, operationId: id('op'), decision: decision('eureka.postpone', { name, dueAt }), deadlineAt: deadline(), mutationApproved: flag('--approve') };
    return show(`eureka.execute (postpone, mutationApproved=${flag('--approve')})`, await call('eureka.execute', requestId, payload));
  }
  fail(`알 수 없는 하위 명령: ${sub ?? '(없음)'} — list | status | postpone`);
}

// --------------------------------------------------------------- harness
async function links(itemId: string) {
  const requestId = id('adapter-links');
  return (await call('eureka.links', requestId, { requestId, itemId }, false)) as {
    status: string;
    links: { repository: { owner: string; name: string }; prNumber: number; itemId: string; stageId: string; stageName: string; noteId: string }[];
  };
}

async function harness() {
  let [owner, repoName] = (env['GITHUB_TEST_REPO'] ?? '').split('/');
  const answerIdx = args.indexOf('--answer');
  const itemIdx = args.indexOf('--item');
  let prNumber = Number(args.find((a, i) => i > 0 && i !== answerIdx + 1 && i !== itemIdx + 1 && /^\d+$/.test(a)) ?? env['GITHUB_TEST_PR']);
  let taskRefs: unknown[] = [];
  if (itemIdx >= 0) {
    const r = await links(args[itemIdx + 1] ?? fail('--item 뒤에 업무 번호가 필요해요'));
    show('0) eureka.links', r);
    if (r.status !== 'linked') fail(`연결된 PR을 하나로 정하지 못했어요 (${r.status})`);
    const l = r.links[0]!;
    [owner, repoName, prNumber] = [l.repository.owner, l.repository.name, l.prNumber];
    taskRefs = [{ itemId: l.itemId, stageId: l.stageId, repository: l.repository, prNumber: l.prNumber, source: { kind: 'eureka', ref: `item:${l.itemId}/stage:${l.stageId}/note:${l.noteId}` } }];
  }
  if (!owner || !repoName) fail('GITHUB_TEST_REPO=owner/name 이 필요해요');
  if (!prNumber) fail('PR 번호가 필요해요');
  const target = { kind: 'github_pr', repository: { owner, name: repoName }, prNumber };
  const conversationId = `adapter-conv-${runId}`;
  const run = (requestId: string, text: string, intention: string, mutationApproved = false) => {
    const transcript = { text, isFinal: true, sttConfidence: 0.95 };
    return call('harness.run', requestId, {
      action: { requestId, operationId: id('op'), decision: decision(intention, {}, target), deadlineAt: deadline() },
      transcript,
      context: { requestId, turnId: id('turn'), transcript, stamp: { conversationId }, turns: [] },
      wikiSearchAllowed: false,
      mutationApproved,
      ...(taskRefs.length ? { taskRefs } : {}),
    }) as Promise<{ action: { status: string; facts: Record<string, string> }; question: string | null; resultText: string | null }>;
  };

  const reviewId = id('adapter-review');
  show('1) harness.run — 리뷰', await run(reviewId, '그 PR 리뷰해줘', 'pr.review'));

  const approveId = id('adapter-approve');
  let r = await run(approveId, '좋아, 그 PR 승인해줘', 'pr.approve');
  show('2) harness.run — 승인 요청', r);
  let seq = 0;
  for (let step = 3; step <= 5 && r.action.status === 'needs_clarification' && r.question; step++) {
    // 파이프라인이 출력 모델로 말할 문장을 만들고, 재생 뒤 실제로 말한 문장을 보고한다
    const out = (await call('output.generate', approveId, { requestId: approveId, outputId: id('out'), action: r.action, requiredText: r.question, isQuestion: true }, false)) as { text: string };
    console.log(`\n  🗣 ${out.text}`);
    const f = r.action.facts;
    const ev = (await call(
      'pipeline.event',
      f['harnessRequestId']!,
      { messageId: id('ev'), requestId: f['harnessRequestId'], pendingId: f['pendingId'], outputId: f['outputId'], sourceRevision: ++seq, occurredAt: new Date().toISOString(), kind: 'question_delivered', channel: 'speech', deliveredText: out.text },
      false,
    )) as { applied: boolean; reason?: string };
    if (!ev.applied) fail(`질문 전달 보고가 반영되지 않았어요: ${ev.reason}`);
    const text = await ask('답변을 입력하세요 (예: 응, 승인해 / 아니, 보류해). 빈 입력이면 종료합니다.');
    if (!text) return console.log('\n답변 없이 종료합니다. 대기 중인 질문은 실행되지 않습니다.');
    const approve = !/(아니|보류|취소|싫어)/.test(text);
    // 라우터가 승인 답변으로 판단했다고 흉내 낸다 (거절이면 mutationApproved=false)
    r = await run(approveId, text, approve ? 'confirm.approve' : 'confirm.reject', approve);
    show(`${step}) harness.run — 답변 (mutationApproved=${approve})`, r);
  }
}

async function main() {
  await client.connect(token, 'pipeline');
  const cmd = args[0];
  if (cmd === 'reminders') {
    const requestId = id('adapter-rem');
    show('eureka.reminders', await call('eureka.reminders', requestId, { requestId }, false));
  }
  else if (cmd === 'reminder') {
    const itemId = args[1] ?? fail('itemId가 필요해요');
    const requestId = id('adapter-rem');
    show('eureka.reminder', await call('eureka.reminder', requestId, { requestId, itemId }, false));
  } else if (cmd === 'links') show('eureka.links', await links(args[1] ?? fail('itemId가 필요해요')));
  else if (cmd === 'eureka') await eureka();
  else if (cmd === 'harness') await harness();
  else fail('명령: reminders | reminder <itemId> | links <itemId> | eureka list|status|postpone | harness [PR번호] [--item <itemId>]');
}

main()
  .catch((e: unknown) => {
    console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => client.close());
