/* eslint-disable no-console */
/**
 * 연결 테스트 (읽기 전용). 실제 Eureka·GitHub에 GET 요청만 보낸다. 쓰기 메서드는 호출하지 않는다.
 *
 *   pnpm smoke              # Eureka + GitHub
 *   pnpm smoke eureka       # Eureka만
 *   pnpm smoke github       # GitHub만
 *   pnpm smoke llm          # LLM만 (LLM_PROVIDER=gemini|openai일 때 작은 호출 2번: Guide 단계 1회, 출력 문장 1회)
 *
 * .env 값: EUREKA_API_KEY, EUREKA_BASE_URL(기본 flw-d1), EUREKA_TEST_ITEM_ID(선택),
 *          GITHUB_TOKEN, GITHUB_TEST_REPO(owner/name, 선택), GITHUB_TEST_PR(선택)
 * 키·토큰 값은 출력하지 않는다.
 */
import { EurekaGateway, FetchHttpClient, GitHubReviewGateway, RestGitHubTransport, EUREKA_DEV_BASE_URL, parseRequiredChecksFallback } from '@deskpet/gateways';
import { GUIDE_INSTRUCTIONS, GUIDE_JSON_SCHEMA, InMemoryOperationStore, randomIdGen, reviewFacts, systemClock } from '@deskpet/harness';
import { EurekaBridge } from '@deskpet/server';
import { createLlmFromEnv } from '@deskpet/llm';
import { OUTPUT_INSTRUCTIONS } from '@deskpet/output';
import type { ErrorInfo } from '@deskpet/contracts';

try {
  process.loadEnvFile('.env');
} catch {
  console.log('! .env 파일을 찾지 못했어요. app 폴더에서 실행했는지 확인하세요.');
}

const env = process.env;
const only = process.argv[2];
let failures = 0;

const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string, hint?: string) => {
  failures += 1;
  console.log(`  ✗ ${msg}${hint ? `\n      → ${hint}` : ''}`);
};
const skip = (msg: string) => console.log(`  - ${msg}`);
const errText = (e?: ErrorInfo) => (e ? `${e.provisionalCode}: ${e.message}` : 'unknown error');
const REASON_KO: Record<string, string> = {
  plan_unsupported: '요금제상 GitHub 보호 기능 없음',
  insufficient_permission: '설정을 볼 권한 없음',
  lookup_failed: '조회 실패',
};
const deadline = () => ({ deadlineAt: new Date(Date.now() + 20_000).toISOString() });

