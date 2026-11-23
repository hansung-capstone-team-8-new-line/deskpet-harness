import { LimiterBusyError, LlmError } from '@deskpet/contracts';
/** 같은 창을 Guide 호출과 출력 호출이 함께 쓴다 */
export class CallWindow {
    maxPerMinute;
    calls = [];
    now;
    constructor(maxPerMinute, now) {
        this.maxPerMinute = maxPerMinute;
        this.now = now ?? (() => Date.now());
    }
    take() {
        const t = this.now();
        this.calls = this.calls.filter((x) => t - x < 60_000);
        if (this.calls.length >= this.maxPerMinute)
            throw new LlmError('budget_exceeded', `more than ${this.maxPerMinute} LLM calls per minute`);
        this.calls.push(t);
    }
}
async function limited(c, fn) {
    if (!c)
        return fn();
    try {
        return await c.limiter.run(fn, { waitMs: c.waitMs });
    }
    catch (e) {
        if (e instanceof LimiterBusyError)
            throw new LlmError('busy', e.message);
        throw e;
    }
}
export class GuardedLlmClient {
    inner;
    window;
    maxOutputTokens;
    concurrency;
    constructor(inner, window, maxOutputTokens, concurrency) {
        this.inner = inner;
        this.window = window;
        this.maxOutputTokens = maxOutputTokens;
        this.concurrency = concurrency;
    }
    get provider() {
        return this.inner.provider;
    }
    async complete(req) {
        return limited(this.concurrency, async () => {
            this.window.take();
            return this.inner.complete({ ...req, maxOutputTokens: Math.min(req.maxOutputTokens, this.maxOutputTokens) });
        });
    }
}
export class GuardedOutputModel {
    inner;
    window;
    concurrency;
    constructor(inner, window, concurrency) {
        this.inner = inner;
        this.window = window;
        this.concurrency = concurrency;
    }
    generate(input) {
        return limited(this.concurrency, async () => {
            this.window.take();
            return this.inner.generate(input);
        });
    }
}
