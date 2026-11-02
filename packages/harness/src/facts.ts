import { approvalBlockers, approvalWarnings, latestRunsByName, type ReviewContext, type ViewerPermission } from '@deskpet/contracts';

/**
 * ReviewContext → 출력용 구조화 사실. 모델 요약으로 원 증거를 대체하지 않는다.
 * S-03: 리뷰 없음·오래됨·조회 불가를 분리한다. 오래된 Copilot 리뷰를 최신 리뷰처럼 표현하지 않는다.
 */
export interface ReviewFacts {
  repository: string;
  prNumber: number;
  title?: string;
  prState?: string;
  draft?: boolean;
  headSha?: string;
  observedHeadSha?: string;
  consistency: ReviewContext['consistency'];
  stoppedBeforeDetails: boolean;
  sections: Record<string, { availability: string; completeness: string; errorCode?: string }>;
  changes?: { fileCount: number; additions: number; deletions: number; comparisonBase: string; paths: string[] };
  checks?: {
    requiredState: 'configured' | 'none_configured' | 'unknown';
    /** configured/none_configured의 출처 (deskpet_config면 GitHub 대신 DeskPet 설정) */
    requiredSource?: string;
    /** unknown 이유 또는 대체 설정을 쓴 이유 */
    requiredReasonCode?: string;
    requiredReason?: string;
    requiredPartial?: boolean;
    required: string[];
    runs: { name: string; status: string; conclusion: string | null }[];
    failing: string[];
    pending: string[];
    /** 같은 이름의 이전 실행으로 판정에서 제외한 수 */
    duplicateRuns: number;
  };
  copilot?: {
    status: 'current' | 'stale_only' | 'none' | 'unavailable';
    reviewedSha?: string;
    /** 코드 줄 지적만 (리뷰 본문 요약은 지적 수에 넣지 않는다) */
    comments: { path?: string; line?: number; severity?: string; body: string }[];
    blockingComments: number;
    /** 코드 줄 지적 수집 범위. complete가 아니면 지적 수를 단정하지 않는다 (감사 F-06) */
    commentCoverage?: 'complete' | 'partial' | 'unavailable' | 'not_collected';
  };
  /** 변경 내용(diff) 수집 범위. MVP는 not_collected (파일·증감 줄 수만) */
  patchCoverage?: 'complete' | 'partial' | 'unavailable' | 'not_collected';
  approvalBlockers: string[];
  /** 차단하지 않는 경고 (필수가 아닌 검사 실패·진행 중) */
  approvalWarnings: string[];
}

export function reviewFacts(ctx: ReviewContext, expectedHeadSha?: string): ReviewFacts {
  const head = ctx.initialHeadSha;
  const sections: ReviewFacts['sections'] = {};
  for (const s of ctx.sections) {
    sections[s.sectionKind] = { availability: s.availability, completeness: s.completeness, ...(s.error ? { errorCode: s.error.provisionalCode } : {}) };
  }
  const f: ReviewFacts = {
    repository: `${ctx.repository.owner}/${ctx.repository.name}`,
    prNumber: ctx.prNumber,
    consistency: ctx.consistency,
    stoppedBeforeDetails: ctx.stoppedBeforeDetails,
    sections,
    approvalBlockers: [],
    approvalWarnings: [],
    ...(ctx.prBasics ? { title: ctx.prBasics.title, prState: ctx.prBasics.state, draft: ctx.prBasics.draft } : {}),
    ...(head ? { headSha: head } : {}),
    ...(ctx.observedHeadSha ? { observedHeadSha: ctx.observedHeadSha } : {}),
  };
  const changes = ctx.sections.find((s) => s.sectionKind === 'changes');
  if (changes?.sectionKind === 'changes' && changes.data) {
    f.changes = {
      fileCount: changes.data.files.length,
      additions: changes.data.files.reduce((a, x) => a + x.additions, 0),
      deletions: changes.data.files.reduce((a, x) => a + x.deletions, 0),
      comparisonBase: changes.data.comparison.base,
      paths: changes.data.files.map((x) => x.path),
    };
    if (changes.detailCoverage?.patches) f.patchCoverage = changes.detailCoverage.patches;
  }
  const checks = ctx.sections.find((s) => s.sectionKind === 'checks');
  if (checks?.sectionKind === 'checks' && checks.data) {
    const req = checks.data.requiredChecks;
    const latest = latestRunsByName(checks.data.runs);
    f.checks = {
      requiredState: req.state,
      ...(req.state !== 'unknown' && req.source ? { requiredSource: req.source } : {}),
      ...(req.state === 'unknown' && req.reasonCode ? { requiredReasonCode: req.reasonCode } : {}),
      ...(req.state === 'configured' && req.githubUnavailableReason ? { requiredReasonCode: req.githubUnavailableReason } : {}),
      ...(req.state === 'unknown' ? { requiredReason: req.reason } : {}),
      ...(req.state === 'configured' && req.partial ? { requiredPartial: true } : {}),
      required: req.state === 'configured' ? req.names : [],
      runs: latest.runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion })),
      duplicateRuns: latest.duplicates,
      failing: latest.runs.filter((r) => r.status === 'completed' && !['success', 'skipped', 'neutral'].includes(r.conclusion ?? '')).map((r) => r.name),
      pending: latest.runs.filter((r) => r.status !== 'completed').map((r) => r.name),
    };
  }
  const reviews = ctx.sections.find((s) => s.sectionKind === 'reviews');
  if (reviews?.sectionKind === 'reviews') {
    if (!reviews.data) f.copilot = { status: 'unavailable', comments: [], blockingComments: 0 };
    else {
      const cop = reviews.data.reviews.filter((r) => r.source === 'copilot');
      const current = cop.filter((r) => head && r.commitSha === head);
      if (current.length > 0) {
        // 본문(summary)은 지적이 아니다. kind가 없는 옛 기록은 경로가 있을 때만 코드 지적으로 본다
        const comments = current.flatMap((r) => r.comments).filter((x) => x.kind === 'inline' || (x.kind === undefined && !!x.path)).map(({ kind: _k, ...x }) => x);
        f.copilot = {
          status: 'current',
          reviewedSha: head!,
          comments,
          blockingComments: comments.filter((c) => ['high', 'critical', 'blocking'].includes(c.severity ?? '')).length,
          commentCoverage: reviews.detailCoverage?.inlineComments ?? 'not_collected',
        };
      } else {
        f.copilot = { status: cop.length > 0 ? 'stale_only' : 'none', comments: [], blockingComments: 0 };
      }
    }
  }
  if (expectedHeadSha !== undefined || checks) {
    f.approvalBlockers = approvalBlockers({
      ...(ctx.prBasics ? { pr: ctx.prBasics } : {}),
      ...(checks?.sectionKind === 'checks' && checks.data ? { checks: checks.data } : {}),
      expectedHeadSha: expectedHeadSha ?? head ?? '',
      viewerPermission: (ctx.viewer?.permission as ViewerPermission | undefined) ?? 'unknown',
      ...(ctx.viewer ? { viewerLogin: ctx.viewer.login } : {}),
    });
    if (ctx.consistency === 'changed' && !f.approvalBlockers.includes('sha_changed')) f.approvalBlockers.push('sha_changed');
    f.approvalWarnings = approvalWarnings(checks?.sectionKind === 'checks' ? checks.data : undefined);
  }
  return f;
}
