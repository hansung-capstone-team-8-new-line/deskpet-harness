/* eslint-disable no-console */
/**
 * Eureka 직접 요청 한 번에 시험 (docs/eureka-test.md 3~5단계를 자동으로). 서버 없이 EurekaBridge를 바로 부른다.
 * 시험용 새 업무 하나를 만들고 그 업무에만 쓴다: 등록 → 조회 → 마감 변경(거절·승인) → 단계 기록 → 연결 →
 * 미지원 → 결과 조회 → 작업 번호 재사용 → 완료 → 다시 완료.
 *
 *   pnpm eureka:check                # 읽기만 (업무 유형·목록·조회)
 *   pnpm eureka:check --write        # 위 + 시험 업무 쓰기 (EUREKA_DEFAULT_PROCESS_ID 필요)
 *   pnpm eureka:check --write --fake # 실제 Eureka 대신 가짜 서버로 이 스크립트 자체를 점검
 *
 * 결과는 화면과 ../eureka-check-<시각>.log 에 남긴다. 키 값은 출력하지 않는다.
 */
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EUREKA_DEFAULT_BASE_URL, EurekaGateway, FakeEurekaServer, createEurekaRestGateway } from '@deskpet/gateways';
import { DEFAULT_POLICY, InMemoryOperationStore, randomIdGen, systemClock } from '@deskpet/harness';
import { EurekaBridge } from '@deskpet/server';

try {
  process.loadEnvFile('.env');
} catch {
  console.log('! .env 파일을 찾지 못했어요. app 폴더에서 실행했는지 확인하세요.');
}
const env = process.env;
const write = process.argv.includes('--write');
const fake = process.argv.includes('--fake');
const base = fake ? 'fake' : env['EUREKA_BASE_URL']?.trim() || EUREKA_DEFAULT_BASE_URL;
const processId = fake ? 'general-work-v1@10204' : env['EUREKA_DEFAULT_PROCESS_ID']?.trim();
if (write && !processId) {
  console.log('✗ --write는 EUREKA_DEFAULT_PROCESS_ID가 있어야 해요 (업무 등록용)');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = resolve(fake ? '/tmp' : '..', `eureka-check-${stamp}.log`);
const log = (line: string) => {
  console.log(line);
  appendFileSync(logPath, `${line}\n`);
};

const store = new InMemoryOperationStore({
  clock: systemClock,
  ids: randomIdGen,
  capacityBytes: DEFAULT_POLICY.storeCapacityBytes,
  recoveryBudgetBytes: DEFAULT_POLICY.recoveryBudgetBytes,
  minRetentionMs: DEFAULT_POLICY.minRetentionMs,
  maxRecoveryAttempts: DEFAULT_POLICY.maxRecoveryAttempts,
});
const fakeServer = fake ? new FakeEurekaServer(() => Date.now()) : undefined;
fakeServer?.addItem({ id: '1000014', name: 'LLM_TEST_1', stages: [{ id: '1000213', name: '목표와 범위 정리', status: 'todo', order: 1 }] });
const gateway = fakeServer ? new EurekaGateway({ http: fakeServer, now: () => Date.now(), allowWrites: write }) : createEurekaRestGateway(env, undefined, { allowWrites: write });
const bridge = new EurekaBridge({ eureka: gateway, store, clock: systemClock, ...(processId ? { defaultProcessId: processId } : {}) });

const run = Date.now().toString(36);
let n = 0;
const deadline = () => new Date(Date.now() + 60_000).toISOString();
const decision = (operation: string, heads: Record<string, string | undefined> = {}) => {
  const all: Record<string, string> = { intention: 'eureka', modelIntention: 'eureka', operation };
  for (const [k, v] of Object.entries(heads)) if (v !== undefined) all[k] = v;
  return { headOutputs: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { value: v, confidence: 0.95 }])), overallConfidence: 0.93, missingRequiredSlots: [], route: 'eureka' as const };
};
type R = Awaited<ReturnType<EurekaBridge['execute']>>;
let pass = 0;
let failCount = 0;

