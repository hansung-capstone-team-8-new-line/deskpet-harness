/* eslint-disable no-console */
/**
 * 파이프라인 문서 형식(adapter) 로컬 시험 클라이언트. Swift 파이프라인 대신 같은 모양의 메시지를 보낸다.
 * demo/ 폴더는 서버와 무관하게 통째로 지울 수 있다. docs/pipeline-bridge.md 참고.
 *
 *   pnpm harness                                         # 다른 터미널에서 먼저 실행
 *   pnpm demo:adapter reminders                          # EurekaAdapter.reminders()
 *   pnpm demo:adapter reminder <itemId>                  # EurekaAdapter.reminder(itemId)
 *   pnpm demo:adapter links <itemId>                     # eureka.links: 단계 기록의 PR 주소 → 연결된 PR (P-19)
 *   직접 Eureka 요청 (라우터 형식: intention=eureka + operation, D-33 헤드 의미)
 *   pnpm demo:adapter eureka list                        # 열린 업무 목록
 *   pnpm demo:adapter eureka processes                   # 등록할 수 있는 업무 유형
 *   pnpm demo:adapter eureka query ["업무"]               # 업무 상태 (없으면 목록). status도 같음
 *   pnpm demo:adapter eureka create "새 업무" [마감ISO]     # 쓰기: 업무 등록 (EUREKA_DEFAULT_PROCESS_ID 필요)
 *   pnpm demo:adapter eureka postpone "업무" 마감ISO        # 쓰기: 마감 변경 (예: 2026-11-20T23:59:00+09:00)
 *   pnpm demo:adapter eureka note "업무" "내용" [--stage "단계"]   # 쓰기: 단계 기록 추가
 *   pnpm demo:adapter eureka complete "업무"               # 쓰기: 업무 전체 완료
 *   pnpm demo:adapter eureka unsupported                 # 미지원 작업(delete) 안내 확인
 *   pnpm demo:adapter eureka reconcile --req <requestId> --op <operationId>   # 결과 조회
 *     쓰기는 확인 질문을 보여 주고 답을 받는다(승인 말 → 같은 요청에 mutationApproved=true). --answer "응" 또는 --approve로 미리 지정
 *     --req·--op로 requestId·operationId를 직접 줄 수 있다 (같은 번호 재사용 거절 확인용)
 *     --eureka-server: Eureka 내부 API 서버(pnpm eureka:server, EUREKA_WS_URL 기본 ws://127.0.0.1:8789)에 붙는다
 *   pnpm demo:adapter harness [PR번호] [--answer "응, 승인해"]
 *   pnpm demo:adapter harness --item <itemId>            # 위와 같되 대상 PR·완료할 단계를 eureka.links로 찾는다
 *   pnpm demo:adapter eureka <itemId>                    # harness --item <itemId>와 같음 (업무 → PR → 승인 → 단계 완료 한 번에)
 *     Harness 서버가 DESKPET_EUREKA_BRIDGE=external이면 eureka.links만 Eureka 내부 API 서버(8789)에 묻는다
 *                                                        # HarnessAdapter.run: 리뷰 → 승인 질문 → output.generate → 전달 보고 → 답변
 *
 * .env: HARNESS_WS_URL(기본 ws://127.0.0.1:8787), HARNESS_WS_TOKEN, GITHUB_TEST_REPO, GITHUB_TEST_PR
 *       EUREKA_WS_URL·EUREKA_WS_TOKEN (--eureka-server일 때, 토큰이 없으면 HARNESS_WS_TOKEN)
 *
 * --fixture: pnpm web:fixture 서버(가짜 GitHub·Eureka)에 붙는다. 주소·토큰·PR을 fixture 값으로 바꾼다 (.env 불필요)
 *   pnpm demo:adapter --fixture harness --answer "응, 승인해"
 */
import { createInterface } from 'node:readline/promises';
import { answerWordVerdict } from '@deskpet/harness';
import { HarnessClient, type Reply } from './harnessClient.js';

try {
  process.loadEnvFile('.env');
} catch {
  if (!process.argv.includes('--fixture')) console.log('! .env 파일을 찾지 못했어요. app 폴더에서 실행했는지 확인하세요.');
}
const env = process.env;
const fixture = process.argv.includes('--fixture');
const eurekaServer = process.argv.includes('--eureka-server');
const args = process.argv.slice(2).filter((a) => a !== '--fixture' && a !== '--eureka-server');
if (fixture) {
  env['HARNESS_WS_URL'] = 'ws://127.0.0.1:8788';
  env['HARNESS_WS_TOKEN'] = 'fixture-pipeline-token-123';
  env['GITHUB_TEST_REPO'] = 'NewLine/DeskPet';
  env['GITHUB_TEST_PR'] = '42';
}
const valueOf = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg: string): never => {
  console.log(`✗ ${msg}`);
  process.exit(1);
};

