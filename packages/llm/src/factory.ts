import { ConcurrencyLimiter, type LlmClient } from '@deskpet/contracts';
import type { OutputModel } from '@deskpet/output';
import { GeminiLlmClient, type GeminiThinkingLevel } from './GeminiLlmClient.js';
import { CallWindow, GuardedLlmClient, GuardedOutputModel } from './guard.js';
import { LangChainOutputModel } from './LangChainOutputModel.js';
import { LlmOutputModel } from './LlmOutputModel.js';
import { OpenAiLlmClient } from './OpenAiLlmClient.js';

/**
 * .env로 LLM 공급자를 고른다. 기본은 꺼짐. 공급자를 바꿔도 Harness·출력 코드는 바뀌지 않는다.
 *   LLM_PROVIDER=off|gemini|openai|remote   (remote: 팀 원격 fallback API — 아직 없음, C-12)
 *   gemini : GEMINI_API_KEY, GEMINI_MODEL(기본 gemini-3.1-flash-lite), GEMINI_THINKING_LEVEL(선택 minimal|low|medium|high)
 *   openai : OPENAI_API_KEY, OPENAI_MODEL(필수), OPENAI_BASE_URL(선택)
 *   LLM_OUTPUT_CHAIN=direct|langchain  (기본 direct = LlmClient 위 출력 모델. langchain은 openai에서만)
 *   LLM_MAX_CALLS_PER_MINUTE(기본 20), LLM_MAX_OUTPUT_TOKENS(기본 400), LLM_OUTPUT_TIMEOUT_MS(기본 8000)
 * 키 값은 상태 메시지에 넣지 않는다.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

export interface LlmSetup {
  provider: 'off' | 'gemini' | 'openai' | 'remote';
  enabled: boolean;
  reason?: string;
  model?: string;
  outputChain?: 'direct' | 'langchain';
  /** 출력 모델 호출 시간 상한(ms). LLM_OUTPUT_TIMEOUT_MS, 기본 8000 */
  outputTimeoutMs?: number;
  guideClient?: LlmClient;
  outputModel?: OutputModel;
  /** LLM 동시 호출 상한 (D-24). LLM_MAX_CONCURRENT(기본 2), LLM_QUEUE_WAIT_MS(기본 500) */
  limiter?: ConcurrencyLimiter;
}

export function createLlmFromEnv(env: Record<string, string | undefined>): LlmSetup {
  const provider = (env['LLM_PROVIDER'] || 'off').trim().toLowerCase();
  if (provider === 'off') return { provider: 'off', enabled: false, reason: 'LLM_PROVIDER=off' };
  if (provider === 'remote') return { provider: 'remote', enabled: false, reason: 'remote fallback adapter not implemented yet (C-12)' };
  if (provider !== 'gemini' && provider !== 'openai') return { provider: 'off', enabled: false, reason: `unknown LLM_PROVIDER=${provider}` };

  const maxTokens = positiveInt(env['LLM_MAX_OUTPUT_TOKENS'], 400);
  const window = new CallWindow(positiveInt(env['LLM_MAX_CALLS_PER_MINUTE'], 20));
  const chain = (env['LLM_OUTPUT_CHAIN'] || 'direct').trim().toLowerCase() === 'langchain' ? 'langchain' : 'direct';

  let base: LlmClient;
  let model: string;
  let langchainModel: (() => LangChainOutputModel) | undefined;
  if (provider === 'gemini') {
    const apiKey = env['GEMINI_API_KEY'];
    model = env['GEMINI_MODEL']?.trim() || DEFAULT_GEMINI_MODEL;
    if (!apiKey) return { provider, enabled: false, reason: 'GEMINI_API_KEY is empty' };
    // 기본 minimal: Guide·출력은 선택지 고르기·문장 다듬기라 깊은 생각이 필요 없고, 생각이 길면 시간 상한을 넘긴다 (connection-test-issues #14)
    const level = env['GEMINI_THINKING_LEVEL']?.trim().toLowerCase() || 'minimal';
    if (level && !['minimal', 'low', 'medium', 'high'].includes(level)) return { provider, enabled: false, reason: `unknown GEMINI_THINKING_LEVEL=${level}` };
    base = new GeminiLlmClient({ apiKey, model, ...(level ? { thinkingLevel: level as GeminiThinkingLevel } : {}) });
  } else {
    const apiKey = env['OPENAI_API_KEY'];
    const m = env['OPENAI_MODEL']?.trim();
    if (!apiKey) return { provider, enabled: false, reason: 'OPENAI_API_KEY is empty' };
    if (!m) return { provider, enabled: false, reason: 'OPENAI_MODEL is empty' };
    model = m;
    const baseURL = env['OPENAI_BASE_URL']?.trim() || undefined;
    base = new OpenAiLlmClient({ apiKey, model, ...(baseURL ? { baseURL } : {}) });
    langchainModel = () => LangChainOutputModel.openai({ apiKey, model, maxOutputTokens: maxTokens, ...(baseURL ? { baseURL } : {}) });
  }
  if (chain === 'langchain' && !langchainModel) return { provider, enabled: false, reason: 'LLM_OUTPUT_CHAIN=langchain is only wired for openai' };

  // D-24: 공급자 하나를 Guide·출력이 같이 쓰므로 동시 호출 상한도 하나. 자리가 짧게 안 나면 호출하지 않고 대체 경로로 간다
  const concurrency = { limiter: new ConcurrencyLimiter('llm', positiveInt(env['LLM_MAX_CONCURRENT'], 2), 8), waitMs: nonNegativeInt(env['LLM_QUEUE_WAIT_MS'], 500) };
  const guideClient = new GuardedLlmClient(base, window, maxTokens, concurrency);
  const inner = chain === 'langchain' ? langchainModel!() : new LlmOutputModel(new GuardedLlmClient(base, new CallWindow(Number.MAX_SAFE_INTEGER), maxTokens));
  return { provider, enabled: true, model, outputChain: chain, outputTimeoutMs: positiveInt(env['LLM_OUTPUT_TIMEOUT_MS'], 8_000), guideClient, outputModel: new GuardedOutputModel(inner, window, concurrency), limiter: concurrency.limiter };
}

function nonNegativeInt(v: string | undefined, d: number): number {
  if (v === undefined || v.trim() === '') return d;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : d;
}

function positiveInt(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : d;
}
