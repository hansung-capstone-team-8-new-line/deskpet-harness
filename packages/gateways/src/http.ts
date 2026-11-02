/**
 * 최소 HTTP 추상화. 전송 여부를 구분해 보고한다.
 *
 * - not_sent: 요청이 서버에 도달하지 않았음이 확실함 (DNS 실패, 연결 거부). 증거 문자열 필수.
 * - no_response: 요청을 보냈을 수 있으나 응답을 받지 못함 (timeout, 연결 끊김). 쓰기에서는 unknown.
 *
 * inference: fetch는 connect timeout과 전체 timeout을 분리할 수 없어 전체 timeout만 적용한다.
 *            connect 2s(interface-contracts §7)는 실제 transport 선택 시 구현한다.
 */
import { LimiterBusyError, type ConcurrencyLimiter } from '@deskpet/contracts';
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  bodyText: string;
}

export type HttpFailure = { kind: 'not_sent'; proof: string } | { kind: 'no_response'; detail: string };

export class HttpTransportError extends Error {
  constructor(readonly failure: HttpFailure) {
    super(failure.kind === 'not_sent' ? `not sent: ${failure.proof}` : `no response: ${failure.detail}`);
  }
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** fetch 기반 클라이언트. 헤더 값(인증키)은 오류 메시지에 포함하지 않는다. */
export class FetchHttpClient implements HttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly headers: () => Record<string, string>,
    private readonly fetchImpl: typeof fetch = fetch,
    /** 이 서비스 동시 호출 상한 (D-24). 자리를 기다린 시간만큼 요청 timeout에서 뺀다. 자리가 안 나면 보내지 않음(not_sent) */
    private readonly limiter?: ConcurrencyLimiter,
  ) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    if (!this.limiter) return this.send(req);
    const t0 = Date.now();
    try {
      return await this.limiter.run(() => this.send({ ...req, timeoutMs: Math.max(1, req.timeoutMs - (Date.now() - t0)) }), { waitMs: req.timeoutMs, ...(req.signal ? { signal: req.signal } : {}) });
    } catch (e) {
      if (e instanceof LimiterBusyError) throw new HttpTransportError({ kind: 'not_sent', proof: `limiter:${e.resource}:${e.reason}` });
      throw e;
    }
  }

  private async send(req: HttpRequest): Promise<HttpResponse> {
    const url = new URL(this.baseUrl.replace(/\/$/, '') + req.path);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const timeout = AbortSignal.timeout(req.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    try {
      const res = await this.fetchImpl(url, {
        method: req.method,
        headers: { ...this.headers(), ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal,
      });
      return { status: res.status, bodyText: await res.text() };
    } catch (e) {
      const code = errorCode(e);
      if (code && NOT_SENT_CODES.has(code)) throw new HttpTransportError({ kind: 'not_sent', proof: `transport:${code}` });
      if (req.signal?.aborted) throw new HttpTransportError({ kind: 'no_response', detail: 'aborted_by_caller' });
      throw new HttpTransportError({ kind: 'no_response', detail: code ?? (e instanceof Error ? e.name : 'unknown') });
    }
  }
}

function errorCode(e: unknown): string | undefined {
  const cause = (e as { cause?: { code?: unknown } })?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

/** 남은 deadline과 기본 timeout 중 작은 값. 하위 deadline은 상위 남은 시간을 넘지 않는다. */
export function boundedTimeout(defaultMs: number, deadlineAt: string, nowMs: number): number {
  return Math.max(0, Math.min(defaultMs, Date.parse(deadlineAt) - nowMs));
}
