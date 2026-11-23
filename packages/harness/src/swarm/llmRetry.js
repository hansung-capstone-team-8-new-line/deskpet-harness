import { LlmError } from '@deskpet/contracts';
const RETRYABLE_CODES = new Set(['unavailable', 'rate_limited', 'timeout']);
/**
 * 일시적 공급자 오류(503/429/타임아웃)에 대해 남은 deadline 예산 안에서만 짧게 재시도한다.
 */
export async function completeWithRetry(llm, req, opts = {}) {
    const maxAttempts = opts.maxAttempts ?? 3;
    const perAttemptMs = opts.perAttemptMs ?? 20_000;
    const baseDelayMs = opts.baseDelayMs ?? 400;
    const nowFn = opts.now ?? (() => Date.now());
    const overallMs = Date.parse(req.deadlineAt);
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (req.signal?.aborted)
            throw lastErr ?? new LlmError('aborted', 'aborted before retry');
        const now = nowFn();
        const remaining = Number.isFinite(overallMs) ? overallMs - now : perAttemptMs;
        if (remaining <= 0)
            break;
        const isLast = attempt === maxAttempts - 1;
        const attemptDeadline = !isLast && Number.isFinite(overallMs) && remaining > perAttemptMs + 2_000
            ? new Date(now + perAttemptMs).toISOString()
            : req.deadlineAt;
        try {
            return await llm.complete({ ...req, deadlineAt: attemptDeadline });
        }
        catch (err) {
            lastErr = err;
            if (!(err instanceof LlmError) || !RETRYABLE_CODES.has(err.code) || isLast || req.signal?.aborted) {
                throw err;
            }
            const delay = baseDelayMs * (attempt + 1);
            const afterWaitRemaining = Number.isFinite(overallMs) ? overallMs - nowFn() - delay : perAttemptMs;
            if (afterWaitRemaining < 1_000) {
                throw err;
            }
            await sleepAbortable(delay, req.signal);
        }
    }
    throw lastErr ?? new LlmError('timeout', 'deadline already passed');
}
function sleepAbortable(ms, signal) {
    if (ms <= 0 || signal?.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
