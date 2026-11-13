/* eslint-disable no-console */
import './quietWarnings.js';
/**
 * Harness 서비스 서버 (WebSocket). 파이프라인·데모 클라이언트·웹 화면이 이 서버에 연결한다.
 *
 *   pnpm harness                          # GitHub·Eureka 쓰기 허용이 기본 (D-38, 2026-11-09). 쓰기는 사용자 확인 답변이 있어야만 보낸다 (D-22)
 *                                         # 쓰기에는 DESKPET_STORE_PATH(영속 저장소)가 필요하다. 없으면 쓰기를 끄고 시작한다
 *   pnpm harness --read-only              # 쓰기 모두 끔 (조회만)
 *   pnpm harness --verbose               # 시작 화면에 설정마다 뜻과 .env 이름까지
 *   pnpm harness --no-github-writes       # GitHub 승인만 끔 / --no-eureka-writes: Eureka 쓰기만 끔
 *
 * .env
 *   HARNESS_WS_TOKEN (필수, 16자 이상 — 클라이언트 hello 인증), HARNESS_WS_HOST(기본 127.0.0.1), HARNESS_WS_PORT(기본 8787),
 *   HARNESS_WS_ALLOWED_ORIGINS (브라우저 Origin 허용 목록, 쉼표 구분. 비우면 브라우저 접속 거부)
 *   HARNESS_WS_ALLOWED_CLIENTS (다른 기기 접속 허용 IP·CIDR, 쉼표 구분. HARNESS_WS_HOST를 loopback이 아닌 값으로 줄 때 필수)
 *   HARNESS_WS_TLS_CERT / HARNESS_WS_TLS_KEY (선택, PEM 파일 경로 → wss://)
 *   HARNESS_WS_VIEWER_TOKEN (선택, 16자 이상 — 웹 화면용 구독 전용 토큰. pipeline 토큰과 달라야 함.
 *     비우면 웹 화면(보기 전용)은 토큰 없이 접속된다 (D-45). 접속 IP 허용 목록·Origin 검사는 그대로)
 *   pnpm start -- --web / pnpm harness --web : 서버가 뜨면 이 기기의 기본 브라우저로 웹 화면을 연다 (D-46, 임시)
 *   pnpm start는 감시 프로세스(scripts/supervise.ts)로 서버를 띄워, 웹에서 업데이트하면 자동으로 다시 시작한다 (D-50)
 *   DESKPET_HISTORY_PATH (세션 기록 JSONL, 기본 DESKPET_STORE_PATH와 같은 폴더의 history.jsonl, off로 끔) (D-47)
 *   HARNESS_UPDATE_CHECK (기본 on — git fetch로 새 버전 확인, off로 끔), HARNESS_UPDATE_CHECK_MINUTES (기본 30) (D-49)
 *   HARNESS_WEB_ADMIN_TOKEN (선택, 16자 이상·다른 토큰과 다름 — 웹 설정에 넣으면 업데이트 버튼 사용) (D-50)
 *   HARNESS_WEB (기본 on — 빌드한 웹 화면을 같은 주소·포트로 내보냄, off로 끔), HARNESS_WEB_DIR (기본 apps/web/dist, 상대경로는 app 폴더 기준) (D-42)
 *   GITHUB_TOKEN, EUREKA_API_KEY, EUREKA_BASE_URL, DESKPET_REQUIRED_CHECKS, DESKPET_STORE_PATH, LLM_* (기존과 같음)
 * 비밀값은 출력하지 않는다. 쓰기는 기본으로 켜져 있고 사용자 확인 답변으로만 보낸다. 서버 콘솔 yes 확인은 없앴다 (사용자 결정 2026-10-24, D-22).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { renderBanner, type BannerRow, type BannerSection } from './banner.js';
import { Updater, type UpdateStatus } from './updater.js';
import { RESTART_EXIT_CODE } from './restartCode.js';
import { APP_ROOT, resolveWikiDir } from './wikiPath.js';
import { networkInterfaces } from 'node:os';
import { createEurekaRestGateway, EUREKA_DEFAULT_BASE_URL, GitHubReviewGateway, parseRequiredChecksFallback, RestGitHubTransport } from '@deskpet/gateways';
import { DEFAULT_POLICY, FileWikiReader, HarnessService, InMemoryOperationStore, RecoveryWorker, summarizeTimings, type TimingEntry, StoreLockedError, randomIdGen, systemClock } from '@deskpet/harness';
import { createLlmFromEnv } from '@deskpet/llm';
import { OutputService, fallbackText, mapHarnessResult } from '@deskpet/output';
import { ConcurrencyLimiter, parseAllowedRepositories, type FollowUpNotice } from '@deskpet/contracts';
import { DirectHarnessInbound, EurekaBridge, HarnessWsServer, HistoryLog, PipelineBridge } from '@deskpet/server';

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
  const at = env['HARNESS_WEB_ADMIN_TOKEN']?.trim();
  if (at && at.length < 24) fail('다른 기기 접속을 열 때는 HARNESS_WEB_ADMIN_TOKEN도 24자 이상으로 해 주세요');
}
// 관리 토큰 (D-50): 웹 화면에서 업데이트를 누를 수 있게 한다. 없으면 웹은 알림만
const adminToken = env['HARNESS_WEB_ADMIN_TOKEN']?.trim() || undefined;
if (adminToken && adminToken.length < 16) fail('HARNESS_WEB_ADMIN_TOKEN은 16자 이상이어야 해요');
if (adminToken && (adminToken === token || adminToken === env['HARNESS_WS_VIEWER_TOKEN']?.trim())) fail('HARNESS_WEB_ADMIN_TOKEN은 다른 토큰(HARNESS_WS_TOKEN·HARNESS_WS_VIEWER_TOKEN)과 달라야 해요');
if (!!tlsCert !== !!tlsKey) fail('TLS를 쓰려면 HARNESS_WS_TLS_CERT와 HARNESS_WS_TLS_KEY를 둘 다 주세요 (PEM 파일 경로)');
const tls = tlsCert && tlsKey ? (() => {
  try {
    return { cert: readFileSync(tlsCert, 'utf8'), key: readFileSync(tlsKey, 'utf8') };
  } catch (e) {
    return fail(`TLS 인증서·키를 읽지 못했어요: ${e instanceof Error ? e.message : String(e)}`);
  }
})() : undefined;

// ------------------------------------------------------ 웹 화면 서빙 (D-42)
// 빌드한 웹(pnpm web:build → apps/web/dist)을 Harness 서버와 같은 주소·포트로 내보낸다. Jetson에서 브라우저로 http://<주소>:8787 만 열면 된다.
// 상대경로는 실행 위치가 아니라 app 폴더 기준으로 해석한다
const appRoot = APP_ROOT;
const webEnabled = (env['HARNESS_WEB'] ?? 'on').trim().toLowerCase() !== 'off';
const webDirRaw = env['HARNESS_WEB_DIR']?.trim() || 'apps/web/dist';
const webDir = isAbsolute(webDirRaw) ? webDirRaw : resolve(appRoot, webDirRaw);
const webBuilt = existsSync(resolve(webDir, 'index.html'));

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
  // D-41: 리뷰 뒤 승인 조건이 맞으면 확인 질문을 붙임 (DESKPET_OFFER_APPROVAL_AFTER_REVIEW=off로 끔)
  offerApprovalAfterReview: (env['DESKPET_OFFER_APPROVAL_AFTER_REVIEW'] ?? 'on').trim().toLowerCase() !== 'off',
  // D-39: 승인 요청 단계 입력 검사. 기본 loose (STT 정확도가 오르면 DESKPET_APPROVAL_REQUEST_INPUT=strict)
  approvalRequestInput: (env['DESKPET_APPROVAL_REQUEST_INPUT']?.trim() === 'strict' ? 'strict' : 'loose') as 'loose' | 'strict',
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
// Eureka 주소 (기본 EUREKA_DEFAULT_BASE_URL, .env EUREKA_BASE_URL로 바꿈). 주소로 쓰기를 구분하지 않는다 (2026-11-14 사용자 결정)
const eurekaBase = env['EUREKA_BASE_URL']?.trim() || EUREKA_DEFAULT_BASE_URL;
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
// PR CI 검사 (D-30): 기본은 조회하지 않고 승인 조건에서도 뺀다 (사용자 결정 2026-11-03). enforce로 되돌린다
const prChecks: 'enforce' | 'skip' = (env['DESKPET_PR_CHECKS'] ?? 'skip').trim().toLowerCase() === 'enforce' ? 'enforce' : 'skip';
const github = new GitHubReviewGateway({
  transport: new RestGitHubTransport({ token: githubToken, allowWrites: allowGithubWrites, limiter: githubLimiter }),
  now: () => Date.now(),
  requiredChecksFallback: parseRequiredChecksFallback(env['DESKPET_REQUIRED_CHECKS']),
  checksPolicy: prChecks,
});
config.prChecks = prChecks;
const eureka = createEurekaRestGateway(env, undefined, { allowWrites: allowEurekaWrites, limiter: eurekaLimiter });
const llm = createLlmFromEnv(env);
// LLM Wiki (D-19, D-43): vault 루트 경로. 비우면 app 폴더 옆 ../knowledge, 상대경로는 app 폴더 기준. 없으면 Wiki 검색을 하지 않는다
const wikiDir = resolveWikiDir(env['DESKPET_WIKI_DIR']);
const wiki = wikiDir.enabled ? new FileWikiReader({ root: wikiDir.dir }) : undefined;
// 요청이 끝난 뒤 확정된 결과(늦게 끝난 Eureka 반영, 주기 복구)는 pipeline 연결에 notice로 알린다 (D-23)
let notify: (n: FollowUpNotice) => void = () => undefined;
const harness = new HarnessService({ store, github, eureka, clock: systemClock, ids: randomIdGen, config, holderId: `server-${process.pid}`, ...(llm.guideClient ? { llm: llm.guideClient } : {}), ...(wiki ? { wiki } : {}), onFollowUp: (n) => notify(n) });
// 결과 불명·판정 대기 작업 주기 확인. 다시 보내지 않고 조회만 한다 (D-23). RECOVERY_INTERVAL_MS(기본 30초)
const recovery = new RecoveryWorker({ harness, store, clock: systemClock, intervalMs: Number(env['RECOVERY_INTERVAL_MS']) || 30_000, log: (l) => console.log(`[recovery] ${l}`) });
const output = new OutputService(llm.outputModel ? { model: llm.outputModel, ...(llm.outputTimeoutMs ? { modelTimeoutMs: llm.outputTimeoutMs } : {}) } : {});

// 세션 기록 (D-47): 발화 → 결과를 JSONL로 남겨 웹 화면 '기록'에서 본다. 기본은 저장소 옆 history.jsonl, 저장소가 메모리면 메모리만
const historyRaw = env['DESKPET_HISTORY_PATH']?.trim();
const historyPath = historyRaw?.toLowerCase() === 'off' ? undefined : historyRaw ? (isAbsolute(historyRaw) ? historyRaw : resolve(appRoot, historyRaw)) : storePath ? resolve(dirname(isAbsolute(storePath) ? storePath : resolve(appRoot, storePath)), 'history.jsonl') : undefined;
const history = historyRaw?.toLowerCase() === 'off' ? undefined : new HistoryLog({ ...(historyPath ? { path: historyPath } : {}), log: (l) => console.log(`! ${l}`) });

const pipelineBridge = new PipelineBridge({ harness, store, output });
// 직접 Eureka 요청을 별도 프로세스(pnpm eureka:server, D-31)로 옮겼으면 이 서버는 eureka.*를 받지 않는다 (기록 권위를 한 곳에)
const eurekaBridgeMode = (env['DESKPET_EUREKA_BRIDGE'] ?? 'internal').trim().toLowerCase() === 'external' ? 'external' : 'internal';
const server: HarnessWsServer = new HarnessWsServer({
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
  // D-45: 보기 전용 토큰을 비우면 웹 화면은 토큰 없이 접속 (구독만, 실행 불가)
  ...(env['HARNESS_WS_VIEWER_TOKEN']?.trim() ? { viewerToken: env['HARNESS_WS_VIEWER_TOKEN'].trim() } : { openViewer: true }),
  ...(adminToken ? { adminToken, admin: (action: 'update.check' | 'update.apply'): Promise<{ ok: boolean; message: string }> => (action === 'update.apply' ? updater.apply() : updater.check().then((s: UpdateStatus) => ({ ok: s.state !== 'check_failed', message: s.message ?? s.state }))) } : {}),
  ...(history ? { history } : {}),
  info: () => serverInfo(),
  host: wsHost,
  allowedClients,
  ...(tls ? { tls } : {}),
  ...(webEnabled ? { web: { root: webDir } } : {}),
  port: Number(env['HARNESS_WS_PORT']) || 8787,
  allowedOrigins: (env['HARNESS_WS_ALLOWED_ORIGINS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  // 시작 줄(주소·epoch)은 시작 화면에 이미 나오므로 한 번만 숨긴다
  log: (l) => {
    if (quietStartLine && l.startsWith('Harness WebSocket 서버 ws')) return void (quietStartLine = false);
    console.log(`[server] ${l}`);
  },
  // 단계별 처리 시간 (NFR-01, D-26). DESKPET_TIMING_LOG=off면 끈다
  ...(env['DESKPET_TIMING_LOG']?.trim() === 'off' ? {} : { onCompleted: (i: { kind: string; requestId: string; ms: number; ok: boolean; payload?: unknown }) => console.log(`[timing] ${i.kind} ${i.requestId} ${i.ms}ms${i.ok ? '' : ' (거부·오류)'}${timingDetail(i.payload)}`) }),
});
// 업데이트 확인·적용 (D-49, D-50). app 폴더 git 저장소의 upstream과 비교
const supervised = env['DESKPET_SUPERVISED'] === '1';
const updateCheck = (env['HARNESS_UPDATE_CHECK'] ?? 'on').trim().toLowerCase() !== 'off';
const updateCheckMinutes = positive(env['HARNESS_UPDATE_CHECK_MINUTES'], 30);
const updater: Updater = new Updater({
  cwd: appRoot,
  canApply: !!adminToken,
  inFlight: (): number => server.inFlightCount,
  restart: () => {
    if (!supervised) return 'manual';
    // 응답·상태 알림을 보낼 시간을 두고 종료 → 감시 프로세스가 새 코드로 다시 띄운다
    setTimeout(() => void shutdown('업데이트', RESTART_EXIT_CODE), 1_500);
    return 'restarting';
  },
  onChange: () => server.publishInfo(),
  log: (l) => console.log(`[update] ${l}`),
});
function serverInfo() {
  return {
    startedAt: history?.sessionId ?? startedAt,
    version: updater.status.current,
    update: updater.status,
    admin: !!adminToken,
    history: history ? { persistent: !!historyPath } : null,
    supervised,
  };
}

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

const startedAt = new Date().toISOString();
let quietStartLine = false;

async function main() {
  // 저장소 정리·재시작 복구 (이전 실행에서 결과를 모르는 쓰기는 다시 보내지 않고 읽기로만 확인한다)
  const storeRows: BannerRow[] = [];
  if (storePath) {
    const cleaned = await store.maintain();
    const all = await store.listOperations();
    const needed = all.filter((o) => o.recovery === 'needed');
    storeRows.push(['작업', `${storePath} · ${all.length}건${needed.length ? ` (결과 확인 필요 ${needed.length}건)` : ''}${cleaned ? ` · 정리 ${cleaned}건` : ''}`]);
    for (const op of needed) {
      const rec = await harness.reconcile(op.operationId, `server-recover-${Date.now().toString(36)}`, { deadlineAt: new Date(Date.now() + 30_000).toISOString() });
      storeRows.push(['', `· 재시작 복구 ${op.action} [${op.requestId}]: ${rec.status}${rec.actionResult ? ` → ${rec.actionResult.status}` : ''}`]);
    }
  } else storeRows.push(['작업', '메모리 — 서버를 끄면 사라짐 (DESKPET_STORE_PATH)']);
  storeRows.push(['기록', history ? (historyPath ? `${shortPath(historyPath)} · ${history.size}건` : '메모리 — 서버를 끄면 사라짐') : '꺼짐']);
  storeRows.push(['Wiki', wikiDir.enabled ? wikiDir.raw : `꺼짐 (${wikiDir.reason.split(' (')[0]})`]);

  await updater.readCurrent();
  const cur = updater.status.current;
  const port = Number(env['HARNESS_WS_PORT']) || 8787;
  const lanAddrs = lan ? Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address) : [];
  const viewerToken = !!env['HARNESS_WS_VIEWER_TOKEN']?.trim();
  const webScheme = tls ? 'https' : 'http';
  const webUrls = (lan ? lanAddrs : [wsHost]).map((h) => `${webScheme}://${h}:${port}`);
  const on = (b: boolean) => (b ? '켜짐' : '꺼짐');

  const warnings = [...writeWarnings];
  // 쓰기는 기본 허용이라 표에는 넣지 않고, 꺼졌을 때만 알린다
  if (readOnly) warnings.push('읽기 전용(--read-only): GitHub 승인·Eureka 반영을 보내지 않아요');
  else if (!writeWarnings.length && (!allowGithubWrites || !allowEurekaWrites)) warnings.push(`쓰기 꺼짐: ${[!allowGithubWrites && 'GitHub', !allowEurekaWrites && 'Eureka'].filter(Boolean).join('·')}`);
  if (lan && !tls) warnings.push('TLS 없이 다른 기기 접속을 열었어요. 토큰이 암호화 없이 오가니 믿을 수 있는 네트워크에서만 쓰세요');
  if (lan && !viewerToken) warnings.push(`웹 화면에 토큰이 없어요. 허용 IP(${allowedClients.join(', ')}) 안의 누구나 작업·기록을 볼 수 있어요 (HARNESS_WS_VIEWER_TOKEN)`);
  if (intentRecheck && !llm.guideClient) warnings.push('2차 의도 확인이 켜져 있지만 LLM이 없어 동작하지 않아요');
  if (webEnabled && !webBuilt) warnings.push(`웹 화면 빌드가 없어요 (${webDirRaw}) → pnpm start로 실행하세요`);

  const sections: BannerSection[] = [
    {
      title: '접속',
      rows: [
        ['웹 화면', !webEnabled ? '꺼짐 (HARNESS_WEB=off)' : !webBuilt ? '빌드 없음' : `${webUrls.join(', ')}  ${viewerToken ? '(보기 전용 토큰 필요)' : '(토큰 없이 보기 전용)'}`],
        ['다른 기기', lan ? `허용 ${allowedClients.join(', ')}${tls ? ' · TLS' : ''}` : '꺼짐 (이 기기에서만)'],
        ...(eurekaBridgeMode === 'external' ? ([['Eureka 요청', '받지 않음 → pnpm eureka:server']] as BannerRow[]) : []),
      ],
    },
    { title: 'LLM', rows: [['', llm.enabled ? `${llm.provider} / ${llm.model} · 동시 ${llm.limiter?.stats().max ?? '-'}건` : `꺼짐 (${llm.reason})`]] },
    { title: '저장', rows: storeRows },
    {
      title: '정책',
      rows: [
        ['', `PR 검사 ${prChecks === 'skip' ? '생략' : '확인'} · 승인 허용 저장소 ${allowed.repos.length ? allowed.repos.join(', ') : '제한 없음'} · 리뷰 뒤 승인 질문 ${on(config.offerApprovalAfterReview)}`],
        ['', `승인 요청 ${config.approvalRequestInput === 'strict' ? '엄격' : '느슨'} · 신뢰도 STT ${config.minSttConfidenceForWrite} / 라우터 ${config.minRouteConfidenceForWrite} · 의도 재확인 ${on(intentRecheck && !!llm.guideClient)} · 완료 근거 기록 ${on(evidenceNote)}`],
      ],
    },
    {
      title: '업데이트',
      rows: [['', `${updateCheck && cur ? `${updateCheckMinutes}분마다 확인` : '확인 꺼짐'} · 웹 버튼 ${adminToken ? (supervised ? '켜짐 (자동 재시작)' : '켜짐 (재시작은 직접 — pnpm start면 자동)') : '꺼짐 (HARNESS_WEB_ADMIN_TOKEN 없음)'}`]],
    },
  ];

  quietStartLine = true;
  await server.start();
  recovery.start();
  if (updateCheck && cur) updater.start(updateCheckMinutes * 60_000);
  const now = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  console.log(
    renderBanner({
      title: `DeskPet Harness 서버   ${cur ? `${cur.commit} (${cur.branch})` : '버전 알 수 없음'} · ${now}${env['DESKPET_RESTARTED'] ? ' · 업데이트 뒤 다시 시작' : ''}`,
      sections,
      warnings,
      footer: [`Ctrl+C로 종료하면 처리 중인 요청을 마친 뒤 닫습니다.${process.argv.includes('--verbose') ? '' : ' 설정 설명 전체: --verbose'}`],
    }),
  );
  if (process.argv.includes('--verbose')) printDetails();
  // 업데이트 뒤 자동 재시작이면 브라우저를 다시 열지 않는다 (열려 있는 화면이 다시 연결됨)
  if (process.argv.includes('--web') && !env['DESKPET_RESTARTED']) openBrowser();
}

/** app 폴더 안의 경로는 상대경로로 짧게 */
function shortPath(p: string): string {
  const r = relative(appRoot, p);
  return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : p;
}