async function eureka() {
  console.log('\n[Eureka]');
  const key = env['EUREKA_API_KEY'];
  const baseUrl = env['EUREKA_BASE_URL'] || EUREKA_DEV_BASE_URL;
  if (!key) return bad('EUREKA_API_KEY가 비어 있어요');
  console.log(`  base URL: ${baseUrl}  (키 길이 ${key.length})`);
  const gw = new EurekaGateway({ http: new FetchHttpClient(baseUrl, () => ({ 'x-api-key': key })), now: () => Date.now() });

  const s = await gw.checkSession(deadline());
  if (!s.ok) {
    const code = s.result.error?.provisionalCode;
    return bad(
      `세션 확인 실패 — ${errText(s.result.error)}`,
      code === 'EUREKA_AUTH_ERROR' ? '키가 틀렸거나 base URL(flw-d1 개발 / flw-v1 운영)이 키와 맞지 않을 수 있어요' : '네트워크 또는 base URL을 확인하세요',
    );
  }
  ok(`세션 확인: workspace sid=${s.data!.sid}, roles=${s.data!.roles.join(',') || '-'}`);

  const p = await gw.listProcesses(deadline());
  if (p.ok) ok(`템플릿 ${p.data!.length}개: ${p.data!.slice(0, 3).map((x) => x.name.trim()).join(', ')}${p.data!.length > 3 ? ' …' : ''}`);
  else bad(`템플릿 목록 실패 — ${errText(p.result.error)}`);

  const t = await gw.listTasks({ limit: 100 }, deadline());
  if (!t.ok) return bad(`업무 목록 실패 — ${errText(t.result.error)}`);
  const items = t.data!.items;
  ok(`업무 ${items.length}건 (total=${t.data!.total ?? '?'}, completeness=${t.data!.completeness})`);
  for (const i of items.slice(0, 5)) {
    console.log(`      · [${i.itemId}] ${i.name} — ${i.computedState}${i.dueAt ? `, due ${i.dueAt}` : ''}`);
    // 단계마다 ID를 함께 표시한다 (pnpm demo의 DEMO_EUREKA_STAGE_ID에 넣는 값)
    for (const st of i.stages) console.log(`          - stage ${st.stageId}: ${st.name || '(이름 없음)'} [${st.status}]`);
  }
  const withDescription = items.filter((i) => i.description !== undefined).length;
  skip(`description 필드가 있는 업무 ${withDescription}/${items.length}건 (README C-08 확인용)`);

  // 파이프라인 문서의 EurekaAdapter.reminders() — 설명·마감이 있는 열린 업무만 (읽기 전용)
  const bridge = new EurekaBridge({ eureka: gw, store: new InMemoryOperationStore({ clock: systemClock, ids: randomIdGen, capacityBytes: 1 << 20, recoveryBudgetBytes: 0, minRetentionMs: 0, maxRecoveryAttempts: 1 }), clock: systemClock });
  const rem = await bridge.reminders(deadline().deadlineAt);
  ok(`리마인더 대상 ${rem.items.length}건 (설명·마감 없어 제외 ${rem.skipped}건)`);
  for (const r of rem.items.slice(0, 3)) console.log(`      · [${r.itemId}] ${r.description} — 마감 ${r.dueAt}`);

  const itemId = env['EUREKA_TEST_ITEM_ID'] || items[0]?.itemId;
  if (!itemId) return skip('상태를 조회할 업무가 없어요');
  const stageId = items.find((i) => i.itemId === itemId)?.stages[0]?.stageId;
  const st = await gw.getTaskState({ itemId, ...(stageId ? { stageId } : {}) }, deadline());
  if (st.ok) ok(`업무 ${itemId} 상태: ${st.data!.itemStatus} (${st.data!.doneStages}/${st.data!.totalStages} 단계 완료)${st.data!.stage ? `, 첫 단계 ${st.data!.stage.status}` : ''}`);
  else bad(`업무 ${itemId} 상태 조회 실패 — ${errText(st.result.error)}`);
}

