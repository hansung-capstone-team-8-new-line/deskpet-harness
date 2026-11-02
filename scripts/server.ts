/* eslint-disable no-console */
/**
 * Harness 서비스 서버 (WebSocket). 파이프라인·데모 클라이언트·웹 화면이 이 서버에 연결한다.
 *
 *   pnpm harness                          # 쓰기 비활성 (GitHub 승인·Eureka 완료 요청은 보내지 않음)
 *   pnpm harness --allow-github-writes    # GitHub 승인 쓰기 허용. 승인은 요청 쪽(사용자 확인 질문·답변)에서만 받는다 (D-22).
 *                                         # DESKPET_STORE_PATH(영속 저장소) 필수. 같은 DB는 한 프로세스만 연다 (<DB>.lock)
 *   pnpm harness --allow-eureka-writes    # Eureka 쓰기 허용 (개발 환경 flw-d1만). 영속 저장소 필수
 *   pnpm harness … --poc                  # POC 장애 주입 (DESKPET_POC_FAULTS, scripts/poc-faults.ts, D-27)
 *
 * .env
 *   HARNESS_WS_TOKEN (필수, 16자 이상 — 클라이언트 hello 인증), HARNESS_WS_HOST(기본 127.0.0.1), HARNESS_WS_PORT(기본 8787),
 *   HARNESS_WS_ALLOWED_ORIGINS (브라우저 Origin 허용 목록, 쉼표 구분. 비우면 브라우저 접속 거부)
 *   HARNESS_WS_ALLOWED_CLIENTS (다른 기기 접속 허용 IP·CIDR, 쉼표 구분. HARNESS_WS_HOST를 loopback이 아닌 값으로 줄 때 필수)
 *   HARNESS_WS_TLS_CERT / HARNESS_WS_TLS_KEY (선택, PEM 파일 경로 → wss://)
 *   HARNESS_WS_VIEWER_TOKEN (선택, 16자 이상 — 웹 화면용 구독 전용 토큰. pipeline 토큰과 달라야 함)
 *   GITHUB_TOKEN, EUREKA_API_KEY, EUREKA_BASE_URL, DESKPET_REQUIRED_CHECKS, DESKPET_STORE_PATH, LLM_* (기존과 같음)
 * 비밀값은 출력하지 않는다. 쓰기는 옵션을 준 경우에만 보낸다. 서버 콘솔 yes 확인은 없앴다 (사용자 결정 2026-10-24, D-22).
 */
import { readFileSync } from 'node:fs';
import { pocSetup } from './poc-faults.js';
import { networkInterfaces } from 'node:os';
import { createEurekaRestGateway, GitHubReviewGateway, parseRequiredChecksFallback, RestGitHubTransport } from '@deskpet/gateways';
import { DEFAULT_POLICY, FileWikiReader, HarnessService, InMemoryOperationStore, RecoveryWorker, summarizeTimings, type TimingEntry, StoreLockedError, randomIdGen, systemClock } from '@deskpet/harness';
import { createLlmFromEnv } from '@deskpet/llm';
import { OutputService, fallbackText, mapHarnessResult } from '@deskpet/output';
import { ConcurrencyLimiter, type FollowUpNotice } from '@deskpet/contracts';
import { DirectHarnessInbound, EurekaBridge, HarnessWsServer, PipelineBridge } from '@deskpet/server';

try {
  process.loadEnvFile('.env');
} catch {
  console.log('! .env 파일을 찾지 못했어요. app 폴더에서 실행했는지 확인하세요.');
}
const env = process.env;
const allowGithubWrites = process.argv.includes('--allow-github-writes');
const allowEurekaWrites = process.argv.includes('--allow-eureka-writes');
const fail = (msg: string): never => {
  console.log(`✗ ${msg}`);
  process.exit(1);
};

const token = env['HARNESS_WS_TOKEN']?.trim() || fail('HARNESS_WS_TOKEN이 비어 있어요 (16자 이상 임의 문자열)');
if (token.length < 16) fail('HARNESS_WS_TOKEN은 16자 이상이어야 해요');
const githubToken = env['GITHUB_TOKEN'] || fail('GITHUB_TOKEN이 비어 있어요');

