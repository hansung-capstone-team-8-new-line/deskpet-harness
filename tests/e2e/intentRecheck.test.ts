import { describe, expect, it } from 'vitest';
import { ScriptedLlmClient } from '@deskpet/llm';
import { harnessRequest, prContext, voiceTurn } from '../support/builders.js';
import { answer, review, speak } from '../support/flows.js';
import { createWorld } from '../support/world.js';

/**
 * D-29 2차 의도 확인: 라우터가 llm·unclear로 보낸 요청을 LLM이 한 번 더 보고 PR 리뷰·승인이면 규칙 경로로 보낸다.
 * 승인은 그대로 승인 전 검사 → 확인 질문 → "응"이 있어야 실행된다.
 */
let n = 0;
const ask = (w: ReturnType<typeof createWorld>, text: string, intention: string, o: { stt?: number; routeConfidence?: number } = {}) =>
  w.harness.handle(harnessRequest(`req-ir-${++n}`, voiceTurn(`t-ir-${n}`, text, { intention, ...o }), prContext()));

const script = (...steps: unknown[]) => {
  let i = 0;
  return new ScriptedLlmClient(() => {
    const s = steps[Math.min(i++, steps.length - 1)];
    if (s instanceof Error) throw s;
    return s;
  });
};
const intent = (v: string) => ({ intent: v, reason: 'test' });
const guideStep = (decision: string) => ({ decision, missingSlots: [], reason: 'test' });

describe('2차 의도 확인 (D-29)', () => {
  it('승인 말이 있으면 LLM 없이 규칙으로 pr.approve (D-39). STT가 잘못 들은 "성인해줘"·"생일해줘"도', async () => {
    const llm = script(intent('other'));
    const w = createWorld({ llm, config: { intentRecheck: true } });
    await review(w);
    for (const text of ['좋아 그 PR 승인해 줘', '성인해줘', '생일해줘~']) {
      const q = await ask(w, text, 'llm');
      expect([text, q.facts['intentRecheck']]).toMatchObject([text, { from: 'llm', to: 'pr.approve', changed: true, by: 'rule' }]);
      expect(q.pending?.purpose).toBe('confirm_pr_approval');
    }
    expect(llm.requests).toHaveLength(0);
    expect(w.github.submitCount).toBe(0);
  });

  it('llm 의도의 "그거 통과시켜 줘" → LLM이 pr.approve로 바꿔 확인 질문까지. 바로 승인하지 않는다', async () => {
    const llm = script(intent('pr_approve'));
    const w = createWorld({ llm, config: { intentRecheck: true } });
    await review(w);
    const q = await ask(w, '그거 통과시켜 줘', 'llm');
    expect(q.facts['intentRecheck']).toMatchObject({ from: 'llm', to: 'pr.approve', changed: true });
    expect(q.disposition).toBe('awaiting_user');
    expect(q.pending?.purpose).toBe('confirm_pr_approval');
    expect(w.github.submitCount).toBe(0);
    // 분류 호출 하나뿐 (규칙 경로는 LLM을 부르지 않음)
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.jsonSchema?.name).toBe('deskpet_intent');
    const done = await answer(w, q, '응');
    expect(done.actionResults[0]).toMatchObject({ action: 'submit_approval', status: 'succeeded' });
  });

  it('unclear 의도의 리뷰 요청 → pr.review로 리뷰만', async () => {
    const llm = script(intent('pr_review'));
    const w = createWorld({ llm, config: { intentRecheck: true } });
    const r = await ask(w, '리마인드 온 것에 대해서 PR을 확인해줘', 'unclear');
    expect(r.facts['intentRecheck']).toMatchObject({ to: 'pr.review', changed: true });
    expect(r.actionResults.map((a) => a.action)).toEqual(['get_review_context']);
    expect((await speak(r)).text).toContain('PR 42번');
    expect(w.github.submitCount).toBe(0);
  });

  it('other면 원래 의도로 LLM Guide 경로를 그대로 탄다', async () => {
    const llm = script(intent('other'), guideStep('unsupported'));
    const w = createWorld({ llm, config: { intentRecheck: true } });
    const r = await ask(w, '-감사합니다.', 'unclear');
    expect(r.facts['intentRecheck']).toMatchObject({ from: 'unclear', changed: false });
    expect(r.actionResults).toHaveLength(0);
    // 막힌 진짜 이유도 남는다
    expect((r.facts['blocked'] as { reasons: string[] }).reasons).toContain('reason:llm:unsupported');
  });

  it('분류 LLM이 실패하면 원래 의도를 유지한다 (실행 없음)', async () => {
    const llm = script(new Error('down'), guideStep('unsupported'));
    const w = createWorld({ llm, config: { intentRecheck: true } });
    const r = await ask(w, '그거 통과시켜 줘', 'llm');
    expect(r.facts['intentRecheck']).toMatchObject({ changed: false });
    expect(w.github.submitCount).toBe(0);
  });

  it('승인 요청은 느슨하게(D-39): STT 0.67이어도 확인 질문까지. 확인 답변은 그대로 엄격 (strict면 예전처럼 다시 말해 달라고 함)', async () => {
    const llm = script(intent('pr_approve'));
    const w = createWorld({ llm, config: { intentRecheck: true } });
    await review(w);
    const q = await ask(w, '좋아 그 PR 승인해 줘', 'llm', { stt: 0.67 });
    expect(q.pending?.purpose).toBe('confirm_pr_approval');
    // 답변 STT가 낮으면 승인하지 않는다
    const again = await answer(w, q, '응', { stt: 0.6 });
    expect(again.pending?.purpose).toBe('confirm_pr_approval');
    expect(w.github.submitCount).toBe(0);

    const w2 = createWorld({ llm: script(intent('pr_approve')), config: { intentRecheck: true, approvalRequestInput: 'strict' } });
    await review(w2);
    const q2 = await ask(w2, '좋아 그 PR 승인해 줘', 'llm', { stt: 0.67 });
    expect(q2.pending?.purpose).toBe('restate_write_command');
  });

  it('꺼져 있으면 지금처럼 LLM Guide로만 간다', async () => {
    const llm = script(guideStep('unsupported'));
    const w = createWorld({ llm });
    const r = await ask(w, '그 PR 승인해 줘', 'llm');
    expect(r.facts['intentRecheck']).toBeUndefined();
    expect(llm.requests[0]!.jsonSchema?.name).toBe('deskpet_guide_step');
  });
});
