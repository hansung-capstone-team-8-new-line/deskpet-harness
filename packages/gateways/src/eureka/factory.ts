import type { ConcurrencyLimiter } from '@deskpet/contracts';
import { FetchHttpClient } from '../http.js';
import { EurekaGateway, type EurekaOperatorConfirm } from './EurekaGateway.js';

/** 개발 환경 기본 (PDF §1). 운영 flw-v1은 명시적으로 지정할 때만 사용한다. */
export const EUREKA_DEV_BASE_URL = 'https://api.eureka.codes/flw-d1';

/**
 * 실제 REST 클라이언트 생성. 키는 env에서 읽고 메시지·로그에 남기지 않는다.
 * 사용자의 명시적 허락 전에는 테스트·스크립트에서 쓰기 호출을 하지 않는다.
 */
export function createEurekaRestGateway(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch, opts: { allowWrites?: boolean; operatorConfirm?: EurekaOperatorConfirm; limiter?: ConcurrencyLimiter } = {}): EurekaGateway {
  const key = env['EUREKA_API_KEY'];
  if (!key) throw new Error('EUREKA_API_KEY is not set (.env)');
  const baseUrl = env['EUREKA_BASE_URL'] || EUREKA_DEV_BASE_URL;
  const http = new FetchHttpClient(baseUrl, () => ({ 'x-api-key': key }), fetchImpl, opts.limiter);
  return new EurekaGateway({ http, now: () => Date.now(), totalTimeoutMs: 8_000, allowWrites: opts.allowWrites ?? false, ...(opts.operatorConfirm ? { operatorConfirm: opts.operatorConfirm } : {}) });
}