async function github() {
  console.log('\n[GitHub]');
  const token = env['GITHUB_TOKEN'];
  if (!token) return bad('GITHUB_TOKEN이 비어 있어요');
  console.log(`  토큰 길이 ${token.length}, 쓰기 비활성(allowWrites=false)`);
  const transport = new RestGitHubTransport({ token, allowWrites: false });
  const repoArg = env['GITHUB_TEST_REPO'];
  const [owner, name] = (repoArg ?? '').split('/');
  const repository = owner && name ? { owner, name } : undefined;

  try {
    const v = await transport.read({ kind: 'viewer', repository: repository ?? { owner: '_', name: '_' } }, { timeoutMs: 15_000 });
    ok(`토큰 사용자: ${v.login}${repository ? `, ${repoArg} 권한: ${v.permission}` : ''}`);
    if (repository && v.permission === 'unknown') skip('저장소 권한을 조회하지 못했어요 → 승인 전 검사에서 permission_unverified로 차단됩니다 (D-11)');
  } catch (e) {
    return bad(`토큰 확인 실패 — ${(e as Error).message}`, '토큰이 만료됐거나 잘못 복사됐을 수 있어요');
  }

  if (!repository) return skip('GITHUB_TEST_REPO가 없어서 저장소 조회는 건너뜁니다');
  const prNumber = Number(env['GITHUB_TEST_PR']);
  if (!prNumber) return skip('GITHUB_TEST_PR이 없어서 PR 리뷰 조회는 건너뜁니다');

  const fallback = parseRequiredChecksFallback(env['DESKPET_REQUIRED_CHECKS']);
  if (Object.keys(fallback).length) skip(`DeskPet 대체 필수 검사: ${Object.entries(fallback).map(([k, v]) => `${k}=[${v.join(',')}]`).join('; ')} (GitHub 요금제 미지원일 때만 사용)`);
  const gw = new GitHubReviewGateway({ transport, now: () => Date.now(), requiredChecksFallback: fallback });
  const ctx = await gw.getReviewContext({ repository, prNumber, requestedSections: ['changes', 'checks', 'reviews'], ...deadline() }, deadline());
  if (!ctx.prBasics) return bad(`PR ${repoArg}#${prNumber} 조회 실패 — ${errText(ctx.error)}`, 'fine-grained 토큰이면 해당 저장소의 Pull requests·Contents·Checks 읽기 권한이 필요해요');
  ok(`PR #${prNumber} "${ctx.prBasics.title}" — ${ctx.prBasics.state}${ctx.prBasics.draft ? ' (draft)' : ''}, head ${ctx.initialHeadSha?.slice(0, 7)}, consistency=${ctx.consistency}`);
  for (const s of ctx.sections) {
    const line = `${s.sectionKind}: ${s.availability}/${s.completeness}${s.versionEvidence?.headSha ? ` @${s.versionEvidence.headSha.slice(0, 7)}` : ''}`;
    if (s.availability === 'available') ok(line);
    else bad(line, s.error ? errText(s.error) : undefined);
  }
  const f = reviewFacts(ctx, ctx.initialHeadSha);
  if (f.changes) skip(`변경 파일 ${f.changes.fileCount}개 (+${f.changes.additions}/-${f.changes.deletions})`);
  if (f.checks) {
    const c = f.checks;
    const src = c.requiredSource ? `, 출처 ${c.requiredSource}` : '';
    const why = c.requiredReasonCode ? ` (${REASON_KO[c.requiredReasonCode] ?? c.requiredReasonCode})` : '';
    skip(`필수 검사 설정: ${c.requiredState}${c.required.length ? ` [${c.required.join(', ')}]` : ''}${src}${why}${c.requiredPartial ? ', 일부만 확인' : ''}`);
    if (c.requiredState === 'unknown' && c.requiredReason) skip(`  GitHub 응답: ${c.requiredReason}`);
    if (c.requiredReasonCode === 'plan_unsupported' && c.requiredState === 'unknown') skip('  → .env의 DESKPET_REQUIRED_CHECKS로 대체 목록을 지정할 수 있어요 (예: owner/repo=test)');
    skip(`검사 결과: 실행 ${c.runs.length}개${c.duplicateRuns ? ` (같은 이름의 이전 실행 ${c.duplicateRuns}개 제외)` : ''}, 실패 ${c.failing.length}${c.failing.length ? ` [${c.failing.join(', ')}]` : ''}, 진행 중 ${c.pending.length}`);
  }
  if (f.copilot) skip(`Copilot 리뷰: ${f.copilot.status}`);
  if (f.approvalWarnings.length) skip(`경고(차단 아님): ${f.approvalWarnings.join(', ')}`);
  skip(`지금 승인한다면 차단 사유: ${f.approvalBlockers.length ? f.approvalBlockers.join(', ') : '없음'} (조회만 했고 승인은 하지 않았어요)`);
}

