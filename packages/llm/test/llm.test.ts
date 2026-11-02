import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { LlmError, type LlmClient, type LlmRequest } from '@deskpet/contracts';
import { ApiError } from '@google/genai';
import { CallWindow, GeminiLlmClient, GuardedLlmClient, LangChainOutputModel, LlmOutputModel, OpenAiLlmClient, ScriptedLlmClient, createLlmFromEnv, type GenerateContentApiLike, type ResponsesApiLike } from '@deskpet/llm';

const NOW = Date.parse('2026-10-05T09:00:00.000Z');
const SECRET = 'sk-test-SECRET-should-never-appear';
const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  purpose: 'guide',
  instructions: 'sys',
  input: 'hello',
  jsonSchema: { name: 'x', schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } } },
  maxOutputTokens: 100,
  deadlineAt: new Date(NOW + 3_000).toISOString(),
  ...over,
});

function fakeSdk(reply: (body: Record<string, unknown>) => unknown) {
  const calls: { body: Record<string, unknown>; options: { timeout: number; maxRetries: number } }[] = [];
  const client: ResponsesApiLike = {
    responses: {
      create: async (body, options) => {
        calls.push({ body, options });
        const r = reply(body);
        if (r instanceof Error) throw r;
        return r as never;
      },
    },
  };
  return { client, calls };
}

const openai = (reply: (b: Record<string, unknown>) => unknown) => {
  const f = fakeSdk(reply);
  return { llm: new OpenAiLlmClient({ model: 'test-model', client: f.client, now: () => NOW }), calls: f.calls };
};

function fakeGemini(reply: (p: { model: string; contents: string; config: Record<string, unknown> }) => unknown) {
  const calls: { model: string; contents: string; config: Record<string, unknown> }[] = [];
  const client: GenerateContentApiLike = {
    models: {
      generateContent: async (p) => {
        calls.push(p);
        const r = reply(p);
        if (r instanceof Error) throw r;
        return r as never;
      },
    },
  };
  return { client, calls };
}
const gemini = (reply: (p: { config: Record<string, unknown> }) => unknown, o: { thinkingLevel?: 'minimal' } = {}) => {
  const f = fakeGemini(reply);
  return { llm: new GeminiLlmClient({ model: 'gemini-3.1-flash-lite', client: f.client, now: () => NOW, ...o }), calls: f.calls };
};
const geminiOk = (text: string) => ({ text, candidates: [{ finishReason: 'STOP' }], modelVersion: 'gemini-3.1-flash-lite', usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 7 } });

/** 모든 어댑터가 지켜야 하는 공통 계약 (fallback 어댑터 추가 시 여기에 등록한다) */
const adapters: [string, (ok: unknown) => LlmClient, () => LlmClient][] = [
  ['scripted', (ok) => new ScriptedLlmClient(() => ok), () => new ScriptedLlmClient(() => 'not json')],
  ['openai', (ok) => openai(() => ({ output_text: JSON.stringify(ok), status: 'completed', model: 'test-model' })).llm, () => openai(() => ({ output_text: 'not json', status: 'completed' })).llm],
  ['gemini', (ok) => gemini(() => geminiOk(JSON.stringify(ok))).llm, () => gemini(() => geminiOk('not json')).llm],
];

describe.each(adapters)('LlmClient 공통 계약: %s', (_name, good, bad) => {
  it('jsonSchema 요청이면 파싱된 json을 돌려준다', async () => {
    const r = await good({ a: 'b' }).complete(req());
    expect(r.json).toEqual({ a: 'b' });
  });
  it('JSON이 아니면 invalid_output', async () => {
    await expect(bad().complete(req())).rejects.toMatchObject({ code: 'invalid_output' });
  });
});

