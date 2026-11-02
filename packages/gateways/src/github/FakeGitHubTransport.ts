import type { ChecksData, PrBasics, Repository, ReviewItem, ViewerPermission } from '@deskpet/contracts';
import {
  GitHubTransportError,
  type GitHubTransport,
  type TransportErrorKind,
  type TransportReadQuery,
  type TransportReadResultMap,
  type TransportSubmitResponse,
} from './GitHubTransport.js';

/** 결정적 fixture. 화면·로그에 fixture임을 표시해야 한다 (golden-scenario §6). */
export interface FakePr {
  repository: Repository;
  prNumber: number;
  basics: Omit<PrBasics, 'observedAt'>;
  files: TransportReadResultMap['files']['files'];
  runs: ChecksData['runs'];
  /** 'unsupported'는 권한 부족으로 조회 불가를 흉내 낸다 */
  requiredChecks: TransportReadResultMap['required_checks'] | 'unsupported';
  reviews: Omit<ReviewItem, 'source'>[];
}

type SubmitFault = 'refuse' | 'drop_after_apply' | 'drop_before_apply' | 'auth' | 'invalid';
type ReadFault = TransportErrorKind;

export class FakeGitHubTransport implements GitHubTransport {
  readonly fixture = true;
  /** 테스트에서 쓰기 잠금을 흉내 낼 때 false로 바꾼다 */
  writesEnabled = true;
  readonly reads: TransportReadQuery['kind'][] = [];
  submitCount = 0;
  private reviewSeq = 9000;
  private submitFaults: SubmitFault[] = [];
  private readFaults: { kind: TransportReadQuery['kind']; fault: ReadFault }[] = [];
  /** 특정 읽기 직후 실행할 훅 (예: 수집 중 새 커밋 push) */
  afterRead?: (kind: TransportReadQuery['kind'], callIndex: number) => void;
  /** 승인 제출이 서버에 반영된 직후 실행할 훅 (예: 승인 직후 새 커밋 push) */
  afterSubmit?: () => void;

  constructor(
    readonly mode: 'mcp' | 'rest',
    private readonly pr: FakePr,
    private readonly now: () => number,
    readonly viewer: { login: string; permission: ViewerPermission } = { login: 'gomdori', permission: 'write' },
  ) {}

  pushCommit(newSha: string, opts: { invalidateChecks?: boolean } = {}) {
    this.pr.basics.headSha = newSha;
    if (opts.invalidateChecks ?? true) {
      this.pr.runs = this.pr.runs.map((r) => ({ ...r, status: 'in_progress', conclusion: null, headSha: newSha }));
    }
  }

  setPrState(state: PrBasics['state']) {
    this.pr.basics.state = state;
  }

  failNextSubmit(f: SubmitFault) {
    this.submitFaults.push(f);
  }

  failNextRead(kind: TransportReadQuery['kind'], fault: ReadFault) {
    this.readFaults.push({ kind, fault });
  }

  get reviews(): readonly Omit<ReviewItem, 'source'>[] {
    return this.pr.reviews;
  }

  async read<K extends TransportReadQuery['kind']>(query: Extract<TransportReadQuery, { kind: K }>): Promise<TransportReadResultMap[K]> {
    const fi = this.readFaults.findIndex((f) => f.kind === query.kind);
    if (fi >= 0) {
      const [f] = this.readFaults.splice(fi, 1);
      throw new GitHubTransportError(f!.fault, `fake ${f!.fault} on ${query.kind}`, f!.fault === 'not_sent' ? 'fake_refused' : undefined);
    }
    this.reads.push(query.kind);
    const result = this.answer(query as TransportReadQuery) as TransportReadResultMap[K];
    this.afterRead?.(query.kind, this.reads.length - 1);
    return structuredClone(result);
  }

  private answer(q: TransportReadQuery): unknown {
    const p = this.pr;
    switch (q.kind) {
      case 'pr':
        return { ...p.basics };
      case 'files':
        // REST compare는 base/head를 확인해 준다고 가정. MCP 파일 목록은 SHA를 주지 않는다 (inference)
        return {
          files: p.files,
          hasMore: false,
          ...(this.mode === 'rest' ? { base: p.basics.baseSha ?? p.basics.baseRef, headSha: p.basics.headSha } : {}),
        };
      case 'check_runs':
        // MCP는 ref 입력 없이 현재 PR head 기준으로 조회한다 (message-contracts §Review Query)
        return { runs: p.runs, resolvedHeadSha: this.mode === 'mcp' ? p.basics.headSha : q.ref, hasMore: false };
      case 'required_checks':
        if (p.requiredChecks === 'unsupported') return { state: 'unavailable', reasonCode: 'insufficient_permission', detail: 'branch protection not readable' };
        return p.requiredChecks;
      case 'reviews':
        // 실제 API처럼 리뷰 목록에는 본문만, 코드 줄 지적은 review_comments로 나눠서 준다
        return { reviews: p.reviews.map((r) => ({ ...r, comments: r.comments.filter((x) => !x.path).map((x) => ({ ...x, kind: 'summary' as const })) })), hasMore: false };
      case 'review_comments':
        return {
          comments: p.reviews.flatMap((r) =>
            r.comments.filter((x) => !!x.path).map((x) => ({ reviewId: r.reviewId, path: x.path!, ...(x.line !== undefined ? { line: x.line } : {}), body: x.body, ...(r.commitSha ? { commitSha: r.commitSha } : {}), ...(x.severity ? { severity: x.severity } : {}) })),
          ),
          hasMore: false,
        };
      case 'viewer':
        return { ...this.viewer };
    }
  }

  async submitApproval(cmd: { repository: Repository; prNumber: number; commitId: string; event: 'APPROVE' }): Promise<TransportSubmitResponse> {
    if (!this.writesEnabled) throw new GitHubTransportError('not_sent', 'writes disabled (allowWrites=false)', 'writes_disabled');
    const fault = this.submitFaults.shift();
    if (fault === 'refuse') throw new GitHubTransportError('not_sent', 'connection refused', 'fake_refused_before_request');
    this.submitCount += 1;
    if (fault === 'drop_before_apply') throw new GitHubTransportError('no_response', 'timeout');
    if (fault === 'auth') throw new GitHubTransportError('auth', 'Bad credentials (401)');
    if (fault === 'invalid') throw new GitHubTransportError('invalid', 'Unprocessable Entity (422)');
    const review = {
      reviewId: String(++this.reviewSeq),
      author: this.viewer.login,
      state: 'APPROVED' as const,
      commitSha: cmd.commitId,
      submittedAt: new Date(this.now()).toISOString(),
      comments: [],
    };
    this.pr.reviews.push(review);
    this.afterSubmit?.();
    if (fault === 'drop_after_apply') throw new GitHubTransportError('no_response', 'timeout after request');
    if (this.mode === 'mcp') return { kind: 'mcp_text', text: 'pull request review submitted successfully' };
    return { kind: 'rest', reviewId: review.reviewId, state: 'APPROVED', commitId: cmd.commitId, submittedAt: review.submittedAt, user: review.author };
  }
}
