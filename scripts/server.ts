/* eslint-disable no-console */
/**
 * Harness 서비스 서버 (WebSocket). 파이프라인·데모 클라이언트·웹 화면이 이 서버에 연결한다.
 *
 *   pnpm harness                          # GitHub·Eureka 쓰기 허용이 기본 (D-38, 2026-11-09). 쓰기는 사용자 확인 답변이 있어야만 보낸다 (D-22)
 *                                         # 쓰기에는 DESKPET_STORE_PATH(영속 저장소)가 필요하다. 없으면 쓰기를 끄고 시작한다
 *   pnpm harness --read-only              # 쓰기 모두 끔 (조회만)
 *   pnpm harness --no-github-writes       # GitHub 승인만 끔 / --no-eureka-writes: Eureka 쓰기만 끔
 *                                         # 예전 옵션 --allow-github-writes·--allow-eureka-writes는 그대로 받지만 아무 효과 없음
 *   pnpm harness … --poc                  # POC 장애 주입 (DESKPET_POC_FAULTS, scripts/poc-faults.ts, D-27)
 *
 * .env
 *   HARNESS_WS_TOKEN (필수, 16자 이상 — 클라이언트 hello 인증), HARNESS_WS_HOST(기본 127.0.0.1), HARNESS_WS_PORT(기본 8787),
 *   HARNESS_WS_ALLOWED_ORIGINS (브라우저 Origin 허용 목록, 쉼표 구분. 비우면 브라우저 접속 거부)
 *   HARNESS_WS_ALLOWED_CLIENTS (다른 기기 접속 허용 IP·CIDR, 쉼표 구분. HARNESS_WS_HOST를 loopback이 아닌 값으로 줄 때 필수)
 *   HARNESS_WS_TLS_CERT / HARNESS_WS_TLS_KEY (선택, PEM 파일 경로 → wss://)
 *   HARNESS_WS_VIEWER_TOKEN (선택, 16자 이상 — 웹 화면용 구독 전용 토큰. pipeline 토큰과 달라야 함)
 *   GITHUB_TOKEN, EUREKA_API_KEY, EUREKA_BASE_URL, DESKPET_REQUIRED_CHECKS, DESKPET_STORE_PATH, LLM_* (기존과 같음)
 * 비밀값은 출력하지 않는다. 쓰기는 기본으로 켜져 있고 사용자 확인 답변으로만 보낸다. 서버 콘솔 yes 확인은 없앴다 (사용자 결정 2026-10-24, D-22).
 */
import { readFileSync } from 'node:fs';
import { pocSetup } from './poc-faults.js';
import { networkInterfaces } from 'node:os';
import { createEurekaRestGateway, GitHubReviewGateway, parseRequiredChecksFallback, RestGitHubTransport } from '@deskpet/gateways';
import { DEFAULT_POLICY, FileWikiReader, HarnessService, InMemoryOperationStore, RecoveryWorker, summarizeTimings, type TimingEntry, StoreLockedError, randomIdGen, systemClock } from '@deskpet/harness';
import { createLlmFromEnv } from '@deskpet/llm';
import { OutputService, fallbackText, mapHarnessResult } from '@deskpet/output';
import { ConcurrencyLimiter, parseAllowedRepositories, type FollowUpNotice } from '@deskpet/contracts';
import { DirectHarnessInbound, EurekaBridge, HarnessWsServer, PipelineBridge } from '@deskpet/server';

