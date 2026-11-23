/**
 * «port» LlmClient — 공급자 중립 LLM 호출 경계 (D-03 갱신: 외부 API 사용, 경로 미정).
 *
 * - OpenAI 직접 호출과 팀 원격 fallback API를 같은 인터페이스로 갈아 끼운다. 공급자 고유 타입(messages, response_format 등)은
 *   어댑터 안에만 둔다.
 * - LLM 호출은 외부 상태를 바꾸지 않는 읽기다. DispatchOwner·unknown 절차는 적용하지 않고 시간·횟수·토큰 상한과 실패 시
 *   규칙/고정 문구 fallback만 둔다 (guide-sensor: LLM 사용 시 토큰·호출 수·반복·deadline 유한 제한).
 * - 응답 JSON은 공급자가 스키마를 보장해도 호출 측이 zod로 다시 검증한다. LLM 출력은 제안일 뿐 실행 권한이 아니다.
 */
/** 어댑터 공통 오류. 공급자별 오류는 이 코드로 바꿔서 던진다 */
export class LlmError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'LlmError';
    }
}
