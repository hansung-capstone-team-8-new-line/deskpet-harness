import { approvalBlockers, approvalWarnings, latestRunsByName } from '@deskpet/contracts';
export function reviewFacts(ctx, expectedHeadSha, opts = {}) {
    const head = ctx.initialHeadSha;
    const sections = {};
    for (const s of ctx.sections) {
        sections[s.sectionKind] = { availability: s.availability, completeness: s.completeness, ...(s.error ? { errorCode: s.error.provisionalCode } : {}) };
    }
    const f = {
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
        if (changes.detailCoverage?.patches)
            f.patchCoverage = changes.detailCoverage.patches;
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
        if (!reviews.data)
            f.copilot = { status: 'unavailable', comments: [], blockingComments: 0 };
        else {
            const cop = reviews.data.reviews.filter((r) => r.source === 'copilot');
            const current = cop.filter((r) => head && r.commitSha === head);
            if (current.length > 0) {
                // 본문(summary)은 지적이 아니다. kind가 없는 옛 기록은 경로가 있을 때만 코드 지적으로 본다
                const comments = current.flatMap((r) => r.comments).filter((x) => x.kind === 'inline' || (x.kind === undefined && !!x.path)).map(({ kind: _k, ...x }) => x);
                f.copilot = {
                    status: 'current',
                    reviewedSha: head,
                    comments,
                    blockingComments: comments.filter((c) => ['high', 'critical', 'blocking'].includes(c.severity ?? '')).length,
                    commentCoverage: reviews.detailCoverage?.inlineComments ?? 'not_collected',
                };
            }
            else {
                f.copilot = { status: cop.length > 0 ? 'stale_only' : 'none', comments: [], blockingComments: 0 };
            }
        }
    }
    if (expectedHeadSha !== undefined || checks) {
        f.approvalBlockers = approvalBlockers({
            ...(ctx.prBasics ? { pr: ctx.prBasics } : {}),
            ...(checks?.sectionKind === 'checks' && checks.data ? { checks: checks.data } : {}),
            expectedHeadSha: expectedHeadSha ?? head ?? '',
            viewerPermission: ctx.viewer?.permission ?? 'unknown',
            ...(ctx.viewer ? { viewerLogin: ctx.viewer.login } : {}),
            ...(opts.ignoreChecks ? { ignoreChecks: true } : {}),
            ...(opts.repositoryAllowed === false ? { repositoryAllowed: false } : {}),
        });
        if (ctx.consistency === 'changed' && !f.approvalBlockers.includes('sha_changed'))
            f.approvalBlockers.push('sha_changed');
        f.approvalWarnings = approvalWarnings(checks?.sectionKind === 'checks' ? checks.data : undefined);
    }
    return f;
}
