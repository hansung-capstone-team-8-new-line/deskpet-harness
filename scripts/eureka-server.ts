/* eslint-disable no-console */
/**
 * Eureka 내부 API 서버 (D-31). 파이프라인의 직접 Eureka 요청(eureka.execute·reconcile·reminders·reminder·links)만 받는
 * 별도 프로세스다. wiki deskpet-pipeline §4 "Eureka Internal API Deployment Review"의 목표 배치:
 * 긴 Harness 요청(LLM·GitHub)이 직접 Eureka 요청의 처리 용량·이벤트 루프·재시작을 함께 쓰지 않게 한다.
 *
 *   pnpm eureka:server                         # Eureka 쓰기 허용이 기본 (D-38). 확인 받은 요청(mutationApproved)만 보낸다
 *                                              # 쓰기에는 EUREKA_STORE_PATH가 필요하다. 없으면 쓰기를 끄고 시작한다
 *   pnpm eureka:server --read-only             # 읽기만
 *
 * 메시지·봉투는 Harness 서버와 같다 (deskpet.harness.v1). 파이프라인은 Eureka 연결부 주소만 이 서버로 바꾸면 된다.
 * Harness 서버를 DESKPET_EUREKA_BRIDGE=external로 켜면 그쪽은 eureka.*를 받지 않는다 (작업 기록 권위를 한 곳에만 둔다).
 * Harness 안의 G-01 단계 완료(complete_stage)는 그대로 Harness 서버가 Eureka에 직접 쓴다.
 *
 * .env
 *   EUREKA_WS_TOKEN (없으면 HARNESS_WS_TOKEN, 16자 이상), EUREKA_WS_HOST(기본 127.0.0.1), EUREKA_WS_PORT(기본 8789)
 *   EUREKA_WS_ALLOWED_CLIENTS (다른 기기 접속 허용 IP·CIDR. EUREKA_WS_HOST를 loopback이 아닌 값으로 줄 때 필수)
 *   EUREKA_STORE_PATH (쓰기 작업 기록 SQLite. Harness의 DESKPET_STORE_PATH와 다른 파일이어야 함)
 *   DESKPET_ALLOWED_REPOS (PR 연결 후보로 받을 저장소 owner/name 목록, D-36. 비우면 제한 없음)
 *   EUREKA_API_KEY, EUREKA_BASE_URL, EUREKA_DEFAULT_PROCESS_ID, EUREKA_MAX_CONCURRENT, EUREKA_NOTE_ACTOR_ID
 */
import { resolve } from 'node:path';
import { ConcurrencyLimiter, parseAllowedRepositories } from '@deskpet/contracts';
import { EUREKA_DEFAULT_BASE_URL, createEurekaRestGateway } from '@deskpet/gateways';
import { DEFAULT_POLICY, InMemoryOperationStore, StoreLockedError, randomIdGen, systemClock } from '@deskpet/harness';
import { EurekaBridge, EurekaInbound, HarnessWsServer } from '@deskpet/server';

try {
  process.loadEnvFile('.env');
} catch {
  console.log('! .env 파일을 찾지 못했어요. app 폴더에서 실행했는지 확인하세요.');
}
const env = process.env;
const fail = (msg: string): never => {
  console.log(`✗ ${msg}`);
  process.exit(1);
};
let allowWrites = !process.argv.includes('--read-only');
const writeWarnings: string[] = [];

