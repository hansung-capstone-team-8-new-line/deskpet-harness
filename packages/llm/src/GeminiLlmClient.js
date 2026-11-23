import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { LlmError } from '@deskpet/contracts';
const LEVELS = {
    minimal: ThinkingLevel.MINIMAL,
    low: ThinkingLevel.LOW,
    medium: ThinkingLevel.MEDIUM,
    high: ThinkingLevel.HIGH,
};
const MAX_TIMER_MS = 2_147_483_647;
export class GeminiLlmClient {
    o;
    provider = 'gemini';
    client;
    now;
    constructor(o) {
        this.o = o;
        if (!o.model)
            throw new LlmError('disabled', 'GEMINI_MODEL is required');
        this.now = o.now ?? (() => Date.now());
        if (o.client)
            this.client = o.client;
        else {
            if (!o.apiKey)
                throw new LlmError('disabled', 'GEMINI_API_KEY is required');
            this.client = new GoogleGenAI({ apiKey: o.apiKey });
        }
    }
    async complete(req) {
        const timeout = Date.parse(req.deadlineAt) - this.now();
        if (!(timeout > 0))
            throw new LlmError('timeout', 'deadline already passed');
        if (req.signal?.aborted)
            throw new LlmError('aborted', 'aborted before call');
        // Node.js AbortSignal.timeout / setTimeout throw RangeError or overflow above 32-bit limits (~24.8 days).
        const timeoutSignal = timeout <= MAX_TIMER_MS ? AbortSignal.timeout(timeout) : undefined;
        const signal = req.signal && timeoutSignal ? AbortSignal.any([req.signal, timeoutSignal]) : (req.signal ?? timeoutSignal);
        const config = {
            systemInstruction: req.instructions,
            maxOutputTokens: req.maxOutputTokens + (this.o.thinkingAllowance ?? 1024),
            ...(signal ? { abortSignal: signal } : {}),
            // httpOptions.timeout은 쓰지 않는다: SDK가 X-Server-Timeout 헤더(초)로 보내는데 짧은 값(예: 4초)은 서버가 400으로 거부한다.
            // 시간 제한은 abortSignal로 클라이언트에서 건다.
            httpOptions: { retryOptions: { attempts: 1 } },
            ...(this.o.thinkingLevel ? { thinkingConfig: { thinkingLevel: LEVELS[this.o.thinkingLevel] } } : {}),
            ...(req.jsonSchema ? { responseMimeType: 'application/json', responseJsonSchema: req.jsonSchema.schema } : {}),
        };
        let res;
        try {
            res = await this.client.models.generateContent({ model: this.o.model, contents: req.input, config });
        }
        catch (e) {
            throw mapGeminiError(e, req.signal);
        }
        if (res.promptFeedback?.blockReason)
            throw new LlmError('invalid_output', `blocked by provider (${res.promptFeedback.blockReason})`);
        const finish = res.candidates?.[0]?.finishReason;
        if (finish && finish !== 'STOP')
            throw new LlmError('invalid_output', `incomplete response (${finish})`);
        const text = res.text ?? '';
        const u = res.usageMetadata;
        const out = {
            text,
            model: res.modelVersion ?? this.o.model,
            ...(u ? { usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) } } : {}),
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
/** 진단용 짧은 메시지. 키처럼 보이는 문자열은 지운다 */
function redact(m) {
    return m
        .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[redacted]')
        .replace(/sk-[0-9A-Za-z_-]{10,}/g, '[redacted]')
        .replace(/\s+/g, ' ')
        .slice(0, 160);
}
/** SDK 오류 → 공통 코드. 메시지에는 상태 코드(400·404는 짧은 진단)만 남긴다 */
export function mapGeminiError(e, callerSignal) {
    if (e instanceof LlmError)
        return e;
    if (e instanceof ApiError) {
        const s = e.status;
        // Gemini는 잘못된 키를 400(API_KEY_INVALID)으로 돌려준다
        if (s === 401 || s === 403 || (s === 400 && /api[_ ]?key/i.test(e.message)))
            return new LlmError('auth', `auth failed (${s})`);
        if (s === 429)
            return new LlmError('rate_limited', 'rate limited (429)');
        if (s === 400 || s === 404)
            return new LlmError('bad_request', `bad request (${s}): ${redact(e.message)}`);
        return new LlmError('unavailable', `provider error (${s})`);
    }
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
        return callerSignal?.aborted ? new LlmError('aborted', 'request aborted') : new LlmError('timeout', 'request timed out');
    }
    return new LlmError('unavailable', 'unexpected provider failure');
}
