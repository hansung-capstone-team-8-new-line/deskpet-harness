/**
 * 자원별 동시 호출 상한 (D-24). 서버 입구가 아니라 실제로 부족한 자원(LLM·GitHub·Eureka)마다 둔다.
 *
 * - 자리가 나면 바로 실행한다. 없으면 waitMs 동안만 순서대로 기다리고, 그래도 없으면 LimiterBusyError
 * - 대기열 길이에도 상한이 있다 (maxQueue). 넘으면 기다리지 않고 바로 거절한다
 * - 호출하는 쪽이 거절을 어떻게 처리할지 정한다: LLM은 규칙·고정 문구로, HTTP는 "보내지 않음(not_sent)"으로
 */
export class LimiterBusyError extends Error {
  constructor(
    readonly resource: string,
    readonly reason: 'wait_timeout' | 'queue_full' | 'aborted',
  ) {
    super(`${resource} limiter busy (${reason})`);
    this.name = 'LimiterBusyError';
  }
}

export interface LimiterStats {
  resource: string;
  max: number;
  active: number;
  queued: number;
  rejected: number;
}

export class ConcurrencyLimiter {
  private active = 0;
  private rejected = 0;
  private readonly queue: { resolve: () => void; timer?: ReturnType<typeof setTimeout> }[] = [];

  constructor(
    readonly resource: string,
    private readonly max: number,
    private readonly maxQueue = 32,
  ) {
    if (!(max >= 1)) throw new Error(`${resource}: max concurrency must be >= 1`);
  }

  async run<T>(fn: () => Promise<T>, o: { waitMs: number; signal?: AbortSignal }): Promise<T> {
    await this.acquire(o.waitMs, o.signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  stats(): LimiterStats {
    return { resource: this.resource, max: this.max, active: this.active, queued: this.queue.length, rejected: this.rejected };
  }

  private acquire(waitMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      this.rejected += 1;
      return Promise.reject(new LimiterBusyError(this.resource, 'aborted'));
    }
    if (this.active < this.max && this.queue.length === 0) {
      this.active += 1;
      return Promise.resolve();
    }
    if (waitMs <= 0 || this.queue.length >= this.maxQueue) {
      this.rejected += 1;
      return Promise.reject(new LimiterBusyError(this.resource, waitMs <= 0 ? 'wait_timeout' : 'queue_full'));
    }
    return new Promise<void>((resolve, reject) => {
      const entry: { resolve: () => void; timer?: ReturnType<typeof setTimeout> } = { resolve: () => undefined };
      const drop = (reason: 'wait_timeout' | 'aborted') => {
        const i = this.queue.indexOf(entry);
        if (i < 0) return;
        this.queue.splice(i, 1);
        this.rejected += 1;
        reject(new LimiterBusyError(this.resource, reason));
      };
      entry.resolve = () => {
        if (entry.timer) clearTimeout(entry.timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        if (entry.timer) clearTimeout(entry.timer);
        drop('aborted');
      };
      entry.timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        drop('wait_timeout');
      }, waitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  private release() {
    const next = this.queue.shift();
    if (next) next.resolve(); // 자리를 그대로 넘긴다 (active 유지)
    else this.active -= 1;
  }
}
