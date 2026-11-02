import { describe, expect, it } from 'vitest';
import { askApproval, answer, review } from '../support/flows.js';
import { createWorld } from '../support/world.js';
import { ConsoleOperatorConfirm } from '@deskpet/server';
import { SHA_A, SHA_B } from '../support/builders.js';

/**
 * 구현 감사(2026-10-05) 회귀 테스트. 각 항목은 감사에서 재현한 실패 사례를 그대로 막는지 확인한다.
 */
describe('감사 F-01: 실제 전달한 질문 문장과 확인 범위 비교', () => {
  it('다른 저장소·PR을 물은 문장을 전달로 인정하지 않고, 이어진 "네"로 쓰기를 하지 않는다', async () => {
    const w = createWorld();
    const q = await askApproval(w);
    expect(q.disposition).toBe('awaiting_user');
    await expect(w.deliverQuestion(q, 'speech', '다른 저장소 Other/Repo PR 999번을 승인할까요?')).rejects.toThrow(/question_scope_mismatch/);
    const r = await answer(w, q, '네', { deliver: false });
    expect(w.github.submitCount).toBe(0);
    expect(r.actionResults.filter((a) => a.action === 'submit_approval')).toHaveLength(0);
  });

  it('범위 문구는 맞아도 다른 PR 번호를 함께 말하면 인정하지 않는다', async () => {
    const w = createWorld();
    const q = await askApproval(w);
    const text = `NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}을 승인할까요? PR 999번도 같이요.`;
    await expect(w.deliverQuestion(q, 'speech', text)).rejects.toThrow(/question_scope_mismatch/);
  });

  it('전달 문장을 보고하지 않은 확인 질문은 인정하지 않는다', async () => {
    const w = createWorld();
    const q = await askApproval(w);
    await expect(w.deliverQuestion(q, 'speech', '')).rejects.toThrow(/delivered_text_required/);
  });

  it('고정 범위 문구가 들어간 문장은 모델이 말투를 바꿨어도 인정한다', async () => {
    const w = createWorld();
    const q = await askApproval(w);
    const r = await answer(w, q, '응, 승인해.', { deliveredText: `확인할게요. NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}을 승인해도 될까요?` });
    expect(w.github.submitCount).toBe(1);
    expect(r.actionResults.find((a) => a.action === 'submit_approval')?.status).toBe('succeeded');
  });
});

describe('감사 F-03: 운영자 확인은 DurableAck 전, 대기는 deadline 안, 승인 뒤 재확인', () => {
  it('운영자에게 묻는 동안 operation은 아직 전송 가능 상태(ack)가 아니다', async () => {
    let attemptStateDuringPrompt: string | undefined;
    const w: ReturnType<typeof createWorld> = createWorld({
      operatorConfirm: {
        confirm: async () => {
          const op = (await w.store.listOperations()).find((o) => o.action === 'submit_approval')!;
          attemptStateDuringPrompt = op.attempts.at(-1)!.dispatchState;
          return 'approved';
        },
      },
    });
    const q = await askApproval(w);
    const r = await answer(w, q, '응, 승인해.');
    expect(attemptStateDuringPrompt).not.toBe('may_have_been_sent');
    expect(r.actionResults.find((a) => a.action === 'submit_approval')?.status).toBe('succeeded');
    expect(w.github.submitCount).toBe(1);
  });

  it('운영자 대기가 deadline을 넘기면 보내지 않는다 (not_sent, 재전송 대상 아님)', async () => {
    const w: ReturnType<typeof createWorld> = createWorld({ operatorConfirm: { confirm: async () => 'timeout' } });
    const q = await askApproval(w);
    const r = await answer(w, q, '응, 승인해.');
    const a = r.actionResults.find((x) => x.action === 'submit_approval')!;
    expect(a).toMatchObject({ status: 'failed', dispatchState: 'not_sent', error: { provisionalCode: 'DEADLINE_EXCEEDED' } });
    expect(w.github.submitCount).toBe(0);
  });

  it('운영자가 yes 한 사이 새 커밋이 올라오면 다시 확인해서 보내지 않는다', async () => {
    const w: ReturnType<typeof createWorld> = createWorld({
      operatorConfirm: {
        confirm: async () => {
          w.github.pushCommit(SHA_B);
          return 'approved';
        },
      },
    });
    const q = await askApproval(w);
    const r = await answer(w, q, '응, 승인해.');
    const a = r.actionResults.find((x) => x.action === 'submit_approval')!;
    expect(a).toMatchObject({ dispatchState: 'not_sent', error: { provisionalCode: 'SHA_CHANGED' } });
    expect(w.github.submitCount).toBe(0);
  });

  it('운영자가 거절하면 취소(not_sent)로 끝난다', async () => {
    const w = createWorld({ operatorConfirm: { confirm: async () => 'declined' } });
    const q = await askApproval(w);
    const r = await answer(w, q, '응, 승인해.');
    expect(r.actionResults.find((x) => x.action === 'submit_approval')).toMatchObject({ status: 'cancelled', dispatchState: 'not_sent' });
    expect(w.github.submitCount).toBe(0);
  });

  it('콘솔 확인은 입력이 없으면 deadline에 맞춰 timeout으로 끝난다', async () => {
    const gate = new ConsoleOperatorConfirm({ prompt: () => new Promise<string>(() => undefined), maxWaitMs: 5_000 });
    const t0 = Date.now();
    const v = await gate.confirm({ repository: { owner: 'o', name: 'r' }, prNumber: 1, commitId: SHA_A, event: 'APPROVE' }, { deadlineAt: new Date(Date.now() + 80).toISOString() });
    expect(v).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe('감사 F-07: 메모리 상한', () => {
  it('끝난 요청 상태는 메모리에서 지우고, 답변 대기 요청만 남긴다', async () => {
    const w = createWorld();
    for (let i = 0; i < 5; i++) await review(w, `req-review-${i}`);
    expect(w.harness.trackedRequestCount).toBe(0);
    const q = await askApproval(w);
    expect(q.disposition).toBe('awaiting_user');
    expect(w.harness.trackedRequestCount).toBe(1);
    await answer(w, q, '아니, 보류해.');
    expect(w.harness.trackedRequestCount).toBe(0);
  });
});
