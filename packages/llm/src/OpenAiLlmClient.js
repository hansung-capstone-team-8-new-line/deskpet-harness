import OpenAI from 'openai';
import { LlmError } from '@deskpet/contracts';
export class OpenAiLlmClient {
    o;
    provider = 'openai';
    client;
    now;
    constructor(o) {
        this.o = o;
        if (!o.model)
            throw new LlmError('disabled', 'OPENAI_MODEL is required');
        this.now = o.now ?? (() => Date.now());
        if (o.client)
            this.client = o.client;
        else {
            if (!o.apiKey)
                throw new LlmError('disabled', 'OPENAI_API_KEY is required');
            this.client = new OpenAI({ apiKey: o.apiKey, ...(o.baseURL ? { baseURL: o.baseURL } : {}), maxRetries: 0 });
        }
    }
    async complete(req) {
        const rawTimeout = Date.parse(req.deadlineAt) - this.now();
        if (!(rawTimeout > 0))
            throw new LlmError('timeout', 'deadline already passed');
        if (req.signal?.aborted)
            throw new LlmError('aborted', 'aborted before call');
        // Node.js setTimeout overflows above signed 32-bit max (2_147_483_647 ms) and fires in 1ms.
        const timeout = Math.min(rawTimeout, 2_147_483_647);
        const body = {
            model: this.o.model,
            instructions: req.instructions,
            input: req.input,
            max_output_tokens: req.maxOutputTokens,
            store: false,
            ...(req.jsonSchema ? { text: { format: { type: 'json_schema', name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true } } } : {}),
        };
        let res;
        try {
            res = await this.client.responses.create(body, { ...(req.signal ? { signal: req.signal } : {}), timeout, maxRetries: 0 });
        }
        catch (e) {
            throw mapOpenAiError(e);
        }
        if (res.status === 'incomplete')
            throw new LlmError('invalid_output', `incomplete response: ${res.incomplete_details?.reason ?? 'unknown'}`);
        const text = res.output_text ?? '';
        const out = {
            text,
            model: res.model ?? this.o.model,
            ...(res.usage ? { usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } } : {}),
        };
        if (req.jsonSchema) {
            try {
                out.json = JSON.parse(text);
            }
            catch {
                throw new LlmError('invalid_output', 'response is not valid JSON');
            }
        }
        return out;
    }
}
/** SDK 오류 → 공통 코드. 메시지에는 상태 코드와 SDK 오류 이름만 남긴다 */
export function mapOpenAiError(e) {
    if (e instanceof LlmError)
        return e;
    if (e instanceof OpenAI.APIUserAbortError)
        return new LlmError('aborted', 'request aborted');
    if (e instanceof OpenAI.APIConnectionTimeoutError)
        return new LlmError('timeout', 'request timed out');
    if (e instanceof OpenAI.APIConnectionError)
        return new LlmError('unavailable', 'connection failed');
    if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError)
        return new LlmError('auth', `auth failed (${e.status})`);
    if (e instanceof OpenAI.RateLimitError)
        return new LlmError('rate_limited', 'rate limited (429)');
    if (e instanceof OpenAI.BadRequestError || e instanceof OpenAI.UnprocessableEntityError || e instanceof OpenAI.NotFoundError)
        return new LlmError('bad_request', `bad request (${e.status})`);
    if (e instanceof OpenAI.APIError)
        return new LlmError('unavailable', `provider error (${e.status ?? '-'})`);
    if (e instanceof Error && e.name === 'AbortError')
        return new LlmError('aborted', 'request aborted');
    return new LlmError('unavailable', 'unexpected provider failure');
}
