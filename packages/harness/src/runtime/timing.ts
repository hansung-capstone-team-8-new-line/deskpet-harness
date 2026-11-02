import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

/**
 * 단계별 응답 시간 기록 (NFR-01, D-26). 요청 하나를 처리하는 동안 외부 호출(GitHub·Eureka·LLM·Wiki)이 걸린 시간을 모은다.
 *
 * - 의존성(port) 경계에서 잰다: Harness 코드 곳곳에 측정 코드를 넣지 않는다
 * - 요청마다 AsyncLocalStorage로 모으므로 동시에 여러 요청이 와도 섞이지 않는다
 * - port 안에서 자기 메서드를 다시 부르는 것은 따로 세지 않는다 (바깥 호출 하나 = 기록 하나)
 */
export interface TimingEntry {
  /** 예: github.getReviewContext, eureka.completeStage, llm.guide, wiki.search */
  stage: string;
  ms: number;
  ok: boolean;
}

const store = new AsyncLocalStorage<TimingEntry[]>();

export async function collectTimings<T>(fn: () => Promise<T>): Promise<{ value: T; timings: TimingEntry[]; totalMs: number }> {
  const timings: TimingEntry[] = [];
  const t0 = performance.now();
  const value = await store.run(timings, fn);
  return { value, timings, totalMs: Math.round(performance.now() - t0) };
}

/** 기록 중인 요청이 있으면 한 단계를 더한다 */
export function recordTiming(stage: string, ms: number, ok: boolean): void {
  store.getStore()?.push({ stage, ms: Math.round(ms), ok });
}

/** port 객체의 메서드 호출마다 시간을 잰다. 원래 객체에 직접 호출하므로 내부 호출은 세지 않는다 */
export function timedPort<T extends object>(port: T, prefix: string, rename?: Record<string, string>): T {
  return new Proxy(port, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function' || typeof prop !== 'string') return v;
      const stage = rename?.[prop] ?? `${prefix}.${prop}`;
      return (...args: unknown[]) => {
        const t0 = performance.now();
        let out: unknown;
        try {
          out = Reflect.apply(v as (...a: unknown[]) => unknown, target, args);
        } catch (e) {
          recordTiming(stage, performance.now() - t0, false);
          throw e;
        }
        if (out instanceof Promise) {
          return out.then(
            (r) => {
              recordTiming(stage, performance.now() - t0, true);
              return r;
            },
            (e: unknown) => {
              recordTiming(stage, performance.now() - t0, false);
              throw e;
            },
          );
        }
        recordTiming(stage, performance.now() - t0, true);
        return out;
      };
    },
  });
}

/** 같은 단계는 합쳐서 요약한다 (로그용): "github.getReviewContext 420ms×2, llm.guide 900ms" */
export function summarizeTimings(ts: TimingEntry[]): string {
  const m = new Map<string, { ms: number; n: number; fail: number }>();
  for (const t of ts) {
    const e = m.get(t.stage) ?? { ms: 0, n: 0, fail: 0 };
    e.ms += t.ms;
    e.n += 1;
    if (!t.ok) e.fail += 1;
    m.set(t.stage, e);
  }
  return [...m].map(([k, e]) => `${k} ${e.ms}ms${e.n > 1 ? `×${e.n}` : ''}${e.fail ? ` (실패 ${e.fail})` : ''}`).join(', ');
}