const token = env['EUREKA_WS_TOKEN']?.trim() || env['HARNESS_WS_TOKEN']?.trim() || fail('EUREKA_WS_TOKEN(또는 HARNESS_WS_TOKEN)이 비어 있어요 (16자 이상)');
if (token.length < 16) fail('토큰은 16자 이상이어야 해요');
const host = env['EUREKA_WS_HOST']?.trim() || '127.0.0.1';
const port = Number(env['EUREKA_WS_PORT']) || 8789;
const lan = !['127.0.0.1', 'localhost', '::1'].includes(host);
const allowedClients = (env['EUREKA_WS_ALLOWED_CLIENTS'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
if (lan && !allowedClients.length) fail(`EUREKA_WS_HOST=${host}로 다른 기기 접속을 열려면 EUREKA_WS_ALLOWED_CLIENTS가 필요해요`);
if (lan && token.length < 24) fail('다른 기기 접속을 열 때는 토큰을 24자 이상으로 해 주세요');

const base = env['EUREKA_BASE_URL']?.trim() || EUREKA_DEFAULT_BASE_URL;

const storePath = env['EUREKA_STORE_PATH']?.trim();
if (allowWrites && !storePath) {
  allowWrites = false;
  writeWarnings.push('EUREKA_STORE_PATH(영속 저장소)가 없어 쓰기를 끄고 시작해요. .env에 EUREKA_STORE_PATH=.deskpet/eureka.db 를 넣으세요');
}
const harnessStore = env['DESKPET_STORE_PATH']?.trim();
if (storePath && harnessStore && resolve(storePath) === resolve(harnessStore)) fail('EUREKA_STORE_PATH는 Harness의 DESKPET_STORE_PATH와 다른 파일이어야 해요');
const storeOpts = {
  clock: systemClock,
  ids: randomIdGen,
  capacityBytes: DEFAULT_POLICY.storeCapacityBytes,
  recoveryBudgetBytes: DEFAULT_POLICY.recoveryBudgetBytes,
  minRetentionMs: DEFAULT_POLICY.minRetentionMs,
  maxRecoveryAttempts: DEFAULT_POLICY.maxRecoveryAttempts,
};
const store = (() => {
  try {
    return storePath ? InMemoryOperationStore.openDurable(storePath, storeOpts) : new InMemoryOperationStore(storeOpts);
  } catch (e) {
    return fail(e instanceof StoreLockedError ? `저장소를 다른 프로세스가 쓰고 있어요 (${e.holder}). ${e.lockPath}` : `저장소를 열지 못했어요: ${e instanceof Error ? e.message : String(e)}`);
  }
})();

const max = Number(env['EUREKA_MAX_CONCURRENT']) > 0 ? Number(env['EUREKA_MAX_CONCURRENT']) : 4;
const eureka = (() => {
  try {
    return createEurekaRestGateway(env, undefined, { allowWrites, limiter: new ConcurrencyLimiter('eureka', max) });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
})();
const allowed = parseAllowedRepositories(env['DESKPET_ALLOWED_REPOS']);
if (allowed.invalid.length) fail(`DESKPET_ALLOWED_REPOS 형식이 틀렸어요 (owner/name,owner/name): ${allowed.invalid.join(', ')}`);
const processId = env['EUREKA_DEFAULT_PROCESS_ID']?.trim();
const bridge = new EurekaBridge({ eureka, store, clock: systemClock, holderId: `eureka-server-${process.pid}`, ...(allowed.repos.length ? { allowedRepositories: allowed.repos } : {}), ...(processId ? { defaultProcessId: processId } : {}) });
const server = new HarnessWsServer({
  inbound: new EurekaInbound(bridge),
  store,
  token,
  host,
  port,
  allowedClients,
  log: (l) => console.log(`[eureka-server] ${l}`),
  ...(env['DESKPET_TIMING_LOG']?.trim() === 'off' ? {} : { onCompleted: (i: { kind: string; requestId: string; ms: number; ok: boolean }) => console.log(`[timing] ${i.kind} ${i.requestId} ${i.ms}ms${i.ok ? '' : ' (거부·오류)'}`) }),
});

async function main() {
  console.log('DeskPet Eureka 내부 API 서버 (D-31)');
  console.log(`Eureka: ${base} / 쓰기 ${allowWrites ? '허용 (확인 받은 요청만, mutationApproved)' : '꺼짐'} / 동시 호출 ${max}건`);
  for (const w of writeWarnings) console.log(`! ${w}`);
  console.log(`받는 요청: eureka.execute · eureka.reconcile · eureka.reminders · eureka.reminder · eureka.links`);
  console.log(storePath ? `저장소: ${storePath}` : '저장소: 메모리 (EUREKA_STORE_PATH 미설정 → 끄면 기록이 사라짐)');
  const r = await server.start();
  console.log(`주소: ws://${r.host}:${r.port}${lan ? ` (허용 ${allowedClients.join(', ')})` : ' (이 기기에서만)'}`);
}

let closing = false;
async function shutdown(sig: string) {
  if (closing) return;
  closing = true;
  console.log(`\n${sig} 수신 — 처리 중인 요청을 마치고 종료합니다`);
  await server.stop(30_000);
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
main().catch((e: unknown) => fail(`서버 시작 실패: ${e instanceof Error ? e.message : String(e)}`));
