import { describe, expect, it } from 'vitest';
import { collectTimings, recordTiming, summarizeTimings, timedPort } from '@deskpet/harness';
import { ScriptedLlmClient } from '@deskpet/llm';
import { OutputService, mapHarnessResult } from '@deskpet/output';
import { PipelineBridge } from '@deskpet/server';
import { answer, askApproval, review } from '../support/flows.js';
import { createWorld } from '../support/world.js';

/** NFR-01 단계별 시간 기록 (D-26) */
describe('단계별 응답 시간 기록', () => {
  it('리뷰 요청: facts.timings에 GitHub 조회 시간이 남는다', async () => {
    const w = createWorld();
    const r = await review(w);
    const t = r.facts['timings'] as { totalMs: number; stages: { stage: string; ms: number; ok: boolean }[] };
    expect(t.totalMs).toBeGreaterThanOrEqual(0);
    expect(t.stages.map((s) => s.stage)).toContain('github.getReviewContext');
    expect(t.stages.every((s) => s.ok)).toBe(true);
  });

  it('승인 + Eureka 질문: GitHub 쓰기와 Eureka 조회가 각각 기록된다. 다른 요청과 섞이지 않는다', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    const [a, other] = await Promise.all([answer(w, q, '응, 승인해'), review(w, 'req-other')]);
    const stagesA = (a.facts['timings'] as { stages: { stage: string }[] }).stages.map((s) => s.stage);
    expect(stagesA).toContain('github.submitApproval');
    expect(stagesA).toContain('eureka.getTaskState');
    const stagesO = (other.facts['timings'] as { stages: { stage: string }[] }).stages.map((s) => s.stage);
    expect(stagesO).not.toContain('github.submitApproval');
  });

  it('LLM Guide 호출은 llm.guide로 기록된다', async () => {
    const llm = new ScriptedLlmClient(() => ({ decision: 'ask_clarification', missingSlots: [], reason: 'test' }));
    const w = createWorld({ llm });
    const b = await import('../support/builders.js');
    const r = await w.harness.handle(b.harnessRequest('req-llm', b.voiceTurn('t-llm', '이 PR 뭐가 바뀌었는지 요약해줘', { intention: 'pr.summary' })));
    expect((r.facts['timings'] as { stages: { stage: string }[] }).stages.map((s) => s.stage)).toContain('llm.guide');
  });

  it('출력 모델 시간(modelMs)과 파이프라인 형식 facts.timings', async () => {
    const out = new OutputService({ model: { generate: async () => ({ text: 'PR 42번, 현재 커밋 a1b2c3d 기준이에요.' }) } });
    const w = createWorld();
    const r = await review(w);
    const c = await out.generate(mapHarnessResult(r));
    expect(typeof c.modelMs).toBe('number');
    const bridge = new PipelineBridge({ harness: w.harness, store: w.store, output: out });
    const p = await bridge.toPipelineResult(r, 'OP-T');
    expect(JSON.parse(p.action.facts['timings']!)).toMatchObject({ stages: [{ stage: 'github.getReviewContext' }] });
  });

  it('timedPort: 내부 자기 호출은 따로 세지 않고, 실패도 기록한다. 요약 문자열', async () => {
    const port = {
      async outer() {
        return this.inner();
      },
      async inner() {
        return 1;
      },
      async bad() {
        throw new Error('x');
      },
    };
    const p = timedPort(port, 'p');
    const { timings } = await collectTimings(async () => {
      await p.outer();
      await p.outer();
      await p.bad().catch(() => undefined);
      recordTiming('custom', 5, true);
    });
    expect(timings.map((t) => t.stage)).toEqual(['p.outer', 'p.outer', 'p.bad', 'custom']);
    expect(summarizeTimings(timings)).toMatch(/^p\.outer \d+ms×2, p\.bad \d+ms \(실패 1\), custom 5ms$/);
  });
});
