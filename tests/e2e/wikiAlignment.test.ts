import { describe, expect, it } from 'vitest';
import { OutputService, mapHarnessResult } from '@deskpet/output';
import { SHA_A } from '../support/builders.js';
import { answer, askApproval, review, speak } from '../support/flows.js';
import { goldenPr } from '../support/github.js';
import { createWorld } from '../support/world.js';

/**
 * 2026-11-03 wiki 정렬
 * - 출력 감정 neutral·happy·sad와 actionStatus (deskpet-display-interface)
 * - 실행된 검사가 없으면 '통과'라고 하지 않음 (deskpet-pipeline 10/27 미수정 항목)
 * - PR CI 검사 조회 생략·승인 조건 제외 (D-30, 사용자 결정)
 */
describe('출력 감정·업무 결과 (화면 계약)', () => {
  it('승인 성공은 actionStatus=succeeded·happy, 확인 질문은 결과 없음·neutral', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    const qc = await new OutputService().generate(mapHarnessResult(q));
    expect(qc.emotion).toBe('neutral');
    expect(qc.actionStatus).toBeUndefined();
    const done = await answer(w, q, '응, 승인해');
    const c = await new OutputService().generate(mapHarnessResult(done));
    expect(c).toMatchObject({ actionStatus: 'succeeded', emotion: 'happy' });
  });

  it('리뷰(조회)만 했으면 업무 결과를 넣지 않는다', async () => {
    const w = createWorld();
    const r = await review(w);
    const c = await new OutputService().generate(mapHarnessResult(r));
    expect(c.actionStatus).toBeUndefined();
    expect(['neutral', 'happy', 'sad']).toContain(c.emotion);
  });
});

describe('검사 안내', () => {
  it('실행된 검사가 하나도 없으면 "모든 검사가 통과"라고 하지 않는다', async () => {
    const pr = { ...goldenPr(), runs: [], requiredChecks: { state: 'none_configured' as const, source: 'github_branch_protection' as const } };
    const w = createWorld({ pr });
    const text = (await speak(await review(w))).text;
    expect(text).toContain('이 커밋에서 실행된 검사는 없어요.');
    expect(text).not.toContain('모든 검사가 통과');
  });
});

describe('PR 검사 조회 생략 (D-30)', () => {
  it('skip: 검사를 조회하지 않고, 필수 검사가 실패해도 승인 질문·승인까지 간다. 안내에 검사 문장이 없다', async () => {
    const pr = { ...goldenPr(), runs: [{ name: 'build', status: 'completed' as const, conclusion: 'failure' as const, headSha: SHA_A }] };
    const w = createWorld({ pr, config: { prChecks: 'skip' } });
    const r = await review(w);
    expect((await speak(r)).text).not.toMatch(/검사/);
    const q = await askApproval(w);
    expect(q.pending?.purpose).toBe('confirm_pr_approval');
    const done = await answer(w, q, '응, 승인해');
    expect(done.actionResults.find((a) => a.action === 'submit_approval')).toMatchObject({ action: 'submit_approval', status: 'succeeded' });
    expect(w.github.reads.filter((k) => k === 'check_runs' || k === 'required_checks')).toHaveLength(0);
    // 권한·본인 PR 확인용 viewer 조회는 그대로 한다
    expect(w.github.reads).toContain('viewer');
  });

  it('enforce(기본): 필수 검사가 실패하면 지금처럼 승인하지 않는다', async () => {
    const pr = { ...goldenPr(), runs: [{ name: 'build', status: 'completed' as const, conclusion: 'failure' as const, headSha: SHA_A }] };
    const w = createWorld({ pr });
    await review(w);
    const q = await askApproval(w);
    expect(q.pending?.purpose).not.toBe('confirm_pr_approval');
    expect(w.github.submitCount).toBe(0);
  });

  it('skip이어도 본인 PR·권한 조건은 그대로 막는다', async () => {
    const pr = { ...goldenPr(), basics: { ...goldenPr().basics, author: 'gomdori' } };
    const w = createWorld({ pr, config: { prChecks: 'skip' } });
    await review(w);
    const q = await askApproval(w);
    expect(q.pending?.purpose).not.toBe('confirm_pr_approval');
    expect(w.github.submitCount).toBe(0);
  });
});

describe('파이프라인 output.generate 응답의 화면 값 (D-32)', () => {
  it('쓰기 성공 결과면 actionStatus=succeeded·happy, 조회 결과면 actionStatus 없음', async () => {
    const { PipelineBridge } = await import('@deskpet/server');
    const w = createWorld();
    const bridge = new PipelineBridge({ harness: w.harness, store: w.store, output: new OutputService() });
    const wrote = await bridge.generateDetailed({
      requestId: 'R1', outputId: 'O1', isQuestion: false, requiredText: "'보고서' 업무를 완료로 처리했어요.",
      action: { operationId: 'op1', status: 'succeeded', facts: { dispatchState: 'sent', action: 'complete_item' }, error: null },
    });
    expect(wrote).toMatchObject({ actionStatus: 'succeeded', emotion: 'happy' });
    const read = await bridge.generateDetailed({
      requestId: 'R2', outputId: 'O2', isQuestion: false, requiredText: '진행 중인 업무가 2개 있어요.',
      action: { operationId: 'op2', status: 'succeeded', facts: {}, error: null },
    });
    expect(read.actionStatus).toBeUndefined();
    expect(read.emotion).toBe('neutral');
  });
});
