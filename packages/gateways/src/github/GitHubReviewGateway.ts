import {
  approvalBlockers,
  type ApprovalOutcomeQuery,
  type CallConstraints,
  type ChecksData,
  type Consistency,
  type DispatchHandle,
  type ErrorInfo,
  type GatewayResult,
  type GitHubReviewGatewayPort,
  type PrBasics,
  type ProvisionalErrorCode,
  type ReviewContext,
  type ReviewItem,
  type ReviewQuery,
  type ReviewSection,
  type ViewerPermission,
  type SectionKind,
  type SubmitApprovalCommand,
} from '@deskpet/contracts';
import { boundedTimeout } from '../http.js';
import { err, gr } from '../result.js';
import { GitHubTransportError, type GitHubTransport, type TransportReadQuery, type TransportReadResultMap } from './GitHubTransport.js';

/**
 * GitHubReviewGateway — PR 자료 조회·승인 제출·기존 승인 결과 확인. 통신과 증거 정규화만 맡는다.
 * 근거: message-contracts §Review Query, §Write and Reconciliation; Liability §Review Collection, §Confirmation and Execution.
 */
export interface GitHubReviewGatewayOptions {
  transport: GitHubTransport;
  now: () => number;
  toolTimeoutMs?: number;
  /** Copilot 리뷰 작성자 판별 (inference: 실제 bot login은 통합 시 확인) */
  copilotLogins?: string[];
  /**
   * DeskPet 대체 필수 검사 목록 ('owner/name' → 검사 이름). GitHub가 요금제상 보호 기능을 제공하지 않을 때(plan_unsupported)만
   * 사용한다. 권한 부족·조회 실패에는 쓰지 않는다 (그때는 GitHub 설정이 따로 있을 수 있으므로). README D-13.
   */
  requiredChecksFallback?: Record<string, string[]>;
  /**
   * 사람(운영자) 최종 확인 (감사 F-03). DurableAck 전에 묻고, 승인 뒤에는 대상 상태를 다시 확인한 다음에만 ack·전송한다.
   * 응답 대기는 호출 deadline 안으로 제한한다. 거절·시간 초과는 전송 전 종료(not_sent)라 결과가 모호하지 않다.
   */
  operatorConfirm?: OperatorConfirm;
}

export type OperatorVerdict = 'approved' | 'declined' | 'timeout';
export interface OperatorConfirm {
  confirm(
    cmd: { repository: { owner: string; name: string }; prNumber: number; commitId: string; event: 'APPROVE' },
    c: { deadlineAt: string; signal?: AbortSignal },
  ): Promise<OperatorVerdict>;
}

const READ = 'github.read';
const WRITE = 'github.write';

export class GitHubReviewGateway implements GitHubReviewGatewayPort {
  private readonly timeoutMs: number;
  private readonly copilot: Set<string>;

  constructor(private readonly o: GitHubReviewGatewayOptions) {
    this.timeoutMs = o.toolTimeoutMs ?? 30_000;
    this.copilot = new Set(o.copilotLogins ?? ['copilot-pull-request-reviewer[bot]', 'Copilot']);
  }

