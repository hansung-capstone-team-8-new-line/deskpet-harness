import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from '@deskpet/contracts';

/**
 * Gemini API 어댑터 (Google GenAI SDK, generateContent + JSON 스키마 구조화 출력).
 * OpenAI 결제 문제로 개발 기본 공급자로 쓴다. 나중에 LLM_PROVIDER=openai로 바꾸면 OpenAiLlmClient를 쓴다 (같은 LlmClient port).
 *
 * - SDK 재시도는 끈다(attempts=1). 호출 시간은 abortSignal로 요청 deadline 안에 끊는다 (서버 timeout 헤더는 보내지 않음).
 * - Gemini 3 계열은 생각(thinking) 토큰이 maxOutputTokens에 포함되므로 thinkingAllowance만큼 여유를 더한다.
 * - API 키는 오류 메시지·로그에 넣지 않는다.
 */

/** 테스트에서 SDK를 대체하기 위한 최소 모양 */
export interface GenerateContentApiLike {
  models: {
    generateContent(params: { model: string; contents: string; config: Record<string, unknown> }): Promise<{
      text?: string | undefined;
      candidates?: { finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
      modelVersion?: string;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    }>;
  };
}

export type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface GeminiLlmClientOptions {
  model: string;
  apiKey?: string;
  /** 지정하면 thinkingConfig.thinkingLevel로 보낸다. 미지정이면 모델 기본값 */
  thinkingLevel?: GeminiThinkingLevel;
  /** 생각 토큰 여유 (기본 1024) */
  thinkingAllowance?: number;
  client?: GenerateContentApiLike;
  now?: () => number;
}

const LEVELS: Record<GeminiThinkingLevel, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export class GeminiLlmClient implements LlmClient {
  readonly provider = 'gemini';
  private readonly client: GenerateContentApiLike;
  private readonly now: () => number;

  constructor(private readonly o: GeminiLlmClientOptions) {
    if (!o.model) throw new LlmError('disabled', 'GEMINI_MODEL is required');
    this.now = o.now ?? (() => Date.now());
    if (o.client) this.client = o.client;
    else {
      if (!o.apiKey) throw new LlmError('disabled', 'GEMINI_API_KEY is required');
      this.client = new GoogleGenAI({ apiKey: o.apiKey }) as unknown as GenerateContentApiLike;
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const timeout = Date.parse(req.deadlineAt) - this.now();
    if (!(timeout > 0)) throw new LlmError('timeout', 'deadline already passed');
    if (req.signal?.aborted) throw new LlmError('aborted', 'aborted before call');

    const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    const config: Record<string, unknown> = {
      systemInstruction: req.instructions,
      maxOutputTokens: req.maxOutputTokens + (this.o.thinkingAllowance ?? 1024),
      abortSignal: signal,
      // httpOptions.timeout은 쓰지 않는다: SDK가 X-Server-Timeout 헤더(초)로 보내는데 짧은 값(예: 4초)은 서버가 400으로 거부한다.
      // 시간 제한은 abortSignal로 클라이언트에서 건다.
      httpOptions: { retryOptions: { attempts: 1 } },
      ...(this.o.thinkingLevel ? { thinkingConfig: { thinkingLevel: LEVELS[this.o.thinkingLevel] } } : {}),
      ...(req.jsonSchema ? { responseMimeType: 'application/json', responseJsonSchema: req.jsonSchema.schema } : {}),
    };

    let res: Awaited<ReturnType<GenerateContentApiLike['models']['generateContent']>>;
    try {
      res = await this.client.models.generateContent({ model: this.o.model, contents: req.input, config });
    } catch (e) {
      throw mapGeminiError(e, req.signal);
    }

    if (res.promptFeedback?.blockReason) throw new LlmError('invalid_output', `blocked by provider (${res.promptFeedback.blockReason})`);
    const finish = res.candidates?.[0]?.finishReason;
    if (finish && finish !== 'STOP') throw new LlmError('invalid_output', `incomplete response (${finish})`);
    const text = res.text ?? '';
    const u = res.usageMetadata;
    const out: LlmResponse = {
      text,
      model: res.modelVersion ?? this.o.model,
      ...(u ? { usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) } } : {}),
    };
    if (req.jsonSchema) {
      try {
        out.json = JSON.parse(text);
      } catch {
        throw new LlmError('invalid_output', 'response is not valid JSON');
      }
    }
    return out;
  }
}

/** 진단용 짧은 메시지. 키처럼 보이는 문자열은 지운다 */
function redact(m: string): string {
  return m
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[redacted]')
    .replace(/sk-[0-9A-Za-z_-]{10,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

/** SDK 오류 → 공통 코드. 메시지에는 상태 코드(400·404는 짧은 진단)만 남긴다 */
export function mapGeminiError(e: unknown, callerSignal?: AbortSignal): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof ApiError) {
    const s = e.status;
    // Gemini는 잘못된 키를 400(API_KEY_INVALID)으로 돌려준다
    if (s === 401 || s === 403 || (s === 400 && /api[_ ]?key/i.test(e.message))) return new LlmError('auth', `auth failed (${s})`);
    if (s === 429) return new LlmError('rate_limited', 'rate limited (429)');
    if (s === 400 || s === 404) return new LlmError('bad_request', `bad request (${s}): ${redact(e.message)}`);
    return new LlmError('unavailable', `provider error (${s})`);
  }
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
    return callerSignal?.aborted ? new LlmError('aborted', 'request aborted') : new LlmError('timeout', 'request timed out');
  }
  return new LlmError('unavailable', 'unexpected provider failure');
}
