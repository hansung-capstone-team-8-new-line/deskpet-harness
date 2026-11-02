import type { ConcurrencyLimiter, RequiredChecksSource, RequiredChecksUnknownReason, ViewerPermission } from '@deskpet/contracts';
import { FetchHttpClient, HttpTransportError, type HttpClient, type HttpResponse } from '../http.js';
import { parseErrorBody } from '../result.js';
import {
  GitHubTransportError,
  type GitHubTransport,
  type TransportReadQuery,
  type TransportReadResultMap,
  type TransportSubmitResponse,
} from './GitHubTransport.js';

/**
 * GitHub REST adapter (GitHubTransport 구현 후보 — MCP와의 선택은 미정, README C-10).
 * 근거: https://docs.github.com/en/rest/pulls , /checks/runs , /branches/branch-protection , /collaborators
 *
 * 안전장치: `allowWrites`가 false(기본)이면 submitApproval은 전송하지 않고 not_sent 오류를 낸다.
 * 사용자의 명시적 허락 전에는 쓰기를 활성화하지 않는다.
 *
 * inference / 미정
 * - 파일 목록 API는 SHA를 돌려주지 않으므로 changes section의 버전 근거를 만들지 않는다(unverified).
 * - 리뷰 상세 코멘트(pulls/{n}/comments)는 review_comments로 조회한다. Copilot 작성자 판별 login은 추정값이다 (GitHubReviewGateway).
 * - 필수 검사는 rulesets + classic branch protection을 본다. 조회 실패는 이유(plan_unsupported 등)와 함께 반환한다.
 */
export interface RestGitHubTransportOptions {
  token: string;
  baseUrl?: string;
  allowWrites?: boolean;
  http?: HttpClient;
  fetchImpl?: typeof fetch;
  /** GitHub 동시 호출 상한 (D-24) */
  limiter?: ConcurrencyLimiter;
}

export class RestGitHubTransport implements GitHubTransport {
  readonly mode = 'rest' as const;
  private readonly http: HttpClient;
  private readonly allowWrites: boolean;

  get writesEnabled(): boolean {
    return this.allowWrites;
  }

  constructor(o: RestGitHubTransportOptions) {
    if (!o.token) throw new Error('GITHUB_TOKEN is not set (.env)');
    const token = o.token;
    this.allowWrites = o.allowWrites ?? false;
    this.http =
      o.http ??
      new FetchHttpClient(
        o.baseUrl ?? 'https://api.github.com',
        () => ({
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'deskpet-harness-mvp',
        }),
        o.fetchImpl,
        o.limiter,
      );
  }