  // ================================================================ review
  async getReviewContext(raw: ReviewQuery, c: CallConstraints): Promise<ReviewContext> {
    const q = { maxPages: 3, maxItemsPerSection: 100, ...raw };
    const base = { repository: q.repository, prNumber: q.prNumber, ...(q.expectedHeadSha ? { requestedHeadSha: q.expectedHeadSha } : {}) };

    // PR 기본 정보는 항상 조회한다
    const prRes = await this.readOnce({ kind: 'pr', repository: q.repository, prNumber: q.prNumber }, c);
    if (!prRes.ok) {
      return { ...base, consistency: 'unverified', stoppedBeforeDetails: true, sections: this.allSections(q.requestedSections, 'unavailable', prRes.error), error: prRes.error };
    }
    const prBasics: PrBasics = { ...prRes.data, observedAt: this.iso() };
    const initialHeadSha = prBasics.headSha;

    // 기대 SHA와 최초 SHA가 다르면 상세 조회 전에 반환한다
    if (q.expectedHeadSha && q.expectedHeadSha !== initialHeadSha) {
      const e = err(READ, 'SHA_CHANGED', `head moved from ${short(q.expectedHeadSha)} to ${short(initialHeadSha)}`, 'user_input');
      return {
        ...base,
        prBasics,
        initialHeadSha,
        observedHeadSha: initialHeadSha,
        consistency: 'changed',
        stoppedBeforeDetails: true,
        sections: this.allSections(q.requestedSections, 'unavailable', e),
      };
    }

    // 요청 section만, 상한 내 병렬 조회 (원자적 스냅샷 아님)
    const sections = await Promise.all(
      (['changes', 'checks', 'reviews'] as const).map((k) =>
        q.requestedSections.includes(k) ? this.fetchSection(k, q, prBasics, c) : Promise.resolve(notRequested(k)),
      ),
    );

    // 수집 후 head 재확인. 바뀌면 자동 재수집하지 않고 변경 사실과 확보 자료를 반환한다
    const after = await this.readOnce({ kind: 'pr', repository: q.repository, prNumber: q.prNumber }, c);
    const observedHeadSha = after.ok ? after.data.headSha : undefined;
    let consistency: Consistency;
    if (observedHeadSha && observedHeadSha !== initialHeadSha) consistency = 'changed';
    else if (!observedHeadSha) consistency = 'unverified';
    else consistency = sectionsVerified(sections, initialHeadSha) ? 'verified' : 'unverified';

    const viewer = q.requestedSections.includes('checks') ? await this.readOnce({ kind: 'viewer', repository: q.repository }, c) : undefined;
    const changes = sections.find((s) => s.sectionKind === 'changes');
    const diffBase = changes?.versionEvidence?.comparisonBase;
    return {
      ...base,
      prBasics,
      initialHeadSha,
      ...(observedHeadSha ? { observedHeadSha } : {}),
      ...(diffBase ? { diffComparisonBase: diffBase } : {}),
      consistency,
      stoppedBeforeDetails: false,
      sections,
      ...(viewer?.ok ? { viewer: viewer.data } : {}),
    };
  }