describe('OpenAiLlmClient', () => {
  it('Responses API 구조화 출력으로 요청하고 SDK 재시도는 끈다. timeout은 deadline까지', async () => {
    const { llm, calls } = openai(() => ({ output_text: '{"a":"1"}', status: 'completed', model: 'test-model', usage: { input_tokens: 10, output_tokens: 3 } }));
    const r = await llm.complete(req());
    expect(calls[0]!.body).toMatchObject({
      model: 'test-model',
      instructions: 'sys',
      input: 'hello',
      max_output_tokens: 100,
      store: false,
      text: { format: { type: 'json_schema', name: 'x', strict: true } },
    });
    expect(calls[0]!.options).toEqual({ timeout: 3_000, maxRetries: 0 });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
  });

  it('deadline이 지났으면 호출하지 않는다', async () => {
    const { llm, calls } = openai(() => ({ output_text: '{}' }));
    await expect(llm.complete(req({ deadlineAt: new Date(NOW - 1).toISOString() }))).rejects.toMatchObject({ code: 'timeout' });
    expect(calls).toHaveLength(0);
  });

  it('잘린 응답(incomplete)은 invalid_output', async () => {
    const { llm } = openai(() => ({ output_text: '{"a":', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
    await expect(llm.complete(req())).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('SDK 오류를 공통 코드로 바꾸고 키를 메시지에 남기지 않는다', async () => {
    const cases: [Error, string][] = [
      [new OpenAI.AuthenticationError(401, undefined, `bad key ${SECRET}`, new Headers()), 'auth'],
      [new OpenAI.RateLimitError(429, undefined, 'slow down', new Headers()), 'rate_limited'],
      [new OpenAI.BadRequestError(400, undefined, 'bad', new Headers()), 'bad_request'],
      [new OpenAI.APIConnectionTimeoutError({ message: 'timeout' }), 'timeout'],
      [new OpenAI.APIConnectionError({ message: 'down' }), 'unavailable'],
      [new Error(`weird ${SECRET}`), 'unavailable'],
    ];
    for (const [err, code] of cases) {
      const { llm } = openai(() => err);
      const e = (await llm.complete(req()).catch((x: unknown) => x)) as LlmError;
      expect(e).toBeInstanceOf(LlmError);
      expect(e.code).toBe(code);
      expect(e.message).not.toContain(SECRET);
    }
  });
});

describe('GuardedLlmClient', () => {
  it('분당 호출 상한을 넘으면 공급자를 호출하지 않는다. 토큰 상한을 낮춘다', async () => {
    let t = NOW;
    const inner = new ScriptedLlmClient(() => ({ a: 'x' }));
    const g = new GuardedLlmClient(inner, new CallWindow(2, () => t), 50);
    await g.complete(req({ maxOutputTokens: 999 }));
    await g.complete(req());
    await expect(g.complete(req())).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(inner.requests).toHaveLength(2);
    expect(inner.requests[0]!.maxOutputTokens).toBe(50);
    t += 60_001;
    await g.complete(req());
    expect(inner.requests).toHaveLength(3);
  });
});

describe('createLlmFromEnv', () => {
  it('기본은 꺼짐, remote는 아직 어댑터 없음, 필수 값이 없으면 켜지지 않는다', () => {
    expect(createLlmFromEnv({})).toMatchObject({ provider: 'off', enabled: false });
    expect(createLlmFromEnv({ LLM_PROVIDER: 'remote' })).toMatchObject({ provider: 'remote', enabled: false });
    expect(createLlmFromEnv({ LLM_PROVIDER: 'gemini' })).toMatchObject({ enabled: false, reason: 'GEMINI_API_KEY is empty' });
    expect(createLlmFromEnv({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: SECRET, GEMINI_THINKING_LEVEL: 'max' })).toMatchObject({ enabled: false });
    expect(createLlmFromEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: SECRET })).toMatchObject({ enabled: false, reason: 'OPENAI_MODEL is empty' });
    expect(createLlmFromEnv({ LLM_PROVIDER: 'openai', OPENAI_MODEL: 'm' })).toMatchObject({ enabled: false, reason: 'OPENAI_API_KEY is empty' });
    expect(createLlmFromEnv({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: SECRET, LLM_OUTPUT_CHAIN: 'langchain' })).toMatchObject({ enabled: false });
  });
  it('gemini: 기본 모델 gemini-3.1-flash-lite, 출력은 공급자 중립 경로 (네트워크 호출 없음)', () => {
    const s = createLlmFromEnv({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: SECRET });
    expect(s).toMatchObject({ provider: 'gemini', enabled: true, model: 'gemini-3.1-flash-lite', outputChain: 'direct' });
    expect(s.guideClient?.provider).toBe('gemini');
    expect(JSON.stringify({ ...s, guideClient: undefined, outputModel: undefined })).not.toContain(SECRET);
  });
  it('openai로 바꾸면 같은 모양의 설정이 나온다 (코드 변경 없이 .env만 변경)', () => {
    const s = createLlmFromEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: SECRET, OPENAI_MODEL: 'm' });
    expect(s).toMatchObject({ provider: 'openai', enabled: true, model: 'm', outputChain: 'direct' });
    expect(s.guideClient?.provider).toBe('openai');
    expect(createLlmFromEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: SECRET, OPENAI_MODEL: 'm', LLM_OUTPUT_CHAIN: 'langchain' })).toMatchObject({ enabled: true, outputChain: 'langchain' });
  });
});

