import { describe, expect, it } from 'vitest';
import { GitHubReviewGateway, GitHubTransportError, RestGitHubTransport } from '@deskpet/gateways';
import { reviewFacts } from '@deskpet/harness';
import { fallbackText } from '@deskpet/output';
import { PR, REPO, SHA_A, T0 } from '../../../tests/support/builders.js';

type Route = (url: URL, init: RequestInit) => { status: number; body: unknown } | undefined;

function fakeFetch(routes: Route[], seen: { method: string; url: string; auth: string | null }[] = []) {
  return (async (u: URL, init: RequestInit) => {
    seen.push({ method: String(init.method), url: u.pathname + u.search, auth: new Headers(init.headers).get('authorization') });
    for (const r of routes) {
      const hit = r(u, init);
      if (hit) return new Response(typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body), { status: hit.status });
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as unknown as typeof fetch;
}

const base = `/repos/${REPO.owner}/${REPO.name}`;
const golden: Route[] = [
  (u) => (u.pathname === `${base}/pulls/${PR}` ? { status: 200, body: { title: 'feat', user: { login: 'teammate' }, state: 'open', draft: false, merged_at: null, head: { sha: SHA_A }, base: { ref: 'main', sha: 'b'.repeat(40) } } } : undefined),
  (u) => (u.pathname === `${base}/pulls/${PR}/files` ? { status: 200, body: [{ filename: 'a.ts', status: 'modified', additions: 3, deletions: 1 }] } : undefined),
  (u) => (u.pathname === `${base}/commits/${SHA_A}/check-runs` ? { status: 200, body: { total_count: 1, check_runs: [{ id: 501, name: 'test', status: 'completed', conclusion: 'success', head_sha: SHA_A, started_at: T0, completed_at: T0 }] } } : undefined),
  (u) => (u.pathname === `${base}/branches/main/protection/required_status_checks` ? { status: 200, body: { contexts: ['test'], checks: [{ context: 'test' }] } } : undefined),
  (u) => (u.pathname === `${base}/pulls/${PR}/reviews` ? { status: 200, body: [{ id: 77, user: { login: 'copilot-pull-request-reviewer[bot]' }, state: 'COMMENTED', commit_id: SHA_A, submitted_at: T0, body: 'nit' }] } : undefined),
  (u) => (u.pathname === '/user' ? { status: 200, body: { login: 'gomdori' } } : undefined),
  (u) => (u.pathname === `${base}/collaborators/gomdori/permission` ? { status: 200, body: { permission: 'write', role_name: 'write' } } : undefined),
];

describe('RestGitHubTransport', () => {
  it('maps REST responses into a review context and sends a bearer token', async () => {
    const seen: { method: string; url: string; auth: string | null }[] = [];
    const t = new RestGitHubTransport({ token: 'tok', fetchImpl: fakeFetch(golden, seen) });
    const gw = new GitHubReviewGateway({ transport: t, now: () => Date.parse(T0) });
    const ctx = await gw.getReviewContext({ repository: { ...REPO }, prNumber: PR, requestedSections: ['changes', 'checks', 'reviews'], deadlineAt: '2099-01-01T00:00:00.000Z' }, { deadlineAt: '2099-01-01T00:00:00.000Z' });
    expect(ctx.prBasics).toMatchObject({ headSha: SHA_A, state: 'open', author: 'teammate' });
    const checks = ctx.sections.find((s) => s.sectionKind === 'checks');
    expect(checks?.sectionKind === 'checks' && checks.data!.requiredChecks).toEqual({ state: 'configured', names: ['test'], source: 'github_branch_protection' });
    // 파일 API는 SHA 근거가 없으므로 unverified (C-10 / inference)
    expect(ctx.consistency).toBe('unverified');
    expect(ctx.viewer).toEqual({ login: 'gomdori', permission: 'write' });
    expect(checks?.sectionKind === 'checks' && checks.data!.runs[0]).toMatchObject({ id: '501', startedAt: T0, completedAt: T0 });
    expect(seen.every((s) => s.method === 'GET')).toBe(true);
    expect(seen[0]!.auth).toBe('Bearer tok');
  });

  const rc = (t: RestGitHubTransport) => t.read({ kind: 'required_checks', repository: { ...REPO }, baseRef: 'main' }, { timeoutMs: 1000 });
  const classic = (status: number, body: unknown): Route => (u) => (u.pathname.endsWith('/protection/required_status_checks') ? { status, body } : undefined);
  const rules = (body: unknown): Route => (u) => (u.pathname.endsWith('/rules/branches/main') ? { status: 200, body } : undefined);

  it('unprotected branch → none_configured (confirmed absence)', async () => {
    const t = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch([classic(404, { message: 'Branch not protected' })]) });
    expect(await rc(t)).toEqual({ state: 'none_configured', source: 'github_branch_protection' });
  });

  it('free-plan private repo → unavailable with plan_unsupported (not none_configured)', async () => {
    const msg = { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' };
    const t = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch([classic(403, msg)]) });
    expect(await rc(t)).toMatchObject({ state: 'unavailable', reasonCode: 'plan_unsupported' });
  });

  it('other 403 → insufficient_permission', async () => {
    const t = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch([classic(403, { message: 'Resource not accessible by integration' })]) });
    expect(await rc(t)).toMatchObject({ state: 'unavailable', reasonCode: 'insufficient_permission' });
  });

  it('rulesets readable without admin; partial when classic protection is unreadable', async () => {
    const r = rules([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } }, { type: 'pull_request' }]);
    const t1 = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch([r, classic(404, { message: 'Branch not protected' })]) });
    expect(await rc(t1)).toEqual({ state: 'configured', names: ['test'], source: 'github_rulesets' });
    const t2 = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch([r, classic(403, { message: 'Must have admin rights' })]) });
    expect(await rc(t2)).toMatchObject({ state: 'configured', names: ['test'], partial: true, githubUnavailableReason: 'insufficient_permission' });
    const t3 = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch([r, classic(200, { contexts: ['build'] })]) });
    expect(await rc(t3)).toMatchObject({ state: 'configured', names: ['build', 'test'], source: 'github_mixed' });
  });

  it('gateway uses the DeskPet fallback only for plan_unsupported', async () => {
    const plan = classic(403, { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' });
    const mk = (route: Route) =>
      new GitHubReviewGateway({
        transport: new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch([route, ...golden.filter((_, i) => i !== 3)]) }),
        now: () => Date.parse(T0),
        requiredChecksFallback: { 'newline/deskpet': ['test'] },
      });
    const q = { repository: { ...REPO }, prNumber: PR, requestedSections: ['checks' as const], deadlineAt: '2099-01-01T00:00:00.000Z' };
    const c = { deadlineAt: '2099-01-01T00:00:00.000Z' };
    const a = (await mk(plan).getReviewContext(q, c)).sections.find((s) => s.sectionKind === 'checks');
    expect(a?.sectionKind === 'checks' && a.data!.requiredChecks).toEqual({ state: 'configured', names: ['test'], source: 'deskpet_config', githubUnavailableReason: 'plan_unsupported' });
    const b = (await mk(classic(403, { message: 'Resource not accessible' })).getReviewContext(q, c)).sections.find((s) => s.sectionKind === 'checks');
    expect(b?.sectionKind === 'checks' && b.data!.requiredChecks).toMatchObject({ state: 'unknown', reasonCode: 'insufficient_permission' });
  });

  it('refuses to send approvals while writes are disabled', async () => {
    const seen: { method: string; url: string; auth: string | null }[] = [];
    const t = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch(golden, seen) });
    const e = await t.submitApproval({ repository: { ...REPO }, prNumber: PR, commitId: SHA_A, event: 'APPROVE' }, { timeoutMs: 1000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GitHubTransportError);
    expect(e).toMatchObject({ kind: 'not_sent', proof: 'writes_disabled' });
    expect(seen.length).toBe(0);
  });

  it('maps 401 to auth and rate-limit 403 to transient', async () => {
    const t = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch([() => ({ status: 401, body: { message: 'Bad credentials' } })]) });
    await expect(t.read({ kind: 'pr', repository: { ...REPO }, prNumber: PR }, { timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'auth' });
    const t2 = new RestGitHubTransport({ token: 'x', fetchImpl: fakeFetch([() => ({ status: 403, body: { message: 'API rate limit exceeded' } })]) });
    await expect(t2.read({ kind: 'pr', repository: { ...REPO }, prNumber: PR }, { timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'transient' });
  });

  it('requires a token', () => {
    expect(() => new RestGitHubTransport({ token: '' })).toThrow(/GITHUB_TOKEN/);
  });
});

