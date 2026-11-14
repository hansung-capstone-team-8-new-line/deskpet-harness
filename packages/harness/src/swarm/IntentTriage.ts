import {
  TriageResult,
  type ContextPacket,
  type CurrentTurnInput,
  type LlmClient,
  type SourceRef,
} from '@deskpet/contracts';
import type { WikiReader } from '../ports.js';
import type { Clock } from '../runtime/clock.js';

export interface TriageContext {
  requestId: string;
  turn: CurrentTurnInput;
  context: ContextPacket;
  deadlineAt: string;
  availableMcpIds: string[];
  wikiSearchAllowed?: boolean;
  signal?: AbortSignal;
}

export interface IntentTriageOutcome {
  triage: TriageResult;
  wikiExcerpts: { text: string; ref: string }[];
  sources: SourceRef[];
}

const TRIAGE_JSON_SCHEMA = {
  name: 'deskpet_intent_triage',
  schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['clarify', 'reroute_talk', 'direct_eureka', 'delegate_swarm'] },
      rationale: { type: 'string' },
      clarifyQuestion: { type: 'string' },
      missingSlots: { type: 'array', items: { type: 'string' } },
      eurekaOperation: {
        type: 'string',
        enum: ['list_tasks', 'get_task_state', 'register_item', 'postpone_item', 'complete_item', 'list_processes'],
      },
      eurekaArgsJson: { type: 'string' },
      swarmGoal: { type: 'string' },
    },
    required: ['verdict', 'rationale', 'missingSlots'],
    additionalProperties: false,
  },
} as const;

const TRIAGE_INSTRUCTIONS = [
  '당신은 DeskPet 헤드리스 바이브 코딩 플랫폼의 1차 의도 분류기(IntentTriage)입니다.',
  '온디바이스 라우터가 `unclear`로 넘긴 발화에 대해 직전 대화, active target, 팀 문서(Wiki), 사용 가능한 MCP 목록을 바탕으로 의도를 정확히 4가지 중 하나로 분류하세요:',
  '',
  '1. `clarify`: 발화가 너무 모호하거나 정보가 부족해 무엇을 원하는지 확실히 파악할 수 없는 경우. 자연스러운 한국어 재질문(`clarifyQuestion`)과 부족한 슬롯(`missingSlots`)을 작성하세요.',
  '2. `reroute_talk`: 잡담, 감정 표현, 인사, 일상 질문 등 외부 도구나 Eureka 조작이 불필요한 일상 대화인 경우.',
  '3. `direct_eureka`: Eureka Process 업무/단계/마감일/프로세스 목록 조회·등록·연기·완료 등 유레카 프로세스 조작 요청인 경우. `eurekaOperation`과 `eurekaArgsJson`(JSON 문자열, 예: `{"itemName":"보고서 제출","dueAtIso":"..."}`)을 채우세요.',
  '4. `delegate_swarm`: 코딩, 파일/저장소 작업, GitHub PR 리뷰/승인, 임의의 MCP 도구 활용, 복잡한 분석·추론 작업인 경우. `swarmGoal`에 실행 목표를 구체화해 담으세요.',
  '',
  '주의: 추정으로 섣불리 쓰기를 단정하지 말고, 파악 불가하면 `clarify`, 파악 가능하면 즉시 작업(`direct_eureka` 또는 `delegate_swarm`) 또는 `reroute_talk`를 선택하세요.',
].join('\n');

/**
 * Router에서 `intent === 'unclear'`로 진입했을 때 가장 먼저 의도를 파악해 4방향으로 분기한다.
 */
export class IntentTriage {
  constructor(
    private readonly llm?: LlmClient,
    private readonly wiki?: WikiReader,
    private readonly clock?: Clock,
  ) {}

