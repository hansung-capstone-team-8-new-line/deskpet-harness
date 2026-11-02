import { describe, expect, it } from 'vitest';
import { OutputProjectionFeed, RequestStateProjector, fromStoreChange } from '@deskpet/projector';
import { ITEM_ID, PR, SHA_A, STAGE_ID } from '../support/builders.js';
import { answer, askApproval, review, speak } from '../support/flows.js';
import { createWorld } from '../support/world.js';

/**
 * G-01 (golden-scenario §4) — Liability §Confirmation and Execution에 따라 GitHub 승인과 Eureka 반영을
 * 각각 별도 확인·operation으로 분리한 흐름 (README C-06). 모든 외부 호출은 fixture.
 */
describe('G-01: review → approval confirmation → approve → follow-up check → separate confirmation → Eureka stage done', () => {
  it('runs end to end with fake gateways', async () => {
    const w = createWorld({ githubMode: 'rest' });
    const projector = new RequestStateProjector();
    w.store.subscribe((c) => projector.apply(fromStoreChange(c, 1)));

    // 1) 리뷰 조회 → 사실 반환
    const r1 = await review(w);
    expect(r1.disposition).toBe('completed');
    expect(r1.facts['review']).toMatchObject({
      prNumber: PR,
      headSha: SHA_A,
      consistency: 'verified',
      checks: { requiredState: 'configured', failing: [], pending: [] },
      copilot: { status: 'current', blockingComments: 0 },
    });
    const say1 = await speak(r1);
    expect(say1.text).toContain('모든 검사가 통과했어요');
    expect(say1.text).toContain('Copilot 지적 2건');

    // 2) 승인 요청 → 승인 가능 조건 확인 → 확인 질문. 쓰기 0회
    const r2 = await askApproval(w);
    expect(r2.disposition).toBe('awaiting_user');
    expect(r2.pending).toMatchObject({ kind: 'confirmation', scope: { action: 'submit_approval', headSha: SHA_A } });
    expect(w.github.submitCount).toBe(0);
    expect((await speak(r2)).text).toBe(`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}을 승인할까요?`);

    // 3) "응, 승인해" → GitHub 승인 1회 → 후속 적합성 확인 → Eureka 별도 확인 질문
    const r3 = await answer(w, r2, '응, 승인해.');
    expect(r3.requestId).toBe(r2.requestId);
    expect(w.github.submitCount).toBe(1);
    const approval = r3.actionResults.find((a) => a.action === 'submit_approval')!;
    expect(approval).toMatchObject({ status: 'succeeded', dispatchState: 'sent' });
    expect(approval.externalRefs[0]).toMatchObject({ kind: 'pull_request_review', details: { state: 'APPROVED', commitId: SHA_A } });
    expect(r3.disposition).toBe('awaiting_user');
    expect(r3.pending).toMatchObject({ kind: 'confirmation', scope: { action: 'complete_stage', target: { kind: 'eureka_stage', itemId: ITEM_ID, stageId: STAGE_ID } } });
    expect(r3.pending!.confirmationId).not.toBe(r2.pending!.confirmationId);
    expect(w.eurekaServer.writeCount('/')).toBe(0); // 별도 동의 전 Eureka 쓰기 없음
    expect((await speak(r3)).text).toBe("PR 42번을 승인했어요. Eureka의 'PR 승인' 단계를 완료로 반영할까요?");

    // 4) "응, 완료해" → 실행 직전 재검증 → Eureka 단계 하나만 완료
    const r4 = await answer(w, r3, '응, 완료해.');
    expect(r4.disposition).toBe('completed');
    const stage = r4.actionResults.find((a) => a.action === 'complete_stage')!;
    expect(stage).toMatchObject({ status: 'succeeded', dispatchState: 'sent' });
    expect(w.eurekaServer.writeCount('/_api_/stages/')).toBe(1);
    expect(w.eurekaServer.writeCount('/_api_/items/')).toBe(0); // 상위 업무 전체 완료로 확대하지 않음
    expect(w.eurekaServer.items.get(ITEM_ID)!.stages[1]!.status).toBe('done');
    expect(w.github.submitCount).toBe(1);
    expect((await speak(r4)).text).toBe("Eureka의 'PR 승인' 단계를 완료로 반영했어요.");

    // 5) 기록: 승인과 Eureka 반영은 서로 다른 operation·confirmation
    const ops = await w.store.listOperations();
    const approvalOp = ops.find((o) => o.action === 'submit_approval')!;
    const stageOp = ops.find((o) => o.action === 'complete_stage')!;
    expect(approvalOp.confirmationRef).not.toBe(stageOp.confirmationRef);
    expect(approvalOp.followUp?.eligibility).toBe('eligible');
    expect(stageOp.actualRequest['approvalOperationId']).toBe(approvalOp.operationId);
    expect(new Set(ops.map((o) => o.requestId))).toEqual(new Set(['req-review', 'req-approve']));

    // 6) 웹 투영: 업무 결과를 각각 독립적으로 표시. 음성 실패는 업무 결과를 바꾸지 않는다 (S-10)
    const feed = new OutputProjectionFeed();
    projector.apply(feed.toUpdate({ kind: 'channel_failed', outputId: 'out-final', requestRefs: { requestId: 'req-approve' }, channel: 'speech' })!);
    projector.apply(feed.toUpdate({ kind: 'channel_completed', outputId: 'out-final', requestRefs: { requestId: 'req-approve' }, channel: 'display' })!);
    const view = projector.project();
    expect(view.operations.find((o) => o.action === 'submit_approval')!.status).toBe('succeeded');
    expect(view.operations.find((o) => o.action === 'complete_stage')!.status).toBe('succeeded');
    expect(view.outputs[0]!.channels).toEqual({ speech: 'failed', display: 'completed' });
    expect(w.github.submitCount).toBe(1);
  });
});