// ------------------------------------------------------ 다른 기기 접속 (D-25)
// 기본은 이 기기에서만(127.0.0.1). Jetson·파이프라인 보드에서 붙으려면 HARNESS_WS_HOST=0.0.0.0(또는 이 기기의 LAN 주소)과
// HARNESS_WS_ALLOWED_CLIENTS(접속을 받을 IP·CIDR)를 함께 준다. 둘 중 하나만 있으면 시작하지 않는다.
const wsHost = env['HARNESS_WS_HOST']?.trim() || '127.0.0.1';
const lan = !['127.0.0.1', 'localhost', '::1'].includes(wsHost);
const allowedClients = (env['HARNESS_WS_ALLOWED_CLIENTS'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const tlsCert = env['HARNESS_WS_TLS_CERT']?.trim();
const tlsKey = env['HARNESS_WS_TLS_KEY']?.trim();
if (lan) {
  if (!allowedClients.length) fail(`HARNESS_WS_HOST=${wsHost}로 다른 기기 접속을 열려면 HARNESS_WS_ALLOWED_CLIENTS(예: 192.168.0.20 또는 192.168.0.0/24)가 필요해요`);
  if (token.length < 24) fail('다른 기기 접속을 열 때는 HARNESS_WS_TOKEN을 24자 이상으로 해 주세요');
  const vt = env['HARNESS_WS_VIEWER_TOKEN']?.trim();
  if (vt && vt.length < 24) fail('다른 기기 접속을 열 때는 HARNESS_WS_VIEWER_TOKEN도 24자 이상으로 해 주세요');
}
if (!!tlsCert !== !!tlsKey) fail('TLS를 쓰려면 HARNESS_WS_TLS_CERT와 HARNESS_WS_TLS_KEY를 둘 다 주세요 (PEM 파일 경로)');
const tls = tlsCert && tlsKey ? (() => {
  try {
    return { cert: readFileSync(tlsCert, 'utf8'), key: readFileSync(tlsKey, 'utf8') };
  } catch (e) {
    return fail(`TLS 인증서·키를 읽지 못했어요: ${e instanceof Error ? e.message : String(e)}`);
  }
})() : undefined;

// ------------------------------------------------------------------ wiring
// LLM Guide 호출 시간 상한은 .env LLM_GUIDE_TIMEOUT_MS로 바꿀 수 있다 (기본 8초)
const guideTimeout = Number(env['LLM_GUIDE_TIMEOUT_MS']);
const config = { ...DEFAULT_POLICY, ...(guideTimeout > 0 ? { llmGuideTimeoutMs: guideTimeout } : {}) };
const storeOpts = {
  clock: systemClock,
  ids: randomIdGen,
  capacityBytes: config.storeCapacityBytes,
  recoveryBudgetBytes: config.recoveryBudgetBytes,
  minRetentionMs: config.minRetentionMs,
  maxRecoveryAttempts: config.maxRecoveryAttempts,
};
const storePath = env['DESKPET_STORE_PATH']?.trim();
// 쓰기 모드는 영속 저장소가 있어야 한다: 메모리 저장소는 재시작 뒤 '보냈을 수 있는' 승인을 기억하지 못해 중복 전송을 막지 못한다 (감사 F-04)
if (allowGithubWrites && !storePath) fail('--allow-github-writes는 DESKPET_STORE_PATH(영속 저장소)가 있어야 켤 수 있어요');
if (allowEurekaWrites && !storePath) fail('--allow-eureka-writes는 DESKPET_STORE_PATH(영속 저장소)가 있어야 켤 수 있어요');
// Eureka 쓰기는 개발 환경(flw-d1)에서만 허용한다 (사용자 결정: 개발 환경부터)
const eurekaBase = env['EUREKA_BASE_URL']?.trim() || 'https://api.eureka.codes/flw-d1';
if (allowEurekaWrites && !/\/flw-d1\/?$/.test(eurekaBase)) fail(`--allow-eureka-writes는 개발 환경(flw-d1)에서만 켤 수 있어요 (지금: ${eurekaBase})`);
const openStore = (): InMemoryOperationStore => {
  try {
    return storePath ? InMemoryOperationStore.openDurable(storePath, storeOpts) : new InMemoryOperationStore(storeOpts);
  } catch (e) {
  // 같은 DB를 다른 Harness 프로세스가 쓰고 있으면 시작하지 않는다 (단일 기록자)
    return fail(e instanceof StoreLockedError ? `저장소를 다른 Harness 프로세스가 쓰고 있어요 (${e.holder}). 그 프로세스를 끄거나, 이미 끝났다면 ${e.lockPath} 파일을 지우세요.` : `저장소를 열지 못했어요: ${e instanceof Error ? e.message : String(e)}`);
  }
};
const store = openStore();

// 자원별 동시 호출 상한 (D-24). 자리가 없으면 그 호출의 남은 시간 안에서 기다리고, 그래도 없으면 보내지 않음(not_sent)
const githubLimiter = new ConcurrencyLimiter('github', positive(env['GITHUB_MAX_CONCURRENT'], 4));
const eurekaLimiter = new ConcurrencyLimiter('eureka', positive(env['EUREKA_MAX_CONCURRENT'], 4));
// POC 장애 주입 (D-27): --poc 플래그 + DESKPET_POC_FAULTS + flw-d1일 때만 (scripts/poc-faults.ts)
const poc = (() => {
  try {
    return pocSetup(env, process.argv, (l) => console.log(l));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
})();
const github = new GitHubReviewGateway({
  transport: new RestGitHubTransport({ token: githubToken, allowWrites: allowGithubWrites, limiter: githubLimiter, ...(poc.githubFetch ? { fetchImpl: poc.githubFetch } : {}) }),
  now: () => Date.now(),
  requiredChecksFallback: parseRequiredChecksFallback(env['DESKPET_REQUIRED_CHECKS']),
});
const eureka = createEurekaRestGateway(env, poc.eurekaFetch, { allowWrites: allowEurekaWrites, limiter: eurekaLimiter });
const llm = createLlmFromEnv(env);
// LLM Wiki (D-19): vault 루트 경로. 없으면 Wiki 검색을 하지 않는다
const wikiDir = env['DESKPET_WIKI_DIR']?.trim();
const wiki = wikiDir ? new FileWikiReader({ root: wikiDir }) : undefined;
// 요청이 끝난 뒤 확정된 결과(늦게 끝난 Eureka 반영, 주기 복구)는 pipeline 연결에 notice로 알린다 (D-23)
let notify: (n: FollowUpNotice) => void = () => undefined;
const harness = new HarnessService({ store, github, eureka, clock: systemClock, ids: randomIdGen, config, holderId: `server-${process.pid}`, ...(llm.guideClient ? { llm: llm.guideClient } : {}), ...(wiki ? { wiki } : {}), ...(poc.sensor ? { sensor: poc.sensor } : {}), onFollowUp: (n) => notify(n) });
// 결과 불명·판정 대기 작업 주기 확인. 다시 보내지 않고 조회만 한다 (D-23). RECOVERY_INTERVAL_MS(기본 30초)
const recovery = new RecoveryWorker({ harness, store, clock: systemClock, intervalMs: Number(env['RECOVERY_INTERVAL_MS']) || 30_000, log: (l) => console.log(`[recovery] ${l}`) });
const output = new OutputService(llm.outputModel ? { model: llm.outputModel, ...(llm.outputTimeoutMs ? { modelTimeoutMs: llm.outputTimeoutMs } : {}) } : {});

const pipelineBridge = new PipelineBridge({ harness, store, output });
const server = new HarnessWsServer({
  // 파이프라인 문서 형식(harness.run 등)도 같은 서버에서 받는다 (docs/pipeline-bridge.md)
  inbound: new DirectHarnessInbound({
    harness,
    output,
    bridge: pipelineBridge,
    eurekaBridge: new EurekaBridge({ eureka, store, clock: systemClock, holderId: `server-${process.pid}-eureka`, ...(env['EUREKA_DEFAULT_PROCESS_ID']?.trim() ? { defaultProcessId: env['EUREKA_DEFAULT_PROCESS_ID'].trim() } : {}) }),
  }),
  store,
  token,
  ...(env['HARNESS_WS_VIEWER_TOKEN']?.trim() ? { viewerToken: env['HARNESS_WS_VIEWER_TOKEN'].trim() } : {}),
  host: wsHost,
  allowedClients,
  ...(tls ? { tls } : {}),
  port: Number(env['HARNESS_WS_PORT']) || 8787,
  allowedOrigins: (env['HARNESS_WS_ALLOWED_ORIGINS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  log: (l) => console.log(`[server] ${l}`),
  // 단계별 처리 시간 (NFR-01, D-26). DESKPET_TIMING_LOG=off면 끈다
  ...(env['DESKPET_TIMING_LOG']?.trim() === 'off' ? {} : { onCompleted: (i: { kind: string; requestId: string; ms: number; ok: boolean; payload?: unknown }) => console.log(`[timing] ${i.kind} ${i.requestId} ${i.ms}ms${i.ok ? '' : ' (거부·오류)'}${timingDetail(i.payload)}`) }),
});
notify = (n) => {
  const text = fallbackText(mapHarnessResult(n.result)).text;
  // 파이프라인 문서 형식 ActionResult도 같이 보낸다 (resultText는 고정 문구 → 출력 모델의 requiredText로 쓸 수 있음)
  void pipelineBridge
    .toPipelineResult(n.result, n.operationId)
    .catch(() => undefined)
    .then((p) => {
      const sent = server.notify({ ...n, ...(p ? { pipelineAction: p.action, pipelineQuestion: p.question } : {}) }, text);
      console.log(`[notice] ${n.source} ${n.action} → ${n.status}${sent ? '' : ' (연결된 파이프라인 없음)'}: ${text}`);
    });
};

async function main() {
  console.log('DeskPet Harness 서버');
  for (const l of poc.banner) console.log(l);
  console.log(`GitHub 쓰기: ${allowGithubWrites ? '허용 (사용자 확인 답변만으로 보냄)' : '꺼짐'}  /  Eureka 쓰기: ${allowEurekaWrites ? `허용 — ${eurekaBase} (사용자 확인 답변만으로 보냄)` : '꺼짐'}`);
  console.log(llm.enabled ? `LLM: ${llm.provider} / ${llm.model} (동시 ${llm.limiter?.stats().max ?? '-'}건)` : `LLM 꺼짐 (${llm.reason})`);
  console.log(`동시 호출 상한: GitHub ${githubLimiter.stats().max} / Eureka ${eurekaLimiter.stats().max} (D-24)`);
  if (lan) {
    const scheme = tls ? 'wss' : 'ws';
    const addrs = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `${scheme}://${i!.address}:${Number(env['HARNESS_WS_PORT']) || 8787}`);
    console.log(`다른 기기 접속: 허용 ${allowedClients.join(', ')} → 이 기기 주소 ${addrs.join(', ') || '(찾지 못함)'}`);
    if (!tls) console.log('  ! TLS 없이 열었어요: 토큰이 네트워크에 암호화 없이 오갑니다. 믿을 수 있는 같은 네트워크(집·연구실)에서만 쓰세요.');
  } else console.log('다른 기기 접속: 꺼짐 (이 기기에서만)');
  // 웹 화면 연결 준비 상태 (값은 출력하지 않는다)
  const origins = (env['HARNESS_WS_ALLOWED_ORIGINS'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  console.log(
    env['HARNESS_WS_VIEWER_TOKEN']?.trim()
      ? `웹 화면: 보기 전용 토큰 설정됨, 허용 Origin ${origins.length ? origins.join(', ') : '없음 → 브라우저 접속 거부 (HARNESS_WS_ALLOWED_ORIGINS 필요)'}`
      : '웹 화면: 꺼짐 (HARNESS_WS_VIEWER_TOKEN 미설정)',
  );
  console.log(wikiDir ? `Wiki: ${wikiDir} (wiki/ + projects/ README, Guide 참고용)` : 'Wiki 꺼짐 (DESKPET_WIKI_DIR 미설정)');
  if (storePath) {
    const cleaned = await store.maintain();
    const all = await store.listOperations();
    const needed = all.filter((o) => o.recovery === 'needed');
    console.log(`저장소: ${storePath} (operation ${all.length}건, 결과 확인 필요 ${needed.length}건, 정리 ${cleaned}건)`);
    // 이전 실행에서 결과를 모르는 쓰기는 다시 보내지 않고 읽기로만 확인한다
    for (const op of needed) {
      const rec = await harness.reconcile(op.operationId, `server-recover-${Date.now().toString(36)}`, { deadlineAt: new Date(Date.now() + 30_000).toISOString() });
      console.log(`  · 재시작 복구 ${op.action} [${op.requestId}]: ${rec.status}${rec.actionResult ? ` → ${rec.actionResult.status}` : ''}`);
    }
  } else console.log('저장소: 메모리 (DESKPET_STORE_PATH 미설정 → 서버를 끄면 기록이 사라짐)');
  await server.start();
  recovery.start();
  console.log('Ctrl+C로 종료하면 처리 중인 요청을 마친 뒤 닫습니다.');
}

let closing = false;
async function shutdown(sig: string) {
  if (closing) return;
  closing = true;
  console.log(`\n${sig} 수신 — 처리 중인 요청을 마치고 종료합니다 (최대 30초)`);
  await recovery.stop();
  await server.stop(30_000);
  await harness.drainBackground();
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((e: unknown) => {
  console.log(`✗ 서버 시작 실패: ${e instanceof Error ? e.message : String(e)}`);
  store.close();
  process.exit(1);
});

function positive(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : d;
}

/** 응답 payload 안의 단계별 시간을 한 줄로 (HarnessResult.facts.timings, 파이프라인 형식 facts.timings, 출력 modelMs) */
function timingDetail(p: unknown): string {
  const o = p as { facts?: Record<string, unknown>; action?: { facts?: Record<string, string> }; modelMs?: number } | undefined;
  if (!o) return '';
  let t = o.facts?.['timings'] as { stages?: TimingEntry[] } | undefined;
  if (!t && o.action?.facts?.['timings']) {
    try {
      t = JSON.parse(o.action.facts['timings']) as { stages?: TimingEntry[] };
    } catch {
      t = undefined;
    }
  }
  const parts: string[] = [];
  if (t?.stages?.length) parts.push(summarizeTimings(t.stages));
  if (typeof o.modelMs === 'number') parts.push(`llm.output ${o.modelMs}ms`);
  return parts.length ? ` — ${parts.join(', ')}` : '';
}
