import { describe, expect, it } from 'vitest';
import { answer, review, speak } from '../support/flows.js';
import { goldenPr } from '../support/github.js';
import { createWorld } from '../support/world.js';

/**
 * D-41 리뷰 뒤 다음 질문 (2026-11-10 사용자 결정)
 * - 승인 조건이 맞으면 리뷰 요약 끝에 확인 질문을 붙인다 → "응"이면 승인 (답변 단계 규칙은 그대로)
 * - 승인할 수 없는 PR이면 질문 없이 이유를 한 문장 붙인다
 * - Copilot 리뷰는 있을 때만 말한다. 차단 수준 지적이 있으면 "그래도 …승인할까요?"
 */
const on = { offerApprovalAfterReview: true } as const;

describe('리뷰 뒤 승인 질문 (D-41)', () => {
  it('승인 가능: 리뷰 요약 + "…을 승인할까요?" → "응"이면 승인', async () => {
    const w = createWorld({ config: on });
    const r = await review(w);
    expect(r.disposition).toBe('awaiting_user');
    expect(r.pending?.purpose).toBe('confirm_pr_approval');
    const text = (await speak(r)).text;
    expect(text).toMatch(/^PR 42번, 현재 커밋 .* 기준이에요\./);
    expect(text).toMatch(/을 승인할까요\?$/);
    expect(w.github.submitCount).toBe(0);
    const done = await answer(w, r, '응');
    expect(done.actionResults[0]).toMatchObject({ action: 'submit_approval', status: 'succeeded' });
  });

  it('리뷰만 원했으면 거절로 끝난다 (외부 변경 없음)', async () => {
    const w = createWorld({ config: on });
    const r = await review(w);
    const no = await answer(w, r, '아니, 리뷰만');
    expect(no.facts['declined']).toBeTruthy();
    expect(w.github.submitCount).toBe(0);
  });

  it('본인 PR이면 질문 없이 이유만', async () => {
    const pr = { ...goldenPr(), basics: { ...goldenPr().basics, author: 'gomdori' } };
    const w = createWorld({ pr, config: on });
    const r = await review(w);
    expect(r.disposition).toBe('completed');
    expect(r.pending).toBeUndefined();
    expect((await speak(r)).text).toContain('본인이 연 PR이라 GitHub에서 승인할 수는 없어요.');
  });

  it('Copilot 리뷰가 없으면 Copilot 문장을 말하지 않는다', async () => {
    const pr = { ...goldenPr(), reviews: [] };
    const w = createWorld({ pr, config: on });
    expect((await speak(await review(w))).text).not.toContain('Copilot');
  });

  it('차단 수준 Copilot 지적이 있으면 "그래도 …승인할까요?"', async () => {
    const base = goldenPr();
    const pr = { ...base, reviews: [{ ...base.reviews[0]!, comments: [{ path: 'a.ts', line: 1, severity: 'high', body: '위험' }] }] };
    const w = createWorld({ pr, config: on });
    const text = (await speak(await review(w))).text;
    expect(text).toContain('차단 수준은 1건이에요.');
    expect(text).toMatch(/그래도 .*을 승인할까요\?$/);
  });

  it('꺼져 있으면 지금처럼 리뷰만 (질문 없음)', async () => {
    const w = createWorld();
    const r = await review(w);
    expect(r.disposition).toBe('completed');
    expect(r.pending).toBeUndefined();
  });
});