  private async fetchSection(kind: SectionKind, q: Required<Pick<ReviewQuery, 'repository' | 'prNumber'>> & { maxPages: number; maxItemsPerSection: number }, pr: PrBasics, c: CallConstraints): Promise<ReviewSection> {
    const observedAt = () => this.iso();
    if (kind === 'changes') {
      const pages = await this.paged((page) => this.readOnce({ kind: 'files', repository: q.repository, prNumber: q.prNumber, page, perPage: q.maxItemsPerSection }, c), q.maxPages);
      if (!pages.ok) return unavailable('changes', pages.error);
      const first = pages.items[0]!;
      const files = pages.items.flatMap((p) => p.files);
      return {
        sectionKind: 'changes',
        availability: 'available',
        completeness: pages.truncated ? 'partial' : 'complete',
        // PR diff 비교 기준을 기록한다. 단일 head 커밋 diff로 대체하지 않는다
        data: { comparison: { base: first.base ?? pr.baseSha ?? pr.baseRef, head: first.headSha ?? 'unverified', kind: 'pr_base_to_head' }, files },
        ...(first.headSha
          ? { versionEvidence: { headSha: first.headSha, ...(first.base ? { comparisonBase: first.base } : {}), source: `${this.o.transport.mode}:files` } }
          : {}),
        observedAt: observedAt(),
        pagination: { hasMore: pages.truncated, pagesRead: pages.items.length },
        truncation: { truncated: pages.truncated, limit: q.maxPages * q.maxItemsPerSection },
        // MVP 범위: 파일·증감 줄 수만. 변경 내용(diff)은 모으지 않는다 (감사 F-06, 범위 결정 대기)
        detailCoverage: { patches: 'not_collected' },
      };
    }
    if (kind === 'checks') {
      const pages = await this.paged((page) => this.readOnce({ kind: 'check_runs', repository: q.repository, prNumber: q.prNumber, ref: pr.headSha, page, perPage: q.maxItemsPerSection }, c), q.maxPages);
      if (!pages.ok) return unavailable('checks', pages.error);
      const runs = pages.items.flatMap((p) => p.runs);
      const req = await this.readOnce({ kind: 'required_checks', repository: q.repository, baseRef: pr.baseRef }, c);
      // 필수 검사 설정: 없다고 확인 vs 조회 불가를 구분한다. 결과 목록만 보고 추정하지 않는다
      const requiredChecks = this.normalizeRequired(req.ok ? req.data : { state: 'unavailable', reasonCode: 'lookup_failed', detail: req.error.message }, q.repository);
      const runShas = new Set(runs.map((r) => r.headSha).filter(Boolean));
      const evidenceSha = runShas.size === 1 ? [...runShas][0] : runs.length === 0 ? pages.items[0]!.resolvedHeadSha : undefined;
      return {
        sectionKind: 'checks',
        availability: 'available',
        completeness: pages.truncated ? 'partial' : 'complete',
        data: { runs, requiredChecks },
        ...(evidenceSha ? { versionEvidence: { headSha: evidenceSha, source: `${this.o.transport.mode}:check_runs` } } : {}),
        observedAt: observedAt(),
        pagination: { hasMore: pages.truncated, pagesRead: pages.items.length },
        truncation: { truncated: pages.truncated },
      };
    }
    const pages = await this.paged((page) => this.readOnce({ kind: 'reviews', repository: q.repository, prNumber: q.prNumber, page, perPage: q.maxItemsPerSection }, c), q.maxPages);
    if (!pages.ok) return unavailable('reviews', pages.error);
    const reviews: ReviewItem[] = pages.items.flatMap((p) => p.reviews).map((r) => ({ ...r, source: this.copilot.has(r.author) ? 'copilot' : 'human' }));
    // 코드 줄 지적은 따로 모아 해당 리뷰에 붙인다. 실패해도 리뷰 목록은 쓰되 세부 범위를 표시한다 (감사 F-06)
    let inline: 'complete' | 'partial' | 'unavailable' = 'complete';
    if (reviews.length > 0) {
      const cp = await this.paged((page) => this.readOnce({ kind: 'review_comments', repository: q.repository, prNumber: q.prNumber, page, perPage: q.maxItemsPerSection }, c), q.maxPages);
      if (!cp.ok) inline = 'unavailable';
      else {
        if (cp.truncated) inline = 'partial';
        const byReview = new Map(reviews.map((r) => [r.reviewId, r]));
        for (const x of cp.items.flatMap((p) => p.comments)) {
          byReview.get(x.reviewId)?.comments.push({ path: x.path, ...(x.line !== undefined ? { line: x.line } : {}), body: x.body, kind: 'inline', ...(x.severity ? { severity: x.severity } : {}) });
        }
      }
    }
    return {
      sectionKind: 'reviews',
      availability: 'available',
      // 목록 페이지 완전성. 세부 지적 수집 범위는 detailCoverage로 따로 표시한다
      completeness: pages.truncated ? 'partial' : 'complete',
      detailCoverage: { inlineComments: inline },
      // 리뷰가 없으면 성공적으로 조회한 빈 목록
      data: { reviews },
      // inference: 리뷰는 항목별 commitSha로 버전을 표시한다. 섹션 단위 SHA는 모든 항목이 같은 SHA일 때만
      ...(reviews.length > 0 && reviews.every((r) => r.commitSha === pr.headSha)
        ? { versionEvidence: { headSha: pr.headSha, source: `${this.o.transport.mode}:reviews.commit_id` } }
        : { versionEvidence: { source: `${this.o.transport.mode}:reviews.per_item_commit_id` } }),
      observedAt: observedAt(),
      pagination: { hasMore: pages.truncated, pagesRead: pages.items.length },
      truncation: { truncated: pages.truncated },
    };
  }

  // ============================================================== approval
  /**
   * 지정 SHA에 APPROVE 제출. 실행 직전 외부 상태를 재검증하고 DurableAck 이후에만 전송한다.
   * 사전 조회와 제출 사이의 경쟁을 완전히 제거했다고 주장하지 않는다. commitID는 버전 지정이지 원자적 비교가 아니다.
   */
  /** 승인 전 조건 확인 (head SHA·상태·권한·필수 검사) 과 직전 리뷰 목록. 운영자 확인 뒤에 한 번 더 부른다 */
  private async approvalPrecheck(
    cmd: SubmitApprovalCommand,
    c: CallConstraints,
    ids: { operationId: string; attemptId: string },
  ): Promise<{ ok: true; priorReviewIds: string[]; viewer: { ok: true; data: { login: string; permission: ViewerPermission } } | { ok: false } } | { ok: false; result: GatewayResult }> {
    const ctx = await this.getReviewContext(
      { repository: cmd.repository, prNumber: cmd.prNumber, requestedSections: ['checks'], expectedHeadSha: cmd.expectedHeadSha, deadlineAt: c.deadlineAt },
      c,
    );
    const viewer = ctx.viewer ? { ok: true as const, data: ctx.viewer as { login: string; permission: ViewerPermission } } : { ok: false as const };
    const checks = ctx.sections.find((s) => s.sectionKind === 'checks');
    const blockers = approvalBlockers({
      ...(ctx.prBasics ? { pr: ctx.prBasics } : {}),
      ...(checks?.sectionKind === 'checks' && checks.data ? { checks: checks.data } : {}),
      expectedHeadSha: cmd.expectedHeadSha,
      viewerPermission: viewer.ok ? viewer.data.permission : 'unknown',
      ...(viewer.ok ? { viewerLogin: viewer.data.login } : {}),
    });
    if (ctx.consistency === 'changed' && !blockers.includes('sha_changed')) blockers.push('sha_changed');
    if (blockers.length > 0) {
      const code: ProvisionalErrorCode = blockers.includes('sha_changed') ? 'SHA_CHANGED' : 'POLICY_BLOCKED';
      return {
        ok: false,
        result: notSent(err(WRITE, code, `pre-dispatch verification failed: ${blockers.join(',')}`, 'user_input', ids), `precheck:${blockers.join(',')}`, {
          blockers,
          observedHeadSha: ctx.observedHeadSha ?? ctx.initialHeadSha,
        }),
      };
    }
    return { ok: true, priorReviewIds: await this.reviewIds(cmd, c), viewer };
  }

