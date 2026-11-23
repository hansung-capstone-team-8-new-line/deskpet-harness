import { GitHubTransportError, } from './GitHubTransport.js';
export class FakeGitHubTransport {
    mode;
    pr;
    now;
    viewer;
    fixture = true;
    /** 테스트에서 쓰기 잠금을 흉내 낼 때 false로 바꾼다 */
    writesEnabled = true;
    reads = [];
    submitCount = 0;
    reviewSeq = 9000;
    submitFaults = [];
    readFaults = [];
    /** 특정 읽기 직후 실행할 훅 (예: 수집 중 새 커밋 push) */
    afterRead;
    /** 승인 제출이 서버에 반영된 직후 실행할 훅 (예: 승인 직후 새 커밋 push) */
    afterSubmit;
    /** 열린 PR 목록 (open_prs 읽기, 웹 현황) */
    openPrs = [];
    constructor(mode, pr, now, viewer = { login: 'gomdori', permission: 'write' }) {
        this.mode = mode;
        this.pr = pr;
        this.now = now;
        this.viewer = viewer;
    }
    pushCommit(newSha, opts = {}) {
        this.pr.basics.headSha = newSha;
        if (opts.invalidateChecks ?? true) {
            this.pr.runs = this.pr.runs.map((r) => ({ ...r, status: 'in_progress', conclusion: null, headSha: newSha }));
        }
    }
    setPrState(state) {
        this.pr.basics.state = state;
    }
    failNextSubmit(f) {
        this.submitFaults.push(f);
    }
    failNextRead(kind, fault) {
        this.readFaults.push({ kind, fault });
    }
    get reviews() {
        return this.pr.reviews;
    }
    async read(query) {
        const fi = this.readFaults.findIndex((f) => f.kind === query.kind);
        if (fi >= 0) {
            const [f] = this.readFaults.splice(fi, 1);
            throw new GitHubTransportError(f.fault, `fake ${f.fault} on ${query.kind}`, f.fault === 'not_sent' ? 'fake_refused' : undefined);
        }
        this.reads.push(query.kind);
        const result = this.answer(query);
        this.afterRead?.(query.kind, this.reads.length - 1);
        return structuredClone(result);
    }
    answer(q) {
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
                if (p.requiredChecks === 'unsupported')
                    return { state: 'unavailable', reasonCode: 'insufficient_permission', detail: 'branch protection not readable' };
                return p.requiredChecks;
            case 'reviews':
                // 실제 API처럼 리뷰 목록에는 본문만, 코드 줄 지적은 review_comments로 나눠서 준다
                return { reviews: p.reviews.map((r) => ({ ...r, comments: r.comments.filter((x) => !x.path).map((x) => ({ ...x, kind: 'summary' })) })), hasMore: false };
            case 'review_comments':
                return {
                    comments: p.reviews.flatMap((r) => r.comments.filter((x) => !!x.path).map((x) => ({ reviewId: r.reviewId, path: x.path, ...(x.line !== undefined ? { line: x.line } : {}), body: x.body, ...(r.commitSha ? { commitSha: r.commitSha } : {}), ...(x.severity ? { severity: x.severity } : {}) }))),
                    hasMore: false,
                };
            case 'viewer':
                return { ...this.viewer };
            case 'open_prs':
                return { prs: this.openPrs, hasMore: false };
        }
    }
    async submitApproval(cmd) {
        if (!this.writesEnabled)
            throw new GitHubTransportError('not_sent', 'writes disabled (allowWrites=false)', 'writes_disabled');
        const fault = this.submitFaults.shift();
        if (fault === 'refuse')
            throw new GitHubTransportError('not_sent', 'connection refused', 'fake_refused_before_request');
        this.submitCount += 1;
        if (fault === 'drop_before_apply')
            throw new GitHubTransportError('no_response', 'timeout');
        if (fault === 'auth')
            throw new GitHubTransportError('auth', 'Bad credentials (401)');
        if (fault === 'invalid')
            throw new GitHubTransportError('invalid', 'Unprocessable Entity (422)');
        const review = {
            reviewId: String(++this.reviewSeq),
            author: this.viewer.login,
            state: 'APPROVED',
            commitSha: cmd.commitId,
            submittedAt: new Date(this.now()).toISOString(),
            comments: [],
        };
        this.pr.reviews.push(review);
        this.afterSubmit?.();
        if (fault === 'drop_after_apply')
            throw new GitHubTransportError('no_response', 'timeout after request');
        if (this.mode === 'mcp')
            return { kind: 'mcp_text', text: 'pull request review submitted successfully' };
        return { kind: 'rest', reviewId: review.reviewId, state: 'APPROVED', commitId: cmd.commitId, submittedAt: review.submittedAt, user: review.author };
    }
}