  async read<K extends TransportReadQuery['kind']>(
    query: Extract<TransportReadQuery, { kind: K }>,
    c: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<TransportReadResultMap[K]> {
    return (await this.readAny(query as TransportReadQuery, c)) as TransportReadResultMap[K];
  }

  private async readAny(q: TransportReadQuery, c: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> {
    const repo = `/repos/${enc(q.repository.owner)}/${enc(q.repository.name)}`;
    switch (q.kind) {
      case 'pr': {
        const b = await this.get(`${repo}/pulls/${q.prNumber}`, c);
        return {
          title: String(b.title ?? ''),
          author: String(b.user?.login ?? ''),
          state: b.merged_at ? 'merged' : b.state === 'closed' ? 'closed' : 'open',
          draft: Boolean(b.draft),
          headSha: String(b.head?.sha),
          baseRef: String(b.base?.ref),
          ...(b.base?.sha ? { baseSha: String(b.base.sha) } : {}),
        } satisfies TransportReadResultMap['pr'];
      }
      case 'files': {
        const b = await this.get(`${repo}/pulls/${q.prNumber}/files`, c, { per_page: String(q.perPage), page: String(q.page) });
        const list = Array.isArray(b) ? b : [];
        return {
          files: list.map((f: Gh) => ({ path: String(f.filename), status: String(f.status), additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0) })),
          hasMore: list.length >= q.perPage,
        } satisfies TransportReadResultMap['files'];
      }
      case 'check_runs': {
        const b = await this.get(`${repo}/commits/${enc(q.ref)}/check-runs`, c, { per_page: String(q.perPage), page: String(q.page) });
        const runs: Gh[] = Array.isArray(b.check_runs) ? b.check_runs : [];
        return {
          runs: runs.map((r) => ({
            name: String(r.name),
            status: (['queued', 'in_progress', 'completed'].includes(r.status) ? r.status : 'queued') as 'queued' | 'in_progress' | 'completed',
            conclusion: r.conclusion ?? null,
            ...(r.head_sha ? { headSha: String(r.head_sha) } : {}),
            ...(r.id !== undefined ? { id: String(r.id) } : {}),
            ...(r.started_at ? { startedAt: new Date(r.started_at).toISOString() } : {}),
            ...(r.completed_at ? { completedAt: new Date(r.completed_at).toISOString() } : {}),
          })),
          resolvedHeadSha: q.ref,
          hasMore: typeof b.total_count === 'number' ? q.page * q.perPage < b.total_count : false,
        } satisfies TransportReadResultMap['check_runs'];
      }
      case 'required_checks':
        return this.requiredChecks(repo, q.baseRef, c);
      case 'reviews': {
        const b = await this.get(`${repo}/pulls/${q.prNumber}/reviews`, c, { per_page: String(q.perPage), page: String(q.page) });
        const list = Array.isArray(b) ? b : [];
        return {
          reviews: list.map((r: Gh) => ({
            reviewId: String(r.id),
            author: String(r.user?.login ?? ''),
            state: String(r.state) as 'APPROVED',
            ...(r.commit_id ? { commitSha: String(r.commit_id) } : {}),
            ...(r.submitted_at ? { submittedAt: new Date(r.submitted_at).toISOString() } : {}),
            comments: r.body ? [{ body: String(r.body), kind: 'summary' as const }] : [],
          })),
          hasMore: list.length >= q.perPage,
        } satisfies TransportReadResultMap['reviews'];
      }
      case 'review_comments': {
        const b = await this.get(`${repo}/pulls/${q.prNumber}/comments`, c, { per_page: String(q.perPage), page: String(q.page) });
        const list = Array.isArray(b) ? b : [];
        return {
          comments: list
            .filter((x: Gh) => x.pull_request_review_id != null)
            .map((x: Gh) => ({
              reviewId: String(x.pull_request_review_id),
              path: String(x.path ?? ''),
              ...(typeof (x.line ?? x.original_line) === 'number' ? { line: Number(x.line ?? x.original_line) } : {}),
              body: String(x.body ?? ''),
              ...(x.commit_id ? { commitSha: String(x.commit_id) } : {}),
            })),
          hasMore: list.length >= q.perPage,
        } satisfies TransportReadResultMap['review_comments'];
      }
      case 'viewer': {
        const me = await this.get('/user', c);
        const login = String(me.login);
        let permission: ViewerPermission = 'unknown';
        try {
          const p = await this.get(`${repo}/collaborators/${enc(login)}/permission`, c);
          const role = String(p.role_name ?? p.permission ?? 'unknown');
          permission = (['admin', 'maintain', 'write', 'triage', 'read', 'none'].includes(role) ? role : 'unknown') as ViewerPermission;
        } catch {
          permission = 'unknown';
        }
        return { login, permission } satisfies TransportReadResultMap['viewer'];
      }
    }
  }

  async submitApproval(
    cmd: { repository: { owner: string; name: string }; prNumber: number; commitId: string; event: 'APPROVE'; body?: string },
    c: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<TransportSubmitResponse> {
    if (!this.allowWrites) {
      // 전송하지 않았음이 확실하다
      throw new GitHubTransportError('not_sent', 'writes disabled (allowWrites=false)', 'writes_disabled');
    }
    const path = `/repos/${enc(cmd.repository.owner)}/${enc(cmd.repository.name)}/pulls/${cmd.prNumber}/reviews`;
    const res = await this.raw('POST', path, c, { commit_id: cmd.commitId, event: cmd.event, ...(cmd.body ? { body: cmd.body } : {}) });
    if (res.status >= 400) throw mapStatus(res);
    const b = JSON.parse(res.bodyText) as Gh;
    return { kind: 'rest', reviewId: String(b.id), state: String(b.state), commitId: String(b.commit_id), submittedAt: new Date(b.submitted_at ?? Date.now()).toISOString(), user: String(b.user?.login ?? '') };
  }


  /**
   * 필수 검사 설정 = rulesets(읽기 권한으로 조회 가능) ∪ classic branch protection(관리자 권한 필요).
   * 조회 실패는 이유별로 구분한다. 무료 요금제의 비공개 저장소는 403 "Upgrade to GitHub Pro…" → plan_unsupported.
   */
  private async requiredChecks(repo: string, baseRef: string, c: { timeoutMs: number; signal?: AbortSignal }): Promise<TransportReadResultMap['required_checks']> {
    // 1) rulesets
    let rulesetNames: string[] = [];
    let rulesetsReadable = false;
    const rr = await this.rawSafe('GET', `${repo}/rules/branches/${enc(baseRef)}`, c);
    if (rr && rr.status === 200) {
      rulesetsReadable = true;
      const rules = JSON.parse(rr.bodyText) as Gh[];
      rulesetNames = (Array.isArray(rules) ? rules : [])
        .filter((r) => r.type === 'required_status_checks')
        .flatMap((r) => ((r.parameters?.required_status_checks ?? []) as Gh[]).map((x) => String(x.context)));
    } else if (rr && rr.status === 404) {
      rulesetsReadable = true; // 기능 없음 = 규칙 없음
    }

    // 2) classic branch protection
    type Classic = { kind: 'configured'; names: string[] } | { kind: 'none' } | { kind: 'unavailable'; reasonCode: RequiredChecksUnknownReason; detail: string };
    let classic: Classic;
    const res = await this.rawSafe('GET', `${repo}/branches/${enc(baseRef)}/protection/required_status_checks`, c);
    if (!res) classic = { kind: 'unavailable', reasonCode: 'lookup_failed', detail: 'network error' };
    else if (res.status === 200) {
      const b = JSON.parse(res.bodyText) as Gh;
      classic = { kind: 'configured', names: [...new Set<string>([...(b.contexts ?? []), ...((b.checks ?? []) as Gh[]).map((x) => String(x.context))])] };
    } else {
      const detail = `${res.status} ${parseErrorBody(res.bodyText).slice(0, 160)}`;
      if (res.status === 404 && /(not protected|required status checks not enabled)/i.test(res.bodyText)) classic = { kind: 'none' };
      else if (res.status === 403 && /(upgrade to github pro|make this repository public)/i.test(res.bodyText)) classic = { kind: 'unavailable', reasonCode: 'plan_unsupported', detail };
      else if ([401, 403, 404].includes(res.status)) classic = { kind: 'unavailable', reasonCode: 'insufficient_permission', detail };
      else classic = { kind: 'unavailable', reasonCode: 'lookup_failed', detail };
    }

    // 3) 결합
    const rulesetSet = [...new Set(rulesetNames)];
    if (classic.kind === 'configured') {
      const names = [...new Set([...classic.names, ...rulesetSet])];
      const source: RequiredChecksSource = rulesetSet.length ? 'github_mixed' : 'github_branch_protection';
      return rulesetsReadable ? { state: 'configured', names, source } : { state: 'configured', names, source, partial: true };
    }
    if (rulesetSet.length > 0) {
      if (classic.kind === 'none') return { state: 'configured', names: rulesetSet, source: 'github_rulesets' };
      // 요금제상 classic 보호가 존재할 수 없으면 rulesets만으로 완전하다
      const partial = classic.reasonCode !== 'plan_unsupported';
      return { state: 'configured', names: rulesetSet, source: 'github_rulesets', ...(partial ? { partial: true } : {}), githubUnavailableReason: classic.reasonCode };
    }
    if (classic.kind === 'none') {
      return rulesetsReadable ? { state: 'none_configured', source: 'github_branch_protection' } : { state: 'unavailable', reasonCode: 'lookup_failed', detail: 'rulesets not readable' };
    }
    return { state: 'unavailable', reasonCode: classic.reasonCode, detail: classic.detail };
  }

  private async rawSafe(method: 'GET', path: string, c: { timeoutMs: number; signal?: AbortSignal }): Promise<HttpResponse | undefined> {
    try {
      return await this.raw(method, path, c);
    } catch (e) {
      if (e instanceof GitHubTransportError) return undefined;
      throw e;
    }
  }

  // ------------------------------------------------------------ helpers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async get(path: string, c: { timeoutMs: number; signal?: AbortSignal }, query?: Record<string, string>): Promise<any> {
    const res = await this.raw('GET', path, c, undefined, query);
    if (res.status >= 400) throw mapStatus(res);
    return JSON.parse(res.bodyText);
  }

  private async raw(method: 'GET' | 'POST', path: string, c: { timeoutMs: number; signal?: AbortSignal }, body?: unknown, query?: Record<string, string>): Promise<HttpResponse> {
    try {
      return await this.http.request({ method, path, timeoutMs: c.timeoutMs, ...(c.signal ? { signal: c.signal } : {}), ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}) });
    } catch (e) {
      if (e instanceof HttpTransportError) {
        throw e.failure.kind === 'not_sent'
          ? new GitHubTransportError('not_sent', e.message, e.failure.proof)
          : new GitHubTransportError('no_response', e.message);
      }
      throw e;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gh = any;

function mapStatus(res: HttpResponse): GitHubTransportError {
  const msg = `${res.status} ${parseErrorBody(res.bodyText).slice(0, 200)}`;
  if (res.status === 401) return new GitHubTransportError('auth', msg);
  if (res.status === 403) return /rate limit/i.test(res.bodyText) ? new GitHubTransportError('transient', msg) : new GitHubTransportError('auth', msg);
  if (res.status === 404) return new GitHubTransportError('not_found', msg);
  if (res.status === 422) return new GitHubTransportError('invalid', msg);
  if (res.status >= 500) return new GitHubTransportError('transient', msg);
  return new GitHubTransportError('invalid', msg);
}

const enc = encodeURIComponent;