  async analyze(ctx: TriageContext): Promise<IntentTriageOutcome> {
    const sources: SourceRef[] = [];
    const wikiExcerpts: { text: string; ref: string }[] = [];

    if (this.wiki && ctx.wikiSearchAllowed !== false && ctx.turn.rawText.trim()) {
      try {
        const res = await this.wiki.search(ctx.turn.rawText, 'triage', {
          deadlineAt: ctx.deadlineAt,
        });
        for (const ex of res.excerpts.slice(0, 3)) {
          wikiExcerpts.push({ text: ex.text.slice(0, 500), ref: ex.source.ref });
          sources.push(ex.source);
        }
      } catch {
        // Wiki search failure should not block triage
      }
    }

    if (!this.llm) {
      return { triage: heuristicTriage(ctx.turn.rawText, ctx.context), wikiExcerpts, sources };
    }

    const nowMs = this.clock?.nowMs() ?? Date.now();
    const llmDeadline = new Date(Math.min(Date.parse(ctx.deadlineAt), nowMs + 8_000)).toISOString();
    try {
      const res = await this.llm.complete({
        purpose: 'guide',
        instructions: TRIAGE_INSTRUCTIONS,
        input: buildTriageInput(ctx, wikiExcerpts),
        jsonSchema: TRIAGE_JSON_SCHEMA as { name: string; schema: Record<string, unknown> },
        maxOutputTokens: 512,
        deadlineAt: llmDeadline,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const raw = (res.json ?? JSON.parse(res.text)) as Record<string, unknown>;
      let eurekaArgs: Record<string, unknown> | undefined;
      if (typeof raw['eurekaArgsJson'] === 'string' && raw['eurekaArgsJson'].trim()) {
        try {
          const parsedArgs = JSON.parse(raw['eurekaArgsJson']) as unknown;
          if (parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) {
            eurekaArgs = parsedArgs as Record<string, unknown>;
          }
        } catch {
          // ignore malformed optional JSON string
        }
      }
      const parsed = TriageResult.parse({
        verdict: raw['verdict'],
        rationale: typeof raw['rationale'] === 'string' ? raw['rationale'] : '',
        ...(typeof raw['clarifyQuestion'] === 'string' ? { clarifyQuestion: raw['clarifyQuestion'] } : {}),
        missingSlots: Array.isArray(raw['missingSlots']) ? raw['missingSlots'] : [],
        ...(raw['eurekaOperation'] ? { eurekaOperation: raw['eurekaOperation'] } : {}),
        ...(eurekaArgs ? { eurekaArgs } : {}),
        ...(typeof raw['swarmGoal'] === 'string' ? { swarmGoal: raw['swarmGoal'] } : {}),
      });
      return { triage: parsed, wikiExcerpts, sources };
    } catch {
      return { triage: heuristicTriage(ctx.turn.rawText, ctx.context), wikiExcerpts, sources };
    }
  }
}

function buildTriageInput(ctx: TriageContext, wiki: { text: string; ref: string }[]): string {
  const payload = {
    userText: ctx.turn.rawText,
    routeConfidence: ctx.turn.routeDecision.overallConfidence,
    activeTarget: ctx.context.target ?? null,
    recentTurns: ctx.context.relatedTurns.slice(-6),
    taskRefs: ctx.context.taskRefs,
    availableMcpIds: ctx.availableMcpIds,
    wikiExcerpts: wiki,
  };
  return JSON.stringify(payload);
}

/** LLM 미연결/실패 시 최소 폴백 판정 (추정으로 쓰기를 실행하지 않음) */
function heuristicTriage(text: string, context: ContextPacket): TriageResult {
  const t = text.trim();
  if (!t || t.length < 2) {
    return {
      verdict: 'clarify',
      rationale: 'empty_or_too_short_input',
      clarifyQuestion: '말씀하신 내용을 잘 이해하지 못했어요. 어떤 작업을 원하시는지 다시 말씀해 주시겠어요?',
      missingSlots: ['intent'],
    };
  }
  if (/^(안녕|고마워|잘\s*지냈|심심|배고파|졸려|ㅋㅋ|ㅎㅎ|오늘\s*날씨)/.test(t)) {
    return { verdict: 'reroute_talk', rationale: 'casual_dialogue_heuristic', missingSlots: [] };
  }
  if (/(유레카|eureka|업무\s*목록|할\s*일\s*목록|프로세스)/i.test(t)) {
    if (/프로세스/.test(t)) {
      return {
        verdict: 'direct_eureka',
        rationale: 'eureka_process_list_fallback',
        eurekaOperation: 'list_processes',
        missingSlots: [],
      };
    }
    if (/(등록|추가|생성|만들)/.test(t)) {
      const quoted = /["'“”‘’]([^"'“”‘’]+)["'“”‘’]/.exec(t)?.[1]?.trim();
      const afterPrep =
        !quoted
          ? /(?:유레카|eureka)\s*(?:에|에서)?\s*(.+?)\s*(?:업무|태스크|할\s*일)?\s*(?:등록|추가|생성|만들)/i.exec(t)?.[1]?.trim()
          : undefined;
      const itemName = quoted || (afterPrep && !/^(새|업무|하나)$/.test(afterPrep) ? afterPrep : undefined);
      return {
        verdict: 'direct_eureka',
        rationale: 'eureka_register_item_fallback',
        eurekaOperation: 'register_item',
        ...(itemName ? { eurekaArgs: { itemName } } : {}),
        missingSlots: itemName ? [] : ['itemName'],
      };
    }
    if (/(연기|미뤄|늦춰|기한|마감)/.test(t)) {
      return {
        verdict: 'direct_eureka',
        rationale: 'eureka_postpone_item_fallback',
        eurekaOperation: 'postpone_item',
        missingSlots: ['itemId', 'dueAtMs'],
      };
    }
    if (/(완료|끝내|마쳐)/.test(t)) {
      return {
        verdict: 'direct_eureka',
        rationale: 'eureka_complete_item_fallback',
        eurekaOperation: 'complete_item',
        missingSlots: ['itemId'],
      };
    }
    return {
      verdict: 'direct_eureka',
      rationale: 'eureka_keyword_fallback',
      eurekaOperation: 'list_tasks',
      missingSlots: [],
    };
  }
  if (context.target?.kind === 'github_pr' || /(github|깃허브|pr|리뷰|코드|파일|mcp|터미널|실행)/i.test(t)) {
    return {
      verdict: 'delegate_swarm',
      rationale: 'coding_or_mcp_work_detected',
      swarmGoal: t,
      missingSlots: [],
    };
  }
  return {
    verdict: 'clarify',
    rationale: 'ambiguous_without_llm',
    clarifyQuestion: '어떤 작업인지 정확히 파악하기 어려워요. 조금만 더 구체적으로 말씀해 주시겠어요?',
    missingSlots: ['intent'],
  };
}
