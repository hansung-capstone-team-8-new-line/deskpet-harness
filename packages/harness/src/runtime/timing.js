import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
const store = new AsyncLocalStorage();
export async function collectTimings(fn, sink = { entries: [] }) {
    sink.entries = [];
    const t0 = performance.now();
    const value = await store.run(sink, fn);
    return { value, timings: [...sink.entries], totalMs: Math.round(performance.now() - t0) };
}
/** 기록 중인 요청이 있으면 한 단계를 더한다 */
export function recordTiming(stage, ms, ok) {
    store.getStore()?.entries.push({ stage, ms: Math.round(ms), ok });
}
/** port 객체의 메서드 호출마다 시간을 잰다. 원래 객체에 직접 호출하므로 내부 호출은 세지 않는다 */
export function timedPort(port, prefix, rename) {
    return new Proxy(port, {
        get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            if (typeof v !== 'function' || typeof prop !== 'string')
                return v;
            const stage = rename?.[prop] ?? `${prefix}.${prop}`;
            return (...args) => {
                const t0 = performance.now();
                let out;
                try {
                    out = Reflect.apply(v, target, args);
                }
                catch (e) {
                    recordTiming(stage, performance.now() - t0, false);
                    throw e;
                }
                if (out instanceof Promise) {
                    return out.then((r) => {
                        recordTiming(stage, performance.now() - t0, true);
                        return r;
                    }, (e) => {
                        recordTiming(stage, performance.now() - t0, false);
                        throw e;
                    });
                }
                recordTiming(stage, performance.now() - t0, true);
                return out;
            };
        },
    });
}
/** 같은 단계는 합쳐서 요약한다 (로그용): "github.getReviewContext 420ms×2, llm.guide 900ms" */
export function summarizeTimings(ts) {
    const m = new Map();
    for (const t of ts) {
        const e = m.get(t.stage) ?? { ms: 0, n: 0, fail: 0 };
        e.ms += t.ms;
        e.n += 1;
        if (!t.ok)
            e.fail += 1;
        m.set(t.stage, e);
    }
    return [...m].map(([k, e]) => `${k} ${e.ms}ms${e.n > 1 ? `×${e.n}` : ''}${e.fail ? ` (실패 ${e.fail})` : ''}`).join(', ');
}
