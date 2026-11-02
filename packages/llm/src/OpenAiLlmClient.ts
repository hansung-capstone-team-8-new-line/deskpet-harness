import OpenAI from 'openai';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from '@deskpet/contracts';

/**
 * OpenAI 직접 호출 어댑터 (Responses API, 구조화 출력).
 * 기술 스택 문서의 "LLM Harness·프롬프트 — OpenAI SDK" 행을 따른다. 원격 fallback 경로로 바꾸면 이 파일 대신 다른 어댑터를 쓴다.
 *
 * - SDK 자체 재시도는 끈다(maxRetries=0). 호출 시간은 요청 deadline 안으로 제한한다.
 * - API 키는 오류 메시지·로그에 넣지 않는다.
 */

/** 테스트에서 SDK를 대체하기 위한 최소 모양 */
export interface ResponsesApiLike {
  responses: {
    create(
      body: Record<string, unknown>,
      options: { signal?: AbortSignal; timeout: number; maxRetries: number },
    ): Promise<{ output_text?: string; status?: string | null; model?: string; usage?: { input_tokens: number; output_tokens: number } | null; incomplete_details?: { reason?: string } | null }>;
  };
}

export interface OpenAiLlmClientOptions {
  model: string;
  apiKey?: string;
  baseURL?: string;
  /** 주입 시 SDK 대신 사용 (테스트) */
  client?: ResponsesApiLike;
  now?: () => number;
}

export class OpenAiLlmClient implements LlmClient {
  readonly provider = 'openai';
  private readonly client: ResponsesApiLike;
  private readonly now: () => number;

  constructor(private readonly o: OpenAiLlmClientOptions) {
    if (!o.model) throw new LlmError('disabled', 'OPENAI_MODEL is required');
    this.now = o.now ?? (() => Date.now());
    if (o.client) this.client = o.client;
    else {
      if (!o.apiKey) throw new LlmError('disabled', 'OPENAI_API_KEY is required');
      this.client = new OpenAI({ apiKey: o.apiKey, ...(o.baseURL ? { baseURL: o.baseURL } : {}), maxRetries: 0 }) as unknown as ResponsesApiLike;
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const timeout = Date.parse(req.deadlineAt) - this.now();
    if (!(timeout > 0)) throw new LlmError('timeout', 'deadline already passed');
    if (req.signal?.aborted) throw new LlmError('aborted', 'aborted before call');

    const body: Record<string, unknown> = {
      model: this.o.model,
      instructions: req.instructions,
      input: req.input,
      max_output_tokens: req.maxOutputTokens,
      store: false,
      ...(req.jsonSchema ? { text: { format: { type: 'json_schema', name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true } } } : {}),
    };

    let res: Awaited<ReturnType<ResponsesApiLike['responses']['create']>>;
    try {
      res = await this.client.responses.create(body, { ...(req.signal ? { signal: req.signal } : {}), timeout, maxRetries: 0 });
    } catch (e) {
      throw mapOpenAiError(e);
    }

    if (res.status === 'incomplete') throw new LlmError('invalid_output', `incomplete response: ${res.incomplete_details?.reason ?? 'unknown'}`);
    const text = res.output_text ?? '';
    const out: LlmResponse = {
      text,
      model: res.model ?? this.o.model,
      ...(res.usage ? { usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } } : {}),
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

/** SDK 오류 → 공통 코드. 메시지에는 상태 코드와 SDK 오류 이름만 남긴다 */
export function mapOpenAiError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof OpenAI.APIUserAbortError) return new LlmError('aborted', 'request aborted');
  if (e instanceof OpenAI.APIConnectionTimeoutError) return new LlmError('timeout', 'request timed out');
  if (e instanceof OpenAI.APIConnectionError) return new LlmError('unavailable', 'connection failed');
  if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError) return new LlmError('auth', `auth failed (${e.status})`);
  if (e instanceof OpenAI.RateLimitError) return new LlmError('rate_limited', 'rate limited (429)');
  if (e instanceof OpenAI.BadRequestError || e instanceof OpenAI.UnprocessableEntityError || e instanceof OpenAI.NotFoundError) return new LlmError('bad_request', `bad request (${e.status})`);
  if (e instanceof OpenAI.APIError) return new LlmError('unavailable', `provider error (${e.status ?? '-'})`);
  if (e instanceof Error && e.name === 'AbortError') return new LlmError('aborted', 'request aborted');
  return new LlmError('unavailable', 'unexpected provider failure');
}
