import { LimiterBusyError, LlmError, type ConcurrencyLimiter, type LlmClient, type LlmRequest, type LlmResponse } from '@deskpet/contracts';
import type { OutputModel, OutputModelInput } from '@deskpet/output';

/**
 * 비용·폭주 방지. 공급자와 무관하게 적용한다.
 * - 분당 호출 수 상한 (초과 시 호출하지 않고 budget_exceeded → 호출 측은 규칙/고정 문구로 진행)
 * - 응답 토큰 상한 (요청값을 이 값 이하로 낮춘다)
 * 구체 수치는 실측 후 조정한다 (Liability Principles 6).
 */
export interface LlmGuardOptions {
  maxCallsPerMinute: number;
  maxOutputTokens: number;
  now?: () => number;
}

/** 같은 창을 Guide 호출과 출력 호출이 함께 쓴다 */
export class CallWindow {
  private calls: number[] = [];
  private readonly now: () => number;
  constructor(
    private readonly maxPerMinute: number,
    now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
  }
  take(): void {
    const t = this.now();
    this.calls = this.calls.filter((x) => t - x < 60_000);
    if (this.calls.length >= this.maxPerMinute) throw new LlmError('budget_exceeded', `more than ${this.maxPerMinute} LLM calls per minute`);
    this.calls.push(t);
  }
}

/**
 * LLM 동시 호출 상한 (D-24). Guide와 출력 모델이 같은 공급자를 쓰므로 한 limiter를 나눠 쓴다.
 * 자리가 짧은 시간(waitMs) 안에 나지 않으면 호출하지 않고 LlmError('busy') — 호출 쪽은 규칙·고정 문구로 대신한다.
 */
export interface LlmConcurrency {
  limiter: ConcurrencyLimiter;
  waitMs: number;
}

async function limited<T>(c: LlmConcurrency | undefined, fn: () => Promise<T>): Promise<T> {
  if (!c) return fn();
  try {
    return await c.limiter.run(fn, { waitMs: c.waitMs });
  } catch (e) {
    if (e instanceof LimiterBusyError) throw new LlmError('busy', e.message);
    throw e;
  }
}

export class GuardedLlmClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly window: CallWindow,
    private readonly maxOutputTokens: number,
    private readonly concurrency?: LlmConcurrency,
  ) {}
  get provider() {
    return this.inner.provider;
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    return limited(this.concurrency, async () => {
      this.window.take();
      return this.inner.complete({ ...req, maxOutputTokens: Math.min(req.maxOutputTokens, this.maxOutputTokens) });
    });
  }
}

export class GuardedOutputModel implements OutputModel {
  constructor(
    private readonly inner: OutputModel,
    private readonly window: CallWindow,
    private readonly concurrency?: LlmConcurrency,
  ) {}
  generate(input: OutputModelInput) {
    return limited(this.concurrency, async () => {
      this.window.take();
      return this.inner.generate(input);
    });
  }
}