  async submitApproval(cmd: SubmitApprovalCommand, handle: DispatchHandle, c: CallConstraints): Promise<GatewayResult> {
    const ids = { operationId: handle.operationId, attemptId: handle.attemptId };
    let pre = await this.approvalPrecheck(cmd, c, ids);
    if (!pre.ok) return pre.result;

    if (!this.o.transport.writesEnabled) {
      // 쓰기 잠금: ack도 요청하지 않는다
      return notSent(err(WRITE, 'POLICY_BLOCKED', 'writes disabled (allowWrites=false)', 'none', ids), 'writes_disabled', { priorReviewIds: pre.priorReviewIds });
    }

    const actual = { repository: cmd.repository, prNumber: cmd.prNumber, commitId: cmd.expectedHeadSha, event: 'APPROVE' as const };
    if (this.o.operatorConfirm) {
      // ack 전에 묻는다. 기다리는 동안 상태가 바뀔 수 있으므로 승인 뒤 조건을 처음부터 다시 확인한다
      if (boundedTimeout(this.timeoutMs, c.deadlineAt, this.o.now()) <= 0 || c.signal?.aborted) {
        return notSent(err(WRITE, 'DEADLINE_EXCEEDED', 'deadline exceeded before operator confirmation', 'none', ids), 'deadline_before_dispatch');
      }
      const verdict = await this.o.operatorConfirm.confirm(actual, { deadlineAt: c.deadlineAt, ...(c.signal ? { signal: c.signal } : {}) });
      if (verdict === 'declined') return notSent(err(WRITE, 'CANCELLED', 'operator declined before sending', 'none', ids), 'operator_declined');
      if (verdict === 'timeout') return notSent(err(WRITE, 'DEADLINE_EXCEEDED', 'operator confirmation timed out', 'none', ids), 'operator_timeout');
      pre = await this.approvalPrecheck(cmd, c, ids);
      if (!pre.ok) return pre.result;
    }
    const priorReviewIds = pre.priorReviewIds;
    const viewer = pre.viewer;
    const timeoutMs = boundedTimeout(this.timeoutMs, c.deadlineAt, this.o.now());
    if (timeoutMs <= 0 || c.signal?.aborted) {
      return notSent(err(WRITE, 'DEADLINE_EXCEEDED', 'deadline exceeded before dispatch', 'none', ids), 'deadline_before_dispatch');
    }
    const ack = await handle.beforeDispatch();
    if (!ack.ok) {
      const code: ProvisionalErrorCode = ack.reason === 'storage_error' ? 'STORAGE_RESERVATION_FAILED' : 'POLICY_BLOCKED';
      return notSent(err(WRITE, code, `no durable ack: ${ack.reason} ${ack.detail}`, 'none', ids), `no_ack:${ack.reason}`);
    }

    try {
      const res = await this.o.transport.submitApproval(actual, { timeoutMs, ...(c.signal ? { signal: c.signal } : {}) });
      const respondedAt = this.iso();
      if (res.kind === 'rest') {
        return gr({
          mode: 'write',
          dispatchState: 'sent',
          outcome: 'response',
          respondedAt,
          response: { reviewId: res.reviewId, state: res.state, commitId: res.commitId, submittedAt: res.submittedAt, user: res.user, priorReviewIds, submitter: viewer.ok ? viewer.data.login : undefined },
          externalRefs: [{ system: 'github', kind: 'pull_request_review', id: res.reviewId, details: { state: res.state, commitId: res.commitId } }],
          versionEvidence: { headSha: res.commitId, source: 'rest:create_review' },
        });
      }
      // MCP 성공 문구만으로 succeeded를 만들지 않는다
      return gr({
        mode: 'write',
        dispatchState: 'sent',
        outcome: 'response',
        respondedAt,
        successTextOnly: true,
        response: { text: res.text, priorReviewIds, submitter: viewer.ok ? viewer.data.login : undefined },
      });
    } catch (e) {
      if (!(e instanceof GitHubTransportError)) throw e;
      if (e.kind === 'not_sent') {
        // 쓰기 잠금·운영자 거절은 일시 오류가 아니므로 자동 재시도 대상이 아니다
        const code: ProvisionalErrorCode = e.proof === 'writes_disabled' ? 'POLICY_BLOCKED' : e.proof === 'operator_declined' ? 'CANCELLED' : 'GITHUB_TRANSIENT';
        return notSent(err(WRITE, code, e.message, 'none', ids), e.proof ?? 'transport_not_sent');
      }
      if (e.kind === 'no_response' || e.kind === 'transient') {
        return gr({
          mode: 'write',
          dispatchState: 'may_have_been_sent',
          outcome: 'no_response',
          response: { priorReviewIds, submitter: viewer.ok ? viewer.data.login : undefined },
          error: err(WRITE, 'GITHUB_RESULT_UNKNOWN', e.message, 'reconcile', ids),
        });
      }
      return gr({ mode: 'write', dispatchState: 'sent', outcome: 'error', respondedAt: this.iso(), error: err(WRITE, mapKind(e.kind), e.message, 'none', ids) });
    }
  }