const token = (eurekaServer ? env['EUREKA_WS_TOKEN']?.trim() : undefined) || env['HARNESS_WS_TOKEN']?.trim() || fail('HARNESS_WS_TOKEN이 비어 있어요 (서버와 같은 값)');
const runId = Date.now().toString(36);
const url = eurekaServer ? env['EUREKA_WS_URL']?.trim() || 'ws://127.0.0.1:8789' : env['HARNESS_WS_URL']?.trim() || 'ws://127.0.0.1:8787';
const client = new HarnessClient(url, runId);
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

/** 확인 답변 판정: Harness와 같은 말 목록(answerWordVerdict)을 쓴다. 되묻는 말·알 수 없는 말은 unclear */
function answerVerdict(text: string): 'approve' | 'reject' | 'unclear' {
  const v = answerWordVerdict(text);
  return v === 'approve' || v === 'reject' ? v : 'unclear';
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
/** 라우터 형식 결정 (intention=eureka + operation). 헤드: target=업무, name=단계, task=새 업무 이름, note=기록 내용, dueAt=마감 */
function eurekaDecision(operation: string, heads: Record<string, string | undefined> = {}) {
  const all: Record<string, string> = { intention: 'eureka', modelIntention: 'eureka', operation };
  for (const [k, v] of Object.entries(heads)) if (v !== undefined) all[k] = v;
  return {
    headOutputs: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { value: v, confidence: 0.95 }])),
    overallConfidence: 0.93,
    missingRequiredSlots: [],
    route: 'eureka',
  };
}

type EurekaResult = { operationId: string; status: string; facts: Record<string, string>; error: { code: string; message: string } | null };

function showEureka(title: string, requestId: string, r: EurekaResult) {
  console.log(`\n── ${title} ──`);
  console.log(`  requestId=${requestId}  operationId=${r.operationId}`);
  console.log(`  상태: ${r.status}${r.error ? `  오류: ${r.error.code} (${r.error.message})` : ''}`);
  const text = r.facts['resultText'] ?? r.facts['question'];
  if (text) console.log(`  🗣 ${text}`);
  const rest = Object.fromEntries(Object.entries(r.facts).filter(([k]) => k !== 'resultText' && k !== 'question'));
  if (Object.keys(rest).length) console.log(`  facts: ${JSON.stringify(rest, null, 2).replace(/\n/g, '\n  ')}`);
}

async function eureka() {
  const sub = args[1];
  const requestId = valueOf('--req') ?? id('adapter-eureka');
  const operationId = valueOf('--op') ?? id('op');
  const pos = args.slice(2).filter((a, i, all) => !a.startsWith('--') && !['--stage', '--answer', '--req', '--op'].includes(all[i - 1] ?? ''));
  const exec = async (decision: unknown, mutationApproved: boolean) =>
    (await call('eureka.execute', requestId, { requestId, operationId, decision, deadlineAt: deadline(), mutationApproved })) as EurekaResult;
  /** 확인 질문이면 답을 받아 같은 요청을 mutationApproved=true로 다시 보낸다 (파이프라인 흐름) */
  const run = async (title: string, decision: unknown) => {
    let r = await exec(decision, false);
    showEureka(`${title} — 1차`, requestId, r);
    if (r.status === 'needs_clarification' && r.facts['questionKind'] === 'confirmation') {
      const a = args.includes('--approve') ? '응' : await ask('답변 (예: 응 / 아니). 빈 입력이면 종료');
      if (args.includes('--approve')) console.log('  > 응  (--approve)');
      if (!a || answerVerdict(a) !== 'approve') return console.log('\n승인 말이 없어 실행하지 않고 끝냅니다. Eureka에 아무것도 보내지 않았어요.');
      r = await exec(decision, true);
      showEureka(`${title} — 승인 후 (mutationApproved=true)`, requestId, r);
    }
  };
  const need = (v: string | undefined, what: string) => v ?? fail(`${what}이(가) 필요해요 (따옴표로 감싸세요)`);

  if (sub === 'list') return run('목록', eurekaDecision('list'));
  if (sub === 'processes') return run('업무 유형', eurekaDecision('query_processes'));
  if (sub === 'query' || sub === 'status') return run('상태', eurekaDecision('query', { target: pos[0] }));
  if (sub === 'create') return run('업무 등록', eurekaDecision('create', { task: need(pos[0], '새 업무 이름'), dueAt: pos[1] }));
  if (sub === 'postpone') return run('마감 변경', eurekaDecision('postpone', { target: need(pos[0], '업무 이름'), dueAt: need(pos[1], '새 마감(예: 2026-11-20T23:59:00+09:00)') }));
  if (sub === 'note') return run('단계 기록', eurekaDecision('add_note', { target: need(pos[0], '업무 이름'), note: need(pos[1], '기록 내용'), name: valueOf('--stage') }));
  if (sub === 'complete') return run('업무 완료', eurekaDecision('complete', { target: need(pos[0], '업무 이름') }));
  if (sub === 'unsupported') return run('미지원 작업', eurekaDecision('delete', { target: pos[0] ?? '아무 업무' }));
  if (sub === 'reconcile') {
    if (!valueOf('--req') || !valueOf('--op')) fail('--req <requestId> --op <operationId> 가 필요해요 (쓰기 결과에 찍힌 값)');
    const r = (await call('eureka.reconcile', requestId, { requestId, operationId, decision: eurekaDecision('query'), deadlineAt: deadline() })) as EurekaResult;
    return showEureka('결과 조회', requestId, r);
  }
  fail(`알 수 없는 하위 명령: ${sub ?? '(없음)'} — list | processes | query | create | postpone | note | complete | unsupported | reconcile`);
}