async function llmCheck() {
  console.log('\n[LLM]');
  const s = createLlmFromEnv(env);
  if (!s.enabled) return skip(`꺼짐 — ${s.reason} (켜려면 LLM_PROVIDER=gemini + GEMINI_API_KEY, 또는 LLM_PROVIDER=openai + OPENAI_API_KEY·OPENAI_MODEL)`);
  const keyName = s.provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
  console.log(`  provider ${s.provider}, model ${s.model}, 출력 경로 ${s.outputChain} (키 길이 ${env[keyName]?.length ?? 0})`);
  // 기본 응답 시간: 스키마 없이 아주 짧은 호출 (모델·네트워크 자체가 느린지 구분)
  const tp = Date.now();
  try {
    await s.guideClient!.complete({ purpose: 'guide', instructions: '한 단어로만 답한다.', input: '"확인"이라고만 답해.', maxOutputTokens: 20, deadlineAt: new Date(Date.now() + 30_000).toISOString() });
    ok(`기본 응답 시간: ${Date.now() - tp}ms (짧은 호출)`);
  } catch (e) {
    bad(`짧은 호출도 실패 — ${(e as { code?: string }).code ?? ''} ${(e as Error).message} (${Date.now() - tp}ms)`, '모델·네트워크 자체가 느리거나 막혀 있어요. 잠시 뒤 다시 하거나 GEMINI_MODEL을 바꿔 보세요');
  }
  const t0 = Date.now();
  try {
    const r = await s.guideClient!.complete({
      purpose: 'guide',
      instructions: GUIDE_INSTRUCTIONS,
      input: ['의도(라우터): pr.summary', '사용자 발화: "이 PR 뭐가 바뀌었어?"', '대상: GitHub PR demo/repo#1', '후보 수: 1', '수집된 사실: 없음', '단계: 1'].join('\n'),
      jsonSchema: GUIDE_JSON_SCHEMA,
      maxOutputTokens: 200,
      deadlineAt: new Date(Date.now() + 15_000).toISOString(),
    });
    ok(`Guide 단계 제안: ${JSON.stringify(r.json)} (${Date.now() - t0}ms${r.usage ? `, 토큰 ${r.usage.inputTokens}+${r.usage.outputTokens}` : ''})`);
  } catch (e) {
    bad(`Guide 호출 실패 — ${(e as { code?: string }).code ?? ''} ${(e as Error).message} (${Date.now() - t0}ms / 상한 15000ms)`, '키·모델 이름·요금제(무료 한도) 상태를 확인하세요');
  }
  const t1 = Date.now();
  try {
    const d = await s.outputModel!.generate({
      instructions: OUTPUT_INSTRUCTIONS,
      prompt: ['목적: result', '필수 포함: (없음)', '작업 상태: get_review_context=succeeded', '기준 문장: PR 1번, 현재 커밋 abc1234 기준이에요. 파일 1개가 바뀌었어요.', '기준 화면 문장: PR 1 @abc1234', '허용 표정: neutral, cheerful', '최대 길이: 200자'].join('\n'),
      maxChars: 200,
      allowedEmotions: ['neutral', 'cheerful'],
      deadlineMs: 15_000,
    });
    ok(`출력 문장: "${d.text}" / 화면 "${d.displayText}" / ${d.emotion} (${Date.now() - t1}ms)`);
  } catch (e) {
    bad(`출력 모델 호출 실패 — ${(e as { code?: string }).code ?? ''} ${(e as Error).message} (${Date.now() - t1}ms / 상한 15000ms)`);
  }
}

const run = async () => {
  console.log('DeskPet 연결 테스트 (읽기 전용 — 쓰기 요청은 보내지 않습니다)');
  if (!only || only === 'eureka') await eureka().catch((e) => bad(`Eureka 예외 — ${(e as Error).message}`));
  if (!only || only === 'github') await github().catch((e) => bad(`GitHub 예외 — ${(e as Error).message}`));
  if (only === 'llm') await llmCheck().catch((e) => bad(`LLM 예외 — ${(e as Error).message}`));
  console.log(failures ? `\n실패 ${failures}건` : '\n모두 통과');
  process.exitCode = failures ? 1 : 0;
};
void run();
