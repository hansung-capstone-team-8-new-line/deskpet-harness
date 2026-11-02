/**
 * «port» LlmClient — 공급자 중립 LLM 호출 경계 (D-03 갱신: 외부 API 사용, 경로 미정).
 *
 * - OpenAI 직접 호출과 팀 원격 fallback API를 같은 인터페이스로 갈아 끼운다. 공급자 고유 타입(messages, response_format 등)은
 *   어댑터 안에만 둔다.
 * - LLM 호출은 외부 상태를 바꾸지 않는 읽기다. DispatchOwner·unknown 절차는 적용하지 않고 시간·횟수·토큰 상한과 실패 시
 *   규칙/고정 문구 fallback만 둔다 (guide-sensor: LLM 사용 시 토큰·호출 수·반복·deadline 유한 제한).
 * - 응답 JSON은 공급자가 스키마를 보장해도 호출 측이 zod로 다시 검증한다. LLM 출력은 제안일 뿐 실행 권한이 아니다.
 */

export type LlmPurpose = 'guide' | 'output';

export type LlmErrorCode =
  | 'disabled'
  | 'timeout'
  | 'aborted'
  | 'auth'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'bad_request'
  | 'unavailable'
  | 'invalid_output'
  /** 동시 호출 상한에 걸려 짧게 기다려도 자리가 나지 않음 (D-24). 호출하지 않았다 */
  | 'busy';

/** 어댑터 공통 오류. 공급자별 오류는 이 코드로 바꿔서 던진다 */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmJsonSchema {
  /** a-z, A-Z, 0-9, _ */
  name: string;
  /** JSON Schema. strict 구조화 출력을 위해 모든 속성을 required로 두고 additionalProperties=false로 쓴다 */
  schema: Record<string, unknown>;
}

export interface LlmRequest {
  purpose: LlmPurpose;
  /** 시스템 지침 (프롬프트 버전 포함) */
  instructions: string;
  /** 사용자 입력: 호출 측이 최소화한 사실만 담는다. 외부 결과 원문 전체를 넣지 않는다 */
  input: string;
  /** 있으면 JSON 응답을 요구한다 */
  jsonSchema?: LlmJsonSchema;
  maxOutputTokens: number;
  deadlineAt: string;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  /** jsonSchema 요청이면 파싱된 값 (검증 전) */
  json?: unknown;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  /** 'openai' | 'remote' | 'scripted' 등. 기록·표시용 */
  readonly provider: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}