function report(no: string, title: string, r: R, ok: boolean, ms: number, note = '') {
  if (ok) pass++;
  else failCount++;
  log(`${ok ? '✓' : '✗'} ${no} ${title}  (${ms}ms)`);
  log(`    상태: ${r.status}${r.error ? `  오류: ${r.error.code}` : ''}${note ? `  ${note}` : ''}`);
  const text = r.facts['resultText'] ?? r.facts['question'];
  if (text) log(`    🗣 ${text}`);
}

async function step(no: string, title: string, op: string, heads: Record<string, string | undefined>, expect: (r: R) => boolean, o: { approved?: boolean; requestId?: string; operationId?: string } = {}) {
  const requestId = o.requestId ?? `check-${run}-${++n}`;
  const operationId = o.operationId ?? `op-${run}-${n}`;
  const t = Date.now();
  let r: R;
  try {
    r = await bridge.execute({ requestId, operationId, decision: decision(op, heads), deadlineAt: deadline(), mutationApproved: o.approved ?? false });
  } catch (e) {
    failCount++;
    log(`✗ ${no} ${title}  예외: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  report(no, title, r, expect(r), Date.now() - t);
  return { r, requestId, operationId };
}

const isConfirm = (r: R) => r.status === 'needs_clarification' && r.facts['questionKind'] === 'confirmation';

async function main() {
  log(`Eureka 직접 요청 시험 — ${base} / 쓰기 ${write ? '함 (시험 업무에만)' : '안 함'} / ${new Date().toISOString()}`);
  log('');
  log('[읽기]');
  await step('R-1', '업무 유형', 'query_processes', {}, (r) => r.status === 'succeeded');
  await step('R-2', '업무 목록', 'list', {}, (r) => r.status === 'succeeded');
  await step('R-3', '업무 상태 LLM_TEST_1', 'query', { target: 'LLM_TEST_1' }, (r) => r.status === 'succeeded');
  await step('R-4', '없는 업무', 'query', { target: `없는 업무 ${run}` }, (r) => r.status === 'failed' && r.error?.code === 'EUREKA_NOT_FOUND');
  await step('R-5', '미지원 작업(삭제)', 'delete', { target: 'LLM_TEST_1' }, (r) => r.status === 'failed' && r.error?.code === 'EUREKA_OPERATION_NOT_IMPLEMENTED');
  if (!write) return;

  const name = `DeskPet 시험 ${run}`;
  log('');
  log(`[쓰기 — 시험 업무 "${name}"]`);
  const q1 = await step('W-1', '등록 확인 질문', 'create', { task: name, dueAt: '2026-11-20T23:59:00+09:00' }, isConfirm);
  if (!q1) return;
  const c = await step('W-2', '등록 (승인)', 'create', { task: name, dueAt: '2026-11-20T23:59:00+09:00' }, (r) => r.status === 'succeeded' && !!r.facts['itemId'], { approved: true, requestId: q1.requestId, operationId: q1.operationId });
  if (!c || c.r.status !== 'succeeded') return log('  등록이 안 돼서 여기서 멈춰요.');
  const itemId = c.r.facts['itemId']!;
  log(`    itemId=${itemId}`);
  // 2026-11-09 실측: 등록 직후 업무 목록(items/0/list)에 새 업무가 바로 나오지 않았다. 나올 때까지 기다리며 걸린 시간을 잰다
  const t0 = Date.now();
  let seen = false;
  while (Date.now() - t0 < 60_000) {
    const l = await gateway.listTasks({ limit: 100 }, { deadlineAt: deadline() });
    if (l.ok && l.data!.items.some((x) => x.itemId === itemId)) {
      seen = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  log(`${seen ? '✓' : '✗'} W-2b 목록에 새 업무가 나오기까지  ${seen ? `${Date.now() - t0}ms` : '60초 안에 안 나옴'}`);
  if (seen) pass++;
  else return void failCount++;
  await step('W-3', '등록한 업무 조회', 'query', { target: name }, (r) => r.status === 'succeeded' && r.facts['itemId'] === itemId);
  await step('W-4', '마감 변경 질문만 (거절 — 보내지 않음)', 'postpone', { target: name, dueAt: '2026-11-21T18:00:00+09:00' }, isConfirm);
  const pp = await step('W-5', '마감 변경 (승인)', 'postpone', { target: name, dueAt: '2026-11-21T18:00:00+09:00' }, (r) => r.status === 'succeeded', { approved: true });
  // Eureka 목록은 쓰기 직후 1~2초 늦게 바뀐다 (2026-11-09 실측). 바로 한 번 보고, 안 맞으면 반영될 때까지 기다려 걸린 시간을 남긴다
  {
    const t0 = Date.now();
    const want = (r: R) => r.status === 'succeeded' && /11월 21일 .*6시/.test(r.facts['resultText'] ?? '');
    let r = await bridge.execute({ requestId: `check-${run}-${++n}`, operationId: `op-${run}-${n}`, decision: decision('query', { target: name }), deadlineAt: deadline(), mutationApproved: false });
    const first = want(r);
    while (!want(r) && Date.now() - t0 < 30_000) {
      await new Promise((res) => setTimeout(res, 1_000));
      r = await bridge.execute({ requestId: `check-${run}-${++n}`, operationId: `op-${run}-${n}`, decision: decision('query', { target: name }), deadlineAt: deadline(), mutationApproved: false });
    }
    report('W-6', '마감 바뀌었는지 조회', r, want(r), Date.now() - t0, first ? '바로 반영' : want(r) ? `목록 반영까지 ${Date.now() - t0}ms` : '30초 안에 반영 안 됨');
  }
  const prUrl = 'https://github.com/Only-tset-for-cap/personal_MCP_test/pull/15';
  await step('W-7', '단계 기록 추가 (승인)', 'add_note', { target: name, note: `PR: ${prUrl}` }, (r) => r.status === 'succeeded' && !!r.facts['noteId'], { approved: true });
  const t = Date.now();
  let l = await bridge.links(itemId, deadline());
  const linkedNow = l.status === 'linked';
  while (l.status !== 'linked' && Date.now() - t < 30_000) {
    await new Promise((res) => setTimeout(res, 1_000));
    l = await bridge.links(itemId, deadline());
  }
  const lok = l.status === 'linked' && l.links[0]?.prNumber === 15;
  if (lok) pass++;
  else failCount++;
  log(`${lok ? '✓' : '✗'} W-8 업무 연결 찾기  (${Date.now() - t}ms)  ${linkedNow ? '바로 반영' : lok ? '목록의 단계 기록 반영까지 기다림' : '30초 안에 반영 안 됨'}`);
  log(`    상태: ${l.status}${l.links[0] ? `  PR ${l.links[0].prNumber} → 단계 ${l.links[0].stageId} ${l.links[0].stageName}` : ''}`);
  if (pp) {
    const t2 = Date.now();
    const rc = await bridge.reconcile({ requestId: pp.requestId, operationId: pp.operationId, decision: decision('query'), deadlineAt: deadline() });
    report('W-9', '결과 조회 (같은 작업 번호)', rc, rc.status === 'succeeded', Date.now() - t2);
    const t3 = Date.now();
    const rc2 = await bridge.reconcile({ requestId: pp.requestId, operationId: `${pp.operationId}-x`, decision: decision('query'), deadlineAt: deadline() });
    report('W-10', '결과 조회 (없는 작업 번호)', rc2, rc2.status === 'unknown' && rc2.error?.code === 'RECONCILIATION_UNAVAILABLE', Date.now() - t3);
    await step('W-11', '같은 작업 번호로 다른 요청(완료) — 거절', 'complete', { target: name }, (r) => r.status === 'failed' && r.error?.code === 'OPERATION_ID_REUSED', { approved: true, requestId: pp.requestId, operationId: pp.operationId });
  }
  await step('W-12', '업무 완료 (승인)', 'complete', { target: name }, (r) => r.status === 'succeeded', { approved: true });
  await step('W-13', '다시 완료 — 이미 완료', 'complete', { target: name }, (r) => r.status === 'failed' && r.error?.code === 'POLICY_BLOCKED', { approved: true });
  const last = await step('W-14', '목록에서 빠졌는지', 'list', {}, (r) => r.status === 'succeeded' && !(r.facts['items'] ?? '').includes(`"${itemId}"`));
  void last;
}

main()
  .catch((e: unknown) => log(`✗ 중단: ${e instanceof Error ? e.message : String(e)}`))
  .finally(() => {
    log('');
    log(`결과: 통과 ${pass} / 실패 ${failCount}`);
    log(`기록 파일: ${logPath}`);
    store.close();
  });