describe('RestGitHubTransport — 리뷰 세부 자료 (감사 F-06)', () => {
  const SHA_OLD = 'c'.repeat(40);
  const withReviews = (reviews: unknown[], comments: unknown[] | 'fail'): Route[] => [
    ...golden.filter((_, i) => i !== 4),
    (u) => (u.pathname === `${base}/pulls/${PR}/reviews` ? { status: 200, body: reviews } : undefined),
    (u) => (u.pathname === `${base}/pulls/${PR}/comments` ? (comments === 'fail' ? { status: 502, body: { message: 'Bad Gateway' } } : { status: 200, body: comments }) : undefined),
  ];
  const copilotReview = (id: number, sha: string) => ({ id, user: { login: 'copilot-pull-request-reviewer[bot]' }, state: 'COMMENTED', commit_id: sha, submitted_at: T0, body: 'Pull request overview' });
  const inline = (reviewId: number, path: string, line: number, body: string) => ({ id: reviewId * 10 + line, pull_request_review_id: reviewId, path, line, body, commit_id: SHA_A, user: { login: 'copilot-pull-request-reviewer[bot]' } });

  async function factsFor(routes: Route[]) {
    const t = new RestGitHubTransport({ token: 'tok', fetchImpl: fakeFetch(routes) });
    const gw = new GitHubReviewGateway({ transport: t, now: () => Date.parse(T0) });
    const ctx = await gw.getReviewContext({ repository: { ...REPO }, prNumber: PR, requestedSections: ['changes', 'checks', 'reviews'], deadlineAt: '2099-01-01T00:00:00.000Z' }, { deadlineAt: '2099-01-01T00:00:00.000Z' });
    return { ctx, facts: reviewFacts(ctx) };
  }

  it('현재 커밋 Copilot 리뷰: 본문은 요약, 코드 줄 지적은 경로·줄과 함께 모은다', async () => {
    const { ctx, facts } = await factsFor(withReviews([copilotReview(77, SHA_A)], [inline(77, 'src/a.ts', 3, 'null 체크'), inline(77, 'src/b.ts', 9, '이름')]));
    const reviews = ctx.sections.find((s) => s.sectionKind === 'reviews');
    expect(reviews?.detailCoverage).toEqual({ inlineComments: 'complete' });
    expect(facts.copilot).toMatchObject({ status: 'current', commentCoverage: 'complete', comments: [{ path: 'src/a.ts', line: 3 }, { path: 'src/b.ts', line: 9 }] });
    // 변경 내용(diff)은 MVP에서 모으지 않는다고 표시
    expect(ctx.sections.find((s) => s.sectionKind === 'changes')?.detailCoverage).toEqual({ patches: 'not_collected' });
    expect(facts.patchCoverage).toBe('not_collected');
  });

  it('이전 커밋 리뷰만 있으면 stale_only', async () => {
    const { facts } = await factsFor(withReviews([copilotReview(70, SHA_OLD)], []));
    expect(facts.copilot?.status).toBe('stale_only');
  });

  it('Copilot 리뷰가 없으면 none', async () => {
    const { facts } = await factsFor(withReviews([], []));
    expect(facts.copilot?.status).toBe('none');
  });

  it('코드 줄 지적 조회가 실패하면 "지적 없음"이라고 하지 않는다', async () => {
    const { ctx, facts } = await factsFor(withReviews([copilotReview(77, SHA_A)], 'fail'));
    expect(ctx.sections.find((s) => s.sectionKind === 'reviews')).toMatchObject({ completeness: 'complete', detailCoverage: { inlineComments: 'unavailable' } });
    expect(facts.copilot).toMatchObject({ status: 'current', comments: [], commentCoverage: 'unavailable' });
    const text = fallbackText({
      outputId: 'o',
      requestRefs: { requestId: 'r', operationIds: [] },
      purpose: 'result',
      actionResults: [],
      facts: { review: { prNumber: PR, repository: `${REPO.owner}/${REPO.name}`, headSha: SHA_A, changes: { fileCount: 1, additions: 3, deletions: 1 }, copilot: facts.copilot } },
      sources: [],
      requiredMeaning: [],
      constraints: { language: 'ko-KR', maxSpeechChars: 300, allowedEmotions: ['neutral'] },
    }).text;
    expect(text).not.toContain('Copilot 지적은 없어요');
    expect(text).toContain('세부 지적은 확인하지 못했어요');
  });
});
