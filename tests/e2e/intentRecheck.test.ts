import { describe, expect, it } from 'vitest';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from '@deskpet/contracts';
import { harnessRequest, prContext, voiceTurn } from '../support/builders.js';
import { answer, review, speak } from '../support/flows.js';
import { createScriptedSwarmLlm } from '../support/llm.js';
import { createWorld } from '../support/world.js';

/**
 * Router(`llm` / `unclear`) → IntentTriage · Agent Swarm · GitHubMcpGuide 안전 규칙 검증.
 *
 * - Router는 비합의 `pr.review`/`pr.approve` 단축 의도 없이 `llm`·`unclear`(및 `mcp.task`)만 사용한다.
 * - `unclear`는 IntentTriage(재질문 / talk 재라우팅 / 유레카 직접 조작 / Swarm 위임)를 우선 수행한다.
 * - 승인 쓰기는 `GitHubMcpGuide`의 확인 질문과 STT/신뢰도 검사 없이는 절대 실행되지 않는다.
 */
let n = 0;
const ask = (w: ReturnType<typeof createWorld>, text: string, intention: string, o: { stt?: number; routeConfidence?: number } = {}) =>
  w.harness.handle(harnessRequest(`req-ir-${++n}`, voiceTurn(`t-ir-${n}`, text, { intention, ...o }), prContext()));

function scriptWithTriage(triageHandler: (req: LlmRequest) => unknown): LlmClient {
  const base = createScriptedSwarmLlm();
  return {
    provider: 'scripted',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      if (req.jsonSchema?.name === 'deskpet_intent_triage') {
        const out = triageHandler(req);
        if (out instanceof Error) throw out;
        return { text: JSON.stringify(out), json: out, model: 'scripted' };
      }
      return base.complete(req);
    },
  };
}

describe('Router(llm / unclear) → IntentTriage 및 Agent Swarm 분기', () => {
  it('llm 의도의 "그 PR 승인해 줘" → Swarm + GitHubMcpGuide 확인 질문까지. 바로 승인하지 않는다', async () => {
    const w = createWorld();
    await review(w);
    const q = await ask(w, '좋아 그 PR 승인해 줘', 'llm');
    expect(q.facts['intentRecheck']).toBeUndefined();
    expect(q.disposition).toBe('awaiting_user');
    expect(q.pending?.purpose).toBe('confirm_pr_approval');
    expect(w.github.submitCount).toBe(0);

    const done = await answer(w, q, '응');
    expect(done.actionResults.find((a) => a.action === 'submit_approval')).toMatchObject({
      action: 'submit_approval',
      status: 'succeeded',
    });
    expect(w.github.submitCount).toBe(1);
  });

  it('unclear 의도의 리뷰 요청 → IntentTriage(delegate_swarm)로 llm과 동일하게 Swarm에 진입해 리뷰만 수행한다', async () => {
    let triageCalled = 0;
    const llm = scriptWithTriage(() => {
      triageCalled += 1;
      return {
        verdict: 'delegate_swarm',
        rationale: 'user asks to inspect PR context',
        missingSlots: [],
        swarmGoal: 'PR 42번 리뷰해서 읽어줘',
      };
    });
    const w = createWorld({ llm });
    const r = await ask(w, '리마인드 온 것에 대해서 PR을 확인해줘', 'unclear');
    expect(triageCalled).toBe(1);
    expect(r.actionResults.map((a) => a.action)).toEqual(['get_review_context']);
    expect((await speak(r)).text).toContain('PR 42번');
    expect(w.github.submitCount).toBe(0);
  });

  it('unclear 의도의 일상 대화 → IntentTriage(reroute_talk)로 talk 재라우팅만 남긴다 (외부 실행 없음)', async () => {
    const llm = scriptWithTriage(() => ({
      verdict: 'reroute_talk',
      rationale: 'casual_gratitude',
      missingSlots: [],
    }));
    const w = createWorld({ llm });
    const r = await ask(w, '-감사합니다.', 'unclear');
    expect(r.disposition).toBe('completed');
    expect(r.facts['reroute']).toBe('talk');
    expect(r.actionResults).toHaveLength(0);
    expect(w.github.reads).toHaveLength(0);
    expect(w.github.submitCount).toBe(0);
  });

  it('LLM 장애 시 안전하게 중단하며 외부 쓰기를 실행하지 않는다', async () => {
    const downLlm: LlmClient = {
      provider: 'scripted',
      async complete() {
        throw new LlmError('unavailable', 'model unavailable');
      },
    };
    const w = createWorld({ llm: downLlm });
    const r = await ask(w, '그 PR 승인해 줘', 'llm');
    expect(r.disposition).toBe('failed');
    expect(w.github.submitCount).toBe(0);
  });

  it('llm 승인 요청에서도 GitHubMcpGuide 쓰기 신뢰도 기준은 그대로 적용: STT가 낮으면 다시 말해 달라고 한다', async () => {
    const w = createWorld();
    await review(w);
    const q = await ask(w, '좋아 그 PR 승인해 줘', 'llm', { stt: 0.67 });
    expect(q.pending?.purpose).toBe('restate_write_command');
    expect(w.github.submitCount).toBe(0);
  });

  it('mcp.task 진입은 IntentTriage 없이 Swarm Coordinator로 직행한다', async () => {
    const seenSchemas: string[] = [];
    const base = createScriptedSwarmLlm();
    const w = createWorld({
      llm: {
        provider: 'scripted',
        async complete(req) {
          if (req.jsonSchema?.name) seenSchemas.push(req.jsonSchema.name);
          return base.complete(req);
        },
      },
    });
    const r = await ask(w, '그 PR 리뷰해 줘', 'mcp.task');
    expect(r.disposition).toBe('completed');
    expect(seenSchemas).not.toContain('deskpet_intent_triage');
    expect(seenSchemas[0]).toBe('deskpet_swarm_plan');
  });
});