// --------------------------------------------------------------- harness
type LinkLookup = {
  status: string;
  links: { repository: { owner: string; name: string }; prNumber: number; itemId: string; stageId: string; stageName: string; noteId: string }[];
};

/**
 * eureka.links. Harness 서버를 DESKPET_EUREKA_BRIDGE=external로 켰으면(D-31) 그 서버는 eureka.*를 받지 않으므로
 * Eureka 내부 API 서버(EUREKA_WS_URL, 기본 ws://127.0.0.1:8789)에 다시 묻는다. 리뷰·승인·단계 완료는 그대로 Harness 서버
 */
async function links(itemId: string): Promise<LinkLookup> {
  const requestId = id('adapter-links');
  const r: Reply = await client.request('eureka.links', requestId, { requestId, itemId });
  if (r.ok) return r.payload as LinkLookup;
  if (r.error?.code !== 'unsupported_kind') fail(`eureka.links 거부: ${r.error?.code} ${r.error?.message}`);
  const url2 = env['EUREKA_WS_URL']?.trim() || 'ws://127.0.0.1:8789';
  console.log(`  (이 서버는 eureka.*를 받지 않아요 → Eureka 내부 API 서버 ${url2}에 물어요)`);
  const eurekaClient = new HarnessClient(url2, `${runId}-e`);
  try {
    await eurekaClient.connect(env['EUREKA_WS_TOKEN']?.trim() || token, 'pipeline');
    const r2: Reply = await eurekaClient.request('eureka.links', requestId, { requestId, itemId });
    if (!r2.ok) fail(`eureka.links 거부 (${url2}): ${r2.error?.code} ${r2.error?.message}`);
    return r2.payload as LinkLookup;
  } catch (e) {
    return fail(`Eureka 내부 API 서버(${url2})에 연결하지 못했어요: ${e instanceof Error ? e.message : String(e)} — pnpm eureka:server를 켰는지 확인하세요`);
  } finally {
    eurekaClient.close();
  }
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
    // 라우터 흉내: 승인 말이 있을 때만 승인, 거절 말이면 거절, 그 밖(오타·잡음)은 unclear (2026-11-09 시험 사고 뒤 수정)
    const v = answerVerdict(text);
    const approve = v === 'approve';
    r = await run(approveId, text, v === 'approve' ? 'confirm.approve' : v === 'reject' ? 'confirm.reject' : 'unclear', approve);
    show(`${step}) harness.run — 답변 (${v}, mutationApproved=${approve})`, r);
  }
}

async function main() {
  await client.connect(token, 'pipeline');
  // eureka <업무번호>: 업무에서 시작하는 G-01 전체(연결된 PR 리뷰 → 승인 → Eureka 단계 완료)를 harness --item으로 돌린다
  if (args[0] === 'eureka' && /^\d+$/.test(args[1] ?? '')) args.splice(0, 2, 'harness', '--item', args[1]!);
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
  else fail('명령: reminders | reminder <itemId> | links <itemId> | eureka list|processes|query|create|postpone|note|complete|unsupported|reconcile | harness [PR번호] [--item <itemId>]');
}

main()
  .catch((e: unknown) => {
    console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => client.close());