/** --verbose: 설정마다 뜻과 되돌리는 .env 이름까지 (예전 시작 화면) */
function printDetails() {
  const origins = (env['HARNESS_WS_ALLOWED_ORIGINS'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const lines = [
    `직접 Eureka 요청(eureka.*): ${eurekaBridgeMode === 'internal' ? '이 서버에서 받음' : '받지 않음 — Eureka 내부 API 서버(pnpm eureka:server)로 (DESKPET_EUREKA_BRIDGE=external)'}`,
    `PR 검사(D-30): ${prChecks === 'skip' ? '조회하지 않음 — 승인 조건에서도 제외 (DESKPET_PR_CHECKS=enforce로 되돌림)' : '조회·필수 검사 확인'}`,
    `승인 허용 저장소(D-36): ${allowed.repos.length ? allowed.repos.join(', ') : '제한 없음 (DESKPET_ALLOWED_REPOS 비어 있음)'}`,
    `리뷰 뒤 승인 질문(D-41): ${config.offerApprovalAfterReview ? '켜짐 — 승인 가능하면 "…승인할까요?"를 붙이고, 아니면 이유를 한 문장 (DESKPET_OFFER_APPROVAL_AFTER_REVIEW=off)' : '꺼짐'}`,
    `승인 요청 입력(D-39): ${config.approvalRequestInput === 'strict' ? '엄격 — 요청부터 신뢰도 기준 적용' : '느슨 — 요청은 신뢰도로 막지 않고 확인 질문까지, 확인 답변에만 기준 적용 (DESKPET_APPROVAL_REQUEST_INPUT=strict로 되돌림)'}`,
    `쓰기 입력 신뢰도 기준: STT ${config.minSttConfidenceForWrite}${minStt !== undefined ? ' (.env로 바꿈)' : ''}, 라우터 ${config.minRouteConfidenceForWrite}${minRoute !== undefined ? ' (.env로 바꿈)' : ''} (DESKPET_MIN_STT_CONFIDENCE / DESKPET_MIN_ROUTE_CONFIDENCE)`,
    `2차 의도 확인(D-29): ${intentRecheck ? (llm.guideClient ? '켜짐 — llm·unclear 요청을 LLM이 다시 보고 PR 리뷰·승인이면 규칙 경로로' : '켜져 있지만 LLM 없음 (동작 안 함)') : '꺼짐 (DESKPET_INTENT_RECHECK=off)'}`,
    `완료 근거 기록(D-28): ${evidenceNote ? `켜짐 — 단계 완료 확인에 함께 묻고 단계 기록에 PR 주소를 남김${env['EUREKA_NOTE_ACTOR_ID']?.trim() ? ' (작성자 actorId 지정)' : ' (작성자 actorId 없음)'}` : '꺼짐 (EUREKA_EVIDENCE_NOTE=off)'}`,
    `Eureka 주소: ${eurekaBase}`,
    `동시 호출 상한(D-24): GitHub ${githubLimiter.stats().max} / Eureka ${eurekaLimiter.stats().max} (GITHUB_MAX_CONCURRENT / EUREKA_MAX_CONCURRENT)`,
    `웹 화면 접속: ${env['HARNESS_WS_VIEWER_TOKEN']?.trim() ? '보기 전용 토큰 설정됨' : '토큰 없이 보기 전용 (HARNESS_WS_VIEWER_TOKEN 비어 있음, D-45)'}${webEnabled ? ' — 이 서버가 내보낸 화면은 Origin 설정 없이 접속' : ''}${origins.length ? `, 추가 허용 Origin ${origins.join(', ')}` : ''}`,
    `세션 기록(D-47): ${history ? (historyPath ?? '메모리') : '꺼짐 (DESKPET_HISTORY_PATH=off)'}`,
    `Wiki: ${wikiDir.enabled ? `${wikiDir.raw}${wikiDir.source === 'default' ? ' (기본값)' : ''} → ${wikiDir.dir}` : `꺼짐 — ${wikiDir.reason}`}`,
    `업데이트(D-49·D-50): ${updater.status.current ? `${updater.status.current.commit} ${updater.status.current.subject}` : '버전 알 수 없음'} · 확인 ${updateCheck ? `${updateCheckMinutes}분마다 (HARNESS_UPDATE_CHECK_MINUTES)` : '꺼짐'} · 웹 버튼 ${adminToken ? '켜짐' : '꺼짐 (HARNESS_WEB_ADMIN_TOKEN)'} · 자동 재시작 ${supervised ? '켜짐 (pnpm start)' : '꺼짐 (pnpm harness)'}`,
  ];
  console.log(['  [자세한 설정]', ...lines.map((l) => `  · ${l}`)].join('\n'));
}

/**
 * --web (D-46, 임시): 서버가 뜨면 이 기기의 기본 브라우저로 웹 화면을 연다. 실패해도 서버는 그대로 둔다.
 * 화면이 없는 곳(SSH만 연결)에서는 DISPLAY=:0(Jetson 데스크톱)으로 시도한다
 */
function openBrowser() {
  const port = Number(env['HARNESS_WS_PORT']) || 8787;
  const url = `${tls ? 'https' : 'http'}://127.0.0.1:${port}/`;
  if (!webEnabled || !webBuilt) {
    console.log(`! --web: 웹 화면이 ${!webEnabled ? '꺼져 있어서(HARNESS_WEB=off)' : '빌드되지 않아서(pnpm start로 실행하세요)'} 브라우저를 열지 않았어요`);
    return;
  }
  const [cmd, args, extraEnv]: [string, string[], Record<string, string>] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url], {}]
    : process.platform === 'darwin' ? ['open', [url], {}]
    : ['xdg-open', [url], env['DISPLAY'] || env['WAYLAND_DISPLAY'] ? {} : { DISPLAY: ':0' }];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...process.env, ...extraEnv } });
    child.on('error', (e) => console.log(`! --web: 브라우저를 열지 못했어요 (${e.message}). 직접 ${url} 을 여세요`));
    child.unref();
    console.log(`--web: 브라우저로 ${url} 을 열었어요`);
  } catch (e) {
    console.log(`! --web: 브라우저를 열지 못했어요 (${e instanceof Error ? e.message : String(e)}). 직접 ${url} 을 여세요`);
  }
}

let closing = false;
async function shutdown(sig: string, exitCode = 0) {
  if (closing) return;
  closing = true;
  console.log(`\n${sig} 수신 — 처리 중인 요청을 마치고 종료합니다 (최대 30초)`);
  updater.stop();
  await recovery.stop();
  await server.stop(30_000);
  await harness.drainBackground();
  store.close();
  process.exit(exitCode);
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