  /**
   * 기존 승인 결과 확인 (쓰기 없음). 일치 결과를 못 찾은 것은 실패 증거가 아니다.
   * 제출자·SHA·시각 일치는 후보를 좁히는 근거일 뿐이다. 제출 응답의 reviewId가 있을 때만 인과 연결된 증거로 본다.
   */
  async getApprovalOutcome(q: ApprovalOutcomeQuery, c: CallConstraints): Promise<GatewayResult> {
    const res = await this.readOnce({ kind: 'reviews', repository: q.repository, prNumber: q.prNumber, page: 1, perPage: 100 }, c);
    if (!res.ok) return gr({ mode: 'read', dispatchState: 'sent', outcome: 'error', error: res.error });
    const respondedAt = this.iso();
    if (q.reviewId) {
      const r = res.data.reviews.find((x) => x.reviewId === q.reviewId);
      if (r) {
        return gr({
          mode: 'read',
          dispatchState: 'sent',
          outcome: 'response',
          respondedAt,
          response: { linkage: 'submission_review_id', reviewId: r.reviewId, state: r.state, commitId: r.commitSha, user: r.author, submittedAt: r.submittedAt },
          externalRefs: [{ system: 'github', kind: 'pull_request_review', id: r.reviewId, details: { state: r.state, commitId: r.commitSha } }],
        });
      }
    }
    const prior = new Set(q.priorReviewIds);
    const candidates = res.data.reviews.filter(
      (r) => r.state === 'APPROVED' && r.commitSha === q.expectedHeadSha && (!q.submitter || r.author === q.submitter) && !prior.has(r.reviewId),
    );
    return gr({
      mode: 'read',
      dispatchState: 'sent',
      outcome: 'response',
      respondedAt,
      response: { linkage: candidates.length > 0 ? 'candidate_only' : 'none', candidates: candidates.map((r) => ({ reviewId: r.reviewId, submittedAt: r.submittedAt, author: r.author })) },
    });
  }

  // ============================================================== helpers
  private normalizeRequired(r: TransportReadResultMap['required_checks'], repo: { owner: string; name: string }): ChecksData['requiredChecks'] {
    if (r.state !== 'unavailable') return r;
    const key = `${repo.owner}/${repo.name}`.toLowerCase();
    const fallback = Object.entries(this.o.requiredChecksFallback ?? {}).find(([k]) => k.toLowerCase() === key)?.[1];
    if (r.reasonCode === 'plan_unsupported' && fallback) {
      return { state: 'configured', names: fallback, source: 'deskpet_config', githubUnavailableReason: 'plan_unsupported' };
    }
    return { state: 'unknown', reasonCode: r.reasonCode, reason: r.detail };
  }

  private iso() {
    return new Date(this.o.now()).toISOString();
  }

