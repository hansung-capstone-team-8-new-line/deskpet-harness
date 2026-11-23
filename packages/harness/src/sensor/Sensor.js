export class DeterministicSensor {
    n = 0;
    inspect(i) {
        const g = i.gatewayResult;
        const base = {
            assessmentId: `asm-${++this.n}-${i.operationId}`,
            operationId: i.operationId,
            attemptId: i.attemptId,
            basedOnRevision: i.executionRevision,
            externalRefs: g.externalRefs,
            ...(g.consistency ? { consistency: g.consistency } : {}),
            ...(g.completeness ? { completeness: g.completeness } : {}),
        };
        const done = (verdict, checks, opts = {}) => ({
            ...base,
            verdict,
            checks,
            confirmedFacts: opts.facts ?? {},
            ...(opts.status ? { suggestedActionStatus: opts.status } : {}),
            followUpNeed: opts.follow ?? 'none',
            diagnostics: opts.diag ?? [],
        });
        // ------------------------------------------------ 전송 안 됨 (확실)
        if (g.dispatchState === 'not_sent') {
            if (!g.notSentProof && g.mode === 'write') {
                return done('indeterminate', [], { status: 'unknown', follow: 'reconcile', diag: ['not_sent without proof'] });
            }
            const cancelled = g.error?.provisionalCode === 'CANCELLED' || i.executionContext.cancelled;
            return done('not_executed', [], {
                status: cancelled ? 'cancelled' : 'failed',
                follow: g.error?.nextAction === 'user_input' ? 'user_input' : 'none',
                facts: g.response ?? {},
                diag: [g.notSentProof ?? 'not_sent', g.error?.message ?? ''],
            });
        }
        // ------------------------------------------------ 응답 없음
        if (g.outcome === 'no_response') {
            if (g.mode === 'read')
                return done('confirmed_failure', [], { status: 'failed', diag: ['read without response'] });
            return done('indeterminate', [{ rule: 'response_received', result: 'fail' }], { status: 'unknown', follow: 'reconcile', diag: ['response lost after possible dispatch'] });
        }
        // ------------------------------------------------ 명시적 오류
        if (g.outcome === 'error') {
            return done('confirmed_failure', [{ rule: 'explicit_error', result: 'fail', evidenceRef: g.error?.provisionalCode }], {
                status: 'failed',
                facts: { errorCode: g.error?.provisionalCode },
                diag: [g.error?.message ?? 'error'],
            });
        }
        const action = i.expectedOutcome.action;
        const r = g.response ?? {};
        switch (action) {
            case 'get_review_context':
            case 'list_tasks':
            case 'get_task_state':
                return done('confirmed_success', [{ rule: 'read_payload', result: 'pass' }], { status: 'succeeded', facts: r });
            case 'submit_approval':
            case 'get_approval_outcome': {
                const expectedSha = i.expectedOutcome.expectedVersion?.headSha;
                if (g.successTextOnly) {
                    return done('indeterminate', [{ rule: 'approval.linked_to_this_submission', result: 'unknown' }], {
                        status: 'unknown',
                        follow: 'reconcile',
                        diag: ['success text only; no review id/state/sha'],
                    });
                }
                const ref = g.externalRefs.find((e) => e.system === 'github' && e.kind === 'pull_request_review');
                const prior = new Set(i.priorEvidence['priorReviewIds'] ?? []);
                const state = ref?.details?.['state'] ?? r['state'];
                const commit = ref?.details?.['commitId'] ?? r['commitId'];
                const checks = [
                    { rule: 'approval.review_state_approved', result: state === undefined ? 'unknown' : state === 'APPROVED' ? 'pass' : 'fail' },
                    { rule: 'approval.commit_matches_expected_sha', result: commit === undefined || !expectedSha ? 'unknown' : commit === expectedSha ? 'pass' : 'fail' },
                    { rule: 'approval.linked_to_this_submission', result: ref && !prior.has(ref.id) ? 'pass' : 'unknown', ...(ref ? { evidenceRef: ref.id } : {}) },
                ];
                if (checks.every((c) => c.result === 'pass')) {
                    return done('confirmed_success', checks, { status: 'succeeded', facts: { reviewId: ref.id, state, commitId: commit } });
                }
                if (checks.some((c) => c.result === 'fail') && ref && !prior.has(ref.id)) {
                    return done('confirmed_failure', checks, { status: 'failed', facts: { reviewId: ref.id, state, commitId: commit }, diag: ['submission evidence contradicts expected outcome'] });
                }
                // 현재 상태는 facts로 남기되 이번 operation은 판정 불가
                return done('indeterminate', checks, { status: 'unknown', follow: 'reconcile', facts: { linkage: r['linkage'], candidates: r['candidates'] } });
            }
            case 'complete_stage':
            case 'get_change_outcome': {
                const ref = g.externalRefs.find((e) => e.system === 'eureka' && e.kind === 'stage_status_change');
                const status = r['status'] ?? r['currentStageStatus'];
                const priorStatus = i.priorEvidence['priorStageStatus'] ?? r['priorStageStatus'];
                const checks = [
                    { rule: 'eureka.stage_status_done', result: status === undefined ? 'unknown' : status === 'done' ? 'pass' : 'fail' },
                    {
                        rule: 'eureka.linked_to_this_change',
                        result: ref && priorStatus !== undefined && priorStatus !== 'done' && priorStatus !== 'skip' ? 'pass' : 'unknown',
                        ...(ref ? { evidenceRef: ref.id } : {}),
                    },
                ];
                if (checks.every((c) => c.result === 'pass')) {
                    return done('confirmed_success', checks, { status: 'succeeded', facts: { stageStatus: status, completedAt: r['completedAt'], warnings: r['warnings'] } });
                }
                if (ref && checks[0].result === 'fail') {
                    return done('confirmed_failure', checks, { status: 'failed', facts: { stageStatus: status } });
                }
                return done('indeterminate', checks, { status: 'unknown', follow: 'reconcile', facts: { currentStageStatus: status, linkage: r['linkage'] } });
            }
            default:
                return done('indeterminate', [], { status: 'unknown', follow: 'reconcile', diag: [`no rule for ${action}`] });
        }
    }
}
