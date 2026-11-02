import type { HarnessResult } from '@deskpet/contracts';
import { OutputService, mapHarnessResult } from '@deskpet/output';
import { constraints, harnessRequest, prContext, voiceTurn } from './builders.js';
import type { createWorld } from './world.js';

type World = ReturnType<typeof createWorld>;
let turnSeq = 100;
const nextTurn = () => `t-${++turnSeq}`;

export async function review(w: World, requestId = 'req-review') {
  return w.harness.handle(harnessRequest(requestId, voiceTurn(nextTurn(), '응. 손을 못 쓰니까 그 PR을 리뷰해서 읽어줘.')));
}

export async function askApproval(w: World, requestId = 'req-approve', opts: { stt?: number | 'unavailable' } = {}) {
  return w.harness.handle(harnessRequest(requestId, voiceTurn(nextTurn(), '좋아, 그 PR 승인해줘.', { intention: 'pr.approve', ...(opts.stt !== undefined ? { stt: opts.stt } : {}) })));
}

/** 질문 전달 이벤트를 보고한 뒤 사용자의 답변으로 resume한다 */
export async function answer(w: World, prev: HarnessResult, text: string, opts: { stt?: number | 'unavailable'; intention?: string; deliver?: boolean; deliveredText?: string } = {}) {
  const d = opts.deliver === false ? { pendingId: prev.pending!.pendingId, revision: prev.pending!.revision, confirmationId: prev.pending!.confirmationId } : await w.deliverQuestion(prev, 'speech', opts.deliveredText);
  return w.harness.resume({
    originalRequestId: prev.requestId,
    currentTurn: voiceTurn(nextTurn(), text, { ...(opts.stt !== undefined ? { stt: opts.stt } : {}), ...(opts.intention ? { intention: opts.intention } : {}) }),
    context: prContext(),
    pendingId: d.pendingId,
    expectedPendingRevision: d.revision,
    ...(d.confirmationId ? { confirmationId: d.confirmationId } : {}),
    newCallConstraints: constraints('2026-10-04T10:10:00.000Z'),
  });
}

export async function speak(r: HarnessResult) {
  return new OutputService().generate(mapHarnessResult(r));
}