  private async reviewIds(cmd: SubmitApprovalCommand, c: CallConstraints): Promise<string[]> {
    const r = await this.readOnce({ kind: 'reviews', repository: cmd.repository, prNumber: cmd.prNumber, page: 1, perPage: 100 }, c);
    return r.ok ? r.data.reviews.map((x) => x.reviewId) : [];
  }

  /** 읽기: 일시 오류는 deadline 안에서 최대 1회 재시도 */
  private async readOnce<K extends TransportReadQuery['kind']>(
    query: Extract<TransportReadQuery, { kind: K }>,
    c: CallConstraints,
  ): Promise<{ ok: true; data: TransportReadResultMap[K] } | { ok: false; error: ErrorInfo }> {
    let last: ErrorInfo | undefined;
    for (let i = 0; i < 2; i++) {
      const timeoutMs = boundedTimeout(this.timeoutMs, c.deadlineAt, this.o.now());
      if (timeoutMs <= 0 || c.signal?.aborted) return { ok: false, error: last ?? err(READ, 'DEADLINE_EXCEEDED', 'deadline exceeded', 'none') };
      try {
        return { ok: true, data: await this.o.transport.read(query, { timeoutMs, ...(c.signal ? { signal: c.signal } : {}) }) };
      } catch (e) {
        if (!(e instanceof GitHubTransportError)) throw e;
        const transient = e.kind === 'transient' || e.kind === 'no_response' || e.kind === 'not_sent';
        last = err(READ, transient ? 'GITHUB_TRANSIENT' : mapKind(e.kind), e.message, transient ? 'bounded_read_retry' : 'none');
        if (!transient) break;
      }
    }
    return { ok: false, error: last! };
  }

  private async paged<T extends { hasMore: boolean }>(
    fetchPage: (page: number) => Promise<{ ok: true; data: T } | { ok: false; error: ErrorInfo }>,
    maxPages: number,
  ): Promise<{ ok: true; items: T[]; truncated: boolean } | { ok: false; error: ErrorInfo }> {
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await fetchPage(page);
      if (!r.ok) {
        if (items.length === 0) return { ok: false, error: r.error };
        return { ok: true, items, truncated: true };
      }
      items.push(r.data);
      if (!r.data.hasMore) return { ok: true, items, truncated: false };
    }
    return { ok: true, items, truncated: true };
  }

  private allSections(requested: SectionKind[], availability: 'unavailable', error: ErrorInfo): ReviewSection[] {
    return (['changes', 'checks', 'reviews'] as const).map((k) =>
      requested.includes(k) ? ({ sectionKind: k, availability, completeness: 'unknown', error } as ReviewSection) : notRequested(k),
    );
  }
}

function notRequested(k: SectionKind): ReviewSection {
  return { sectionKind: k, availability: 'not_requested', completeness: 'unknown' } as ReviewSection;
}
function unavailable(k: SectionKind, error: ErrorInfo): ReviewSection {
  return { sectionKind: k, availability: error.provisionalCode === 'MCP_TOOL_UNAVAILABLE' ? 'unsupported' : 'unavailable', completeness: 'unknown', error } as ReviewSection;
}

/** 확보 자료의 선언 버전이 시작 SHA와 일치하는지. 근거 없는 section이 있으면 unverified */
function sectionsVerified(sections: ReviewSection[], sha: string): boolean {
  for (const s of sections) {
    if (s.availability !== 'available') continue;
    if (s.sectionKind === 'reviews') {
      // 항목별 commitSha가 모두 있으면 버전 근거가 있다 (최신 SHA와 다른 리뷰는 오래된 리뷰로 구분됨)
      if (!s.data!.reviews.every((r) => !!r.commitSha)) return false;
      continue;
    }
    if (s.versionEvidence?.headSha !== sha) return false;
  }
  return true;
}

function mapKind(k: GitHubTransportError['kind']): ProvisionalErrorCode {
  switch (k) {
    case 'auth':
      return 'GITHUB_AUTH_ERROR';
    case 'not_found':
      return 'GITHUB_NOT_FOUND';
    case 'unsupported':
      return 'MCP_TOOL_UNAVAILABLE';
    case 'invalid':
      return 'INVALID_INPUT';
    default:
      return 'GITHUB_TRANSIENT';
  }
}

function notSent(error: ErrorInfo, proof: string, facts?: Record<string, unknown>): GatewayResult {
  return gr({ mode: 'write', dispatchState: 'not_sent', outcome: 'error', notSentProof: proof, error, ...(facts ? { response: facts } : {}) });
}

const short = (s: string) => s.slice(0, 7);
