import { describe, expect, it } from 'vitest';
import { GitHubReviewGateway } from '@deskpet/gateways';
import { PR, REPO, SHA_A, SHA_B, T0 } from '../../../tests/support/builders.js';
import { fakeGitHub, goldenPr } from '../../../tests/support/github.js';
const NOW = Date.parse(T0);
const c = { deadlineAt: '2026-10-04T10:05:00.000Z' };
const q = { repository: { ...REPO }, prNumber: PR, requestedSections: ['changes', 'checks', 'reviews'], deadlineAt: c.deadlineAt };
function setup(mode = 'rest', pr = goldenPr()) {
    const t = fakeGitHub(mode, () => NOW, pr);
    const gw = new GitHubReviewGateway({ transport: t, now: () => NOW });
    return { t, gw };
}
function handle(ack = { ok: true, ack: { kind: 'may_have_been_sent', operationId: 'op-1', attemptId: 'att-1', ownerRevision: 1, persistedAt: T0 } }) {
    let n = 0;
    const h = { operationId: 'op-1', attemptId: 'att-1', ownerRevision: 1, beforeDispatch: async () => (n++, ack) };
    return { h, acks: () => n };
}
const submit = { operationId: 'op-1', confirmationId: 'c-1', repository: { ...REPO }, prNumber: PR, expectedHeadSha: SHA_A };
describe('getReviewContext', () => {
    it('collects requested sections with version evidence (REST → verified)', async () => {
        const { gw } = setup();
        const ctx = await gw.getReviewContext(q, c);
        expect(ctx).toMatchObject({ initialHeadSha: SHA_A, observedHeadSha: SHA_A, consistency: 'verified', stoppedBeforeDetails: false });
        const reviews = ctx.sections.find((s) => s.sectionKind === 'reviews');
        expect(reviews?.sectionKind === 'reviews' && reviews.data.reviews[0].source).toBe('copilot');
        const changes = ctx.sections.find((s) => s.sectionKind === 'changes');
        expect(changes?.sectionKind === 'changes' && changes.data.comparison.kind).toBe('pr_base_to_head');
    });
    it('does not copy start SHA into sections lacking evidence (MCP files → unverified)', async () => {
        const { gw } = setup('mcp');
        const ctx = await gw.getReviewContext(q, c);
        const changes = ctx.sections.find((s) => s.sectionKind === 'changes');
        expect(changes.versionEvidence).toBeUndefined();
        expect(ctx.consistency).toBe('unverified');
    });
    it('returns before details when expected SHA differs', async () => {
        const { gw, t } = setup();
        const ctx = await gw.getReviewContext({ ...q, expectedHeadSha: SHA_B }, c);
        expect(ctx).toMatchObject({ consistency: 'changed', stoppedBeforeDetails: true });
        expect(t.reads).toEqual(['pr']);
    });
    it('SHA change during collection → changed, no automatic re-collection', async () => {
        const { gw, t } = setup();
        t.afterRead = (kind) => {
            if (kind === 'reviews')
                t.pushCommit(SHA_B);
        };
        const ctx = await gw.getReviewContext(q, c);
        expect(ctx.consistency).toBe('changed');
        expect(ctx.observedHeadSha).toBe(SHA_B);
        expect(t.reads.filter((k) => k === 'files').length).toBe(1);
    });
    it('distinguishes required checks unknown from none configured', async () => {
        const pr = goldenPr();
        pr.requiredChecks = 'unsupported';
        const { gw } = setup('rest', pr);
        const ctx = await gw.getReviewContext({ ...q, requestedSections: ['checks'] }, c);
        const checks = ctx.sections.find((s) => s.sectionKind === 'checks');
        expect(checks?.sectionKind === 'checks' && checks.data.requiredChecks.state).toBe('unknown');
    });
    it('empty review list is an available, complete section', async () => {
        const pr = goldenPr();
        pr.reviews = [];
        const { gw } = setup('rest', pr);
        const ctx = await gw.getReviewContext({ ...q, requestedSections: ['reviews'] }, c);
        expect(ctx.sections.find((s) => s.sectionKind === 'reviews')).toMatchObject({ availability: 'available', completeness: 'complete', data: { reviews: [] } });
        expect(ctx.sections.find((s) => s.sectionKind === 'changes')).toMatchObject({ availability: 'not_requested' });
    });
    it('read auth error is not retried and marks sections unavailable', async () => {
        const { gw, t } = setup();
        t.failNextRead('pr', 'auth');
        const ctx = await gw.getReviewContext(q, c);
        expect(ctx.error.provisionalCode).toBe('GITHUB_AUTH_ERROR');
        expect(ctx.sections.every((s) => s.availability === 'unavailable')).toBe(true);
    });
    it('transient read error is retried once', async () => {
        const { gw, t } = setup();
        t.failNextRead('pr', 'transient');
        const ctx = await gw.getReviewContext(q, c);
        expect(ctx.consistency).toBe('verified');
    });
});
describe('submitApproval', () => {
    it('REST: submits once at the given commit and returns review evidence', async () => {
        const { gw, t } = setup();
        const { h, acks } = handle();
        const r = await gw.submitApproval(submit, h, c);
        expect(acks()).toBe(1);
        expect(t.submitCount).toBe(1);
        expect(r).toMatchObject({ dispatchState: 'sent', outcome: 'response', successTextOnly: false });
        expect(r.externalRefs[0]).toMatchObject({ system: 'github', kind: 'pull_request_review', details: { commitId: SHA_A } });
    });
    it('MCP: success text only, no external evidence', async () => {
        const { gw } = setup('mcp');
        const r = await gw.submitApproval(submit, handle().h, c);
        expect(r).toMatchObject({ dispatchState: 'sent', successTextOnly: true, externalRefs: [] });
    });
    it('SHA moved before submit → not_sent, no ack requested', async () => {
        const { gw, t } = setup();
        t.pushCommit(SHA_B);
        const { h, acks } = handle();
        const r = await gw.submitApproval(submit, h, c);
        expect(r).toMatchObject({ dispatchState: 'not_sent' });
        expect(r.error.provisionalCode).toBe('SHA_CHANGED');
        expect(acks()).toBe(0);
        expect(t.submitCount).toBe(0);
    });
    it('required check failing → blocked', async () => {
        const pr = goldenPr();
        pr.runs[1] = { name: 'test', status: 'completed', conclusion: 'failure', headSha: SHA_A };
        const { gw, t } = setup('rest', pr);
        const r = await gw.submitApproval(submit, handle().h, c);
        expect(r.error.provisionalCode).toBe('POLICY_BLOCKED');
        expect(r.notSentProof).toMatch(/required_check_failed:test/);
        expect(t.submitCount).toBe(0);
    });
    it('closed / merged PR → blocked (S-11)', async () => {
        const { gw, t } = setup();
        t.setPrState('merged');
        const r = await gw.submitApproval(submit, handle().h, c);
        expect(r.notSentProof).toMatch(/pr_merged/);
    });
    it('timeout after request → may_have_been_sent, never resent', async () => {
        const { gw, t } = setup();
        t.failNextSubmit('drop_after_apply');
        const r = await gw.submitApproval(submit, handle().h, c);
        expect(r).toMatchObject({ dispatchState: 'may_have_been_sent', outcome: 'no_response' });
        expect(r.error).toMatchObject({ provisionalCode: 'GITHUB_RESULT_UNKNOWN', nextAction: 'reconcile' });
        expect(t.submitCount).toBe(1);
    });
    it('auth error is an explicit failure, not retried', async () => {
        const { gw, t } = setup();
        t.failNextSubmit('auth');
        const r = await gw.submitApproval(submit, handle().h, c);
        expect(r).toMatchObject({ dispatchState: 'sent', outcome: 'error' });
        expect(r.error.provisionalCode).toBe('GITHUB_AUTH_ERROR');
        expect(t.submitCount).toBe(1);
    });
    it('no ack → not sent', async () => {
        const { gw, t } = setup();
        const r = await gw.submitApproval(submit, handle({ ok: false, reason: 'authority_revoked', detail: 'cancelled' }).h, c);
        expect(r.dispatchState).toBe('not_sent');
        expect(t.submitCount).toBe(0);
    });
});
describe('getApprovalOutcome', () => {
    it('links by submission reviewId', async () => {
        const { gw } = setup();
        const sub = await gw.submitApproval(submit, handle().h, c);
        const reviewId = sub.externalRefs[0].id;
        const r = await gw.getApprovalOutcome({ operationId: 'op-1', repository: { ...REPO }, prNumber: PR, expectedHeadSha: SHA_A, reviewId, priorReviewIds: ['8001'] }, c);
        expect(r.response).toMatchObject({ linkage: 'submission_review_id', state: 'APPROVED' });
        expect(r.externalRefs).toHaveLength(1);
    });
    it('without reviewId only candidates are reported (submitter/SHA match is not causal proof)', async () => {
        const { gw, t } = setup('mcp');
        t.failNextSubmit('drop_after_apply');
        await gw.submitApproval(submit, handle().h, c);
        const r = await gw.getApprovalOutcome({ operationId: 'op-1', repository: { ...REPO }, prNumber: PR, expectedHeadSha: SHA_A, submitter: 'gomdori', priorReviewIds: ['8001'] }, c);
        expect(r.response).toMatchObject({ linkage: 'candidate_only' });
        expect(r.externalRefs).toHaveLength(0);
    });
});