describe('GeminiLlmClient', () => {
  it('generateContent에 지침·JSON 스키마·시간 제한을 넣고 SDK 재시도는 끈다. 생각 토큰 여유를 더한다', async () => {
    const { llm, calls } = gemini(() => geminiOk('{"a":"1"}'));
    const r = await llm.complete(req());
    const c = calls[0]!;
    expect(c.model).toBe('gemini-3.1-flash-lite');
    expect(c.contents).toBe('hello');
    expect(c.config).toMatchObject({ systemInstruction: 'sys', maxOutputTokens: 100 + 1024, responseMimeType: 'application/json', httpOptions: { retryOptions: { attempts: 1 } } });
    // 짧은 서버 timeout 헤더(X-Server-Timeout)는 400을 일으키므로 보내지 않는다
    expect((c.config['httpOptions'] as Record<string, unknown>)['timeout']).toBeUndefined();
    expect(c.config['responseJsonSchema']).toEqual(req().jsonSchema!.schema);
    expect(c.config['abortSignal']).toBeInstanceOf(AbortSignal);
    expect(c.config['thinkingConfig']).toBeUndefined();
    expect(r).toMatchObject({ json: { a: '1' }, usage: { inputTokens: 20, outputTokens: 12 } });
  });

  it('생각 수준을 지정하면 thinkingConfig로 보낸다', async () => {
    const { llm, calls } = gemini(() => geminiOk('{"a":"1"}'), { thinkingLevel: 'minimal' });
    await llm.complete(req());
    expect(calls[0]!.config['thinkingConfig']).toEqual({ thinkingLevel: 'MINIMAL' });
  });

  it('잘린 응답·차단은 invalid_output, deadline이 지나면 호출하지 않는다', async () => {
    await expect(gemini(() => ({ text: '{"a":', candidates: [{ finishReason: 'MAX_TOKENS' }] })).llm.complete(req())).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(gemini(() => ({ text: '', promptFeedback: { blockReason: 'SAFETY' } })).llm.complete(req())).rejects.toMatchObject({ code: 'invalid_output' });
    const g = gemini(() => geminiOk('{}'));
    await expect(g.llm.complete(req({ deadlineAt: new Date(NOW - 1).toISOString() }))).rejects.toMatchObject({ code: 'timeout' });
    expect(g.calls).toHaveLength(0);
  });

  it('SDK 오류를 공통 코드로 바꾸고 키를 메시지에 남기지 않는다', async () => {
    const timeout = new Error(`aborted ${SECRET}`);
    timeout.name = 'TimeoutError';
    const cases: [Error, string][] = [
      [new ApiError({ message: `API key not valid ${SECRET}`, status: 400 }), 'auth'],
      [new ApiError({ message: 'denied', status: 403 }), 'auth'],
      [new ApiError({ message: 'quota', status: 429 }), 'rate_limited'],
      [new ApiError({ message: 'bad schema', status: 400 }), 'bad_request'],
      [new ApiError({ message: `deadline too short ${SECRET} AIzaSyD-0123456789abcdefghij`, status: 400 }), 'bad_request'],
      [new ApiError({ message: 'oops', status: 503 }), 'unavailable'],
      [timeout, 'timeout'],
      [new Error(`weird ${SECRET}`), 'unavailable'],
    ];
    for (const [err, code] of cases) {
      const e = (await gemini(() => err).llm.complete(req()).catch((x: unknown) => x)) as LlmError;
      expect(e).toBeInstanceOf(LlmError);
      expect(e.code).toBe(code);
      expect(e.message).not.toContain(SECRET);
      expect(e.message).not.toContain('AIzaSyD');
    }
  });
});

describe('LlmOutputModel (공급자 중립 출력 경로)', () => {
  const input = { instructions: 'SYS', prompt: 'PROMPT', maxChars: 200, allowedEmotions: ['neutral'], deadlineMs: 1_000 };
  it('출력 스키마로 요청하고 초안을 검증한다', async () => {
    const llm = new ScriptedLlmClient(() => ({ text: 'a', displayText: 'b', emotion: 'neutral' }));
    expect(await new LlmOutputModel(llm, { now: () => NOW }).generate(input)).toEqual({ text: 'a', displayText: 'b', emotion: 'neutral' });
    expect(llm.requests[0]).toMatchObject({ purpose: 'output', instructions: 'SYS', input: 'PROMPT', jsonSchema: { name: 'deskpet_output' }, deadlineAt: new Date(NOW + 1_000).toISOString() });
  });
  it('형식이 틀리면 invalid_output', async () => {
    await expect(new LlmOutputModel(new ScriptedLlmClient(() => ({ text: 1 }))).generate(input)).rejects.toMatchObject({ code: 'invalid_output' });
  });
});

describe('LangChainOutputModel', () => {
  const input = { instructions: 'SYS', prompt: 'PROMPT', maxChars: 200, allowedEmotions: ['neutral'], deadlineMs: 1_000 };
  it('지침과 프롬프트만 보내고 초안을 검증해 돌려준다', async () => {
    const seen: unknown[] = [];
    const m = new LangChainOutputModel({ invoke: async (msgs) => (seen.push(msgs), { text: 'a', displayText: 'b', emotion: 'neutral' }) });
    expect(await m.generate(input)).toEqual({ text: 'a', displayText: 'b', emotion: 'neutral' });
    expect(seen[0]).toEqual([
      ['system', 'SYS'],
      ['human', 'PROMPT'],
    ]);
  });
  it('형식이 틀리면 invalid_output, 호출 실패는 unavailable', async () => {
    await expect(new LangChainOutputModel({ invoke: async () => ({ text: 1 }) }).generate(input)).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(new LangChainOutputModel({ invoke: async () => Promise.reject(new Error('x')) }).generate(input)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