try {
  process.loadEnvFile('.env');
} catch {
  console.log('! .env 파일을 찾지 못했어요. app 폴더에서 실행했는지 확인하세요.');
}
const env = process.env;
// 쓰기 허용이 기본 (사용자 결정 2026-11-09, D-38). --read-only·--no-*-writes로 끈다
const readOnly = process.argv.includes('--read-only');
let allowGithubWrites = !readOnly && !process.argv.includes('--no-github-writes');
let allowEurekaWrites = !readOnly && !process.argv.includes('--no-eureka-writes');
const writeWarnings: string[] = [];
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
// 완료 근거 기록 (D-28): 단계 완료 확인에 함께 묻고, 완료되면 단계 기록에 승인 PR 주소를 남긴다. off로 끈다
const evidenceNote = (env['EUREKA_EVIDENCE_NOTE'] ?? 'on').trim().toLowerCase() !== 'off';
// 2차 의도 확인 (D-29): llm·unclear 같은 일반 의도를 LLM이 다시 보고 PR 리뷰·승인이면 규칙 경로로. off로 끈다
const intentRecheck = (env['DESKPET_INTENT_RECHECK'] ?? 'on').trim().toLowerCase() !== 'off';
// 쓰기(승인 요청·확인 답변) 입력 신뢰도 기준. 기본값은 그대로(STT 0.85, 라우터 0.8). 시연 환경에 맞출 때만 .env로 바꾼다 (0~1)
const ratio = (v: string | undefined) => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && n >= 0 && n <= 1 ? n : undefined;
};
const minStt = ratio(env['DESKPET_MIN_STT_CONFIDENCE']);
const minRoute = ratio(env['DESKPET_MIN_ROUTE_CONFIDENCE']);
const allowed = parseAllowedRepositories(env['DESKPET_ALLOWED_REPOS']);
if (allowed.invalid.length) {
  console.log(`✗ DESKPET_ALLOWED_REPOS 형식이 틀렸어요 (owner/name,owner/name): ${allowed.invalid.join(', ')}`);
  process.exit(1);
}
const config = {
  ...DEFAULT_POLICY,
  evidenceNote,
  intentRecheck,
  prChecks: 'enforce' as 'enforce' | 'skip',
  ...(allowed.repos.length ? { allowedRepositories: allowed.repos } : {}),
  ...(guideTimeout > 0 ? { llmGuideTimeoutMs: guideTimeout } : {}),
  ...(minStt !== undefined ? { minSttConfidenceForWrite: minStt } : {}),
  ...(minRoute !== undefined ? { minRouteConfidenceForWrite: minRoute } : {}),
};
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
if ((allowGithubWrites || allowEurekaWrites) && !storePath) {
  allowGithubWrites = false;
  allowEurekaWrites = false;
  writeWarnings.push('DESKPET_STORE_PATH(영속 저장소)가 없어 GitHub·Eureka 쓰기를 끄고 시작해요. .env에 DESKPET_STORE_PATH=.deskpet/harness.db 를 넣으세요');
}
// Eureka 쓰기는 개발판(flw-d1)과 운영판(flw-v1)에서 허용한다. 운영판도 배포 전 닫힌 시험 환경이다 (사용자 결정 2026-11-03, D-20 갱신)
// 그 밖의 주소(오타·다른 서버)에는 쓰지 않는다
const eurekaBase = env['EUREKA_BASE_URL']?.trim() || 'https://api.eureka.codes/flw-d1';
const eurekaEnv = /\/flw-d1\/?$/.test(eurekaBase) ? '개발판 flw-d1' : /\/flw-v1\/?$/.test(eurekaBase) ? '운영판 flw-v1' : undefined;
if (allowEurekaWrites && !eurekaEnv) {
  allowEurekaWrites = false;
  writeWarnings.push(`Eureka 쓰기는 개발판(flw-d1)·운영판(flw-v1) 주소에서만 켜요. 지금 주소(${eurekaBase})라 Eureka 쓰기를 끄고 시작해요`);
}
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
// POC 장애 주입 (D-27): --poc 플래그 + DESKPET_POC_FAULTS + flw-d1·flw-v1일 때만 (scripts/poc-faults.ts)
const poc = (() => {
  try {
    return pocSetup(env, process.argv, (l) => console.log(l));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
})();
// PR CI 검사 (D-30): 기본은 조회하지 않고 승인 조건에서도 뺀다 (사용자 결정 2026-11-03). enforce로 되돌린다
const prChecks: 'enforce' | 'skip' = (env['DESKPET_PR_CHECKS'] ?? 'skip').trim().toLowerCase() === 'enforce' ? 'enforce' : 'skip';
const github = new GitHubReviewGateway({
  transport: new RestGitHubTransport({ token: githubToken, allowWrites: allowGithubWrites, limiter: githubLimiter, ...(poc.githubFetch ? { fetchImpl: poc.githubFetch } : {}) }),
  now: () => Date.now(),
  requiredChecksFallback: parseRequiredChecksFallback(env['DESKPET_REQUIRED_CHECKS']),
  checksPolicy: prChecks,
});
config.prChecks = prChecks;
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
// 직접 Eureka 요청을 별도 프로세스(pnpm eureka:server, D-31)로 옮겼으면 이 서버는 eureka.*를 받지 않는다 (기록 권위를 한 곳에)
const eurekaBridgeMode = (env['DESKPET_EUREKA_BRIDGE'] ?? 'internal').trim().toLowerCase() === 'external' ? 'external' : 'internal';
const server = new HarnessWsServer({
  // 파이프라인 문서 형식(harness.run 등)도 같은 서버에서 받는다 (docs/pipeline-bridge.md)
  inbound: new DirectHarnessInbound({
    harness,
    output,
    bridge: pipelineBridge,
    ...(eurekaBridgeMode === 'internal'
      ? { eurekaBridge: new EurekaBridge({ eureka, store, clock: systemClock, holderId: `server-${process.pid}-eureka`, ...(allowed.repos.length ? { allowedRepositories: allowed.repos } : {}), ...(env['EUREKA_DEFAULT_PROCESS_ID']?.trim() ? { defaultProcessId: env['EUREKA_DEFAULT_PROCESS_ID'].trim() } : {}) }) }
      : {}),
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
      console.log(`[notice] ${n.source} ${n.action} → ${n.status}${sent ? '' : ' (연결된 파이프라인 없음 → 보관, 다음 연결 때 전달)'}: ${text}`);
    });
};

async function main() {
  console.log('DeskPet Harness 서버');
  for (const l of poc.banner) console.log(l);
  console.log(`직접 Eureka 요청(eureka.*): ${eurekaBridgeMode === 'internal' ? '이 서버에서 받음' : '받지 않음 — Eureka 내부 API 서버(pnpm eureka:server)로 (DESKPET_EUREKA_BRIDGE=external)'}`);
  console.log(`PR 검사(D-30): ${prChecks === 'skip' ? '조회하지 않음 — 승인 조건에서도 제외 (DESKPET_PR_CHECKS=enforce로 되돌림)' : '조회·필수 검사 확인'}`);
  console.log(`승인 허용 저장소(D-36): ${allowed.repos.length ? allowed.repos.join(', ') : '제한 없음 (DESKPET_ALLOWED_REPOS 비어 있음)'}`);
  console.log(`쓰기 입력 신뢰도 기준: STT ${config.minSttConfidenceForWrite}${minStt !== undefined ? ' (.env로 바꿈)' : ''}, 라우터 ${config.minRouteConfidenceForWrite}${minRoute !== undefined ? ' (.env로 바꿈)' : ''}`);
  console.log(`2차 의도 확인(D-29): ${intentRecheck ? (llm.guideClient ? '켜짐 — llm·unclear 요청을 LLM이 다시 보고 PR 리뷰·승인이면 규칙 경로로' : '켜져 있지만 LLM 없음 (동작 안 함)') : '꺼짐 (DESKPET_INTENT_RECHECK=off)'}`);
  console.log(`완료 근거 기록(D-28): ${evidenceNote ? `켜짐 — 단계 완료 확인에 함께 묻고 단계 기록에 PR 주소를 남김${env['EUREKA_NOTE_ACTOR_ID']?.trim() ? ' (작성자 actorId 지정)' : ' (작성자 actorId 없음)'}` : '꺼짐 (EUREKA_EVIDENCE_NOTE=off)'}`);
  console.log(`GitHub 쓰기: ${allowGithubWrites ? '허용 (사용자 확인 답변만으로 보냄)' : '꺼짐'}  /  Eureka 쓰기: ${allowEurekaWrites ? `허용 — ${eurekaEnv} ${eurekaBase} (사용자 확인 답변만으로 보냄)` : '꺼짐'}${readOnly ? '  (--read-only)' : ''}`);
  for (const w of writeWarnings) console.log(`! ${w}`);
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
  // 왜 멈췄는지도 한 줄에 (값에 비밀값 없음: 사유 코드·LLM 오류 코드만)
  const f = (o.facts ?? o.action?.facts ?? {}) as Record<string, unknown>;
  const why = (x: unknown) => (typeof x === 'string' ? x : x && typeof x === 'object' ? JSON.stringify(x) : '');
  const unclear = (f['unclearAnswer'] as { reason?: string } | undefined)?.reason ?? f['unclearAnswerReason'];
  if (unclear) parts.push(`답변 불명확: ${why(unclear)}`);
  const blocked = (f['blocked'] as { reasons?: string[] } | undefined)?.reasons?.join(',') ?? f['blockedReasons'];
  if (blocked) parts.push(`차단: ${why(blocked)}`);
  const ir = f['intentRecheck'] as { from?: string; to?: string; error?: string } | undefined;
  if (ir) parts.push(`의도 재확인: ${ir.from}→${ir.to}${ir.error ? ` (${ir.error})` : ''}`);
  const fu = f['followUp'];
  if (fu && (typeof fu === 'string' || (fu as { eligibility?: string }).eligibility !== 'eligible')) parts.push(`Eureka 후속: ${why(fu)}`);
  return parts.length ? ` — ${parts.join(', ')}` : '';
}
