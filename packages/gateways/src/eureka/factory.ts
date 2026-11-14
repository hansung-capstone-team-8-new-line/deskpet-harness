import type { ConcurrencyLimiter } from '@deskpet/contracts';
import { FetchHttpClient } from '../http.js';
import { EurekaGateway, type EurekaOperatorConfirm } from './EurekaGateway.js';

/** Eureka API 기본 주소. 다른 주소는 .env EUREKA_BASE_URL로 바꾼다 */
export const EUREKA_DEFAULT_BASE_URL = 'https://api.eureka.codes/flw-v1';

/**
 * 실제 REST 클라이언트 생성. 키는 env에서 읽고 메시지·로그에 남기지 않는다.
 * 사용자의 명시적 허락 전에는 테스트·스크립트에서 쓰기 호출을 하지 않는다.
 */
export function createEurekaRestGateway(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch, opts: { allowWrites?: boolean; operatorConfirm?: EurekaOperatorConfirm; limiter?: ConcurrencyLimiter } = {}): EurekaGateway {
  const key = env['EUREKA_API_KEY'];
  if (!key) throw new Error('EUREKA_API_KEY is not set (.env)');
  const baseUrl = env['EUREKA_BASE_URL']?.trim() || EUREKA_DEFAULT_BASE_URL;
  const http = new FetchHttpClient(baseUrl, () => ({ 'x-api-key': key }), fetchImpl, opts.limiter);
  // 단계 기록 작성자 (D-28). 웹은 로그인한 사람의 actorId를 보낸다. 없으면 보내지 않는다
  const noteActorId = env['EUREKA_NOTE_ACTOR_ID']?.trim();
  return new EurekaGateway({ http, now: () => Date.now(), totalTimeoutMs: 8_000, allowWrites: opts.allowWrites ?? false, ...(opts.operatorConfirm ? { operatorConfirm: opts.operatorConfirm } : {}), ...(noteActorId ? { noteActorId } : {}) });
}
