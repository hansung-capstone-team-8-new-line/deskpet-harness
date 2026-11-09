/**
 * 정책 수치 자리값.
 * 모든 값은 **미정** — 문서가 "실측 후 설정"으로 남긴 항목이다 (Liability §Principles 6, message-contracts §Confirmation).
 * 출처가 있는 값만 주석에 출처를 단다.
 */
export interface PolicyConfig {
  policyVersion: string;
  checkRuleVersion: string;
  /** 승인 쓰기를 허용하는 최소 STT confidence. 미정 (inference 0.85) */
  minSttConfidenceForWrite: number;
  /** 승인 쓰기를 허용하는 최소 라우터 overallConfidence. 미정 (inference 0.8) — README C-05 */
  minRouteConfidenceForWrite: number;
  /** confirmation/pending 유효 기간(ms). 미정 (inference 2분) */
  confirmationTtlMs: number;
  /** clarification pending 유효 기간(ms). 미정 */
  clarificationTtlMs: number;
  /** Guide 반복 상한 */
  maxGuideSteps: number;
  /** 자동 복구 시도 상한. 도달 시 recovery=blocked (message-contracts §Operation Record) */
  maxRecoveryAttempts: number;
  /** 쓰기 1건당 예약하는 복구 기록 공간(bytes). 미정 */
  recoveryBudgetBytes: number;
  /** 저장소 용량 상한(bytes). 미정 */
  storeCapacityBytes: number;
  /** 종료 기록 최소 보존 기간(ms). 미정 */
  minRetentionMs: number;
  /** Eureka HTTP connect/total timeout (interface-contracts §7 제안값 2s/8s) */
  eurekaConnectTimeoutMs: number;
  eurekaTotalTimeoutMs: number;
  /** MCP 개별 도구 timeout (interface-contracts §7 제안값 30s) */
  githubToolTimeoutMs: number;
  /** LLM 보조 Guide 호출 시간 상한(ms). 미정 (실측: gemini-3.1-flash-lite 단계 제안 약 3초) */
  llmGuideTimeoutMs: number;
  /** Eureka 반영 동의 뒤 결과를 기다리는 시간(ms). 넘으면 '진행 중'으로 답하고 끝나면 알림 (D-23). 미정 */
  followUpReplyWaitMs: number;
  /**
   * 단계 완료가 성공하면 단계 기록(note)에 승인한 PR 주소를 남긴다 (D-28). 동의는 단계 완료 확인 질문에 함께 받는다.
   * 기본 false(라이브러리). 서버(scripts/server.ts)는 EUREKA_EVIDENCE_NOTE=off가 아니면 켠다
   */
  evidenceNote: boolean;
  /**
   * 라우터가 `llm`·`unclear` 같은 일반 의도로 보낸 요청을 LLM으로 한 번 더 보고 PR 리뷰·승인이면 규칙 경로로 보낸다 (D-29).
   * 승인은 여전히 확인 질문을 거친다. 기본 false(라이브러리). 서버는 DESKPET_INTENT_RECHECK=off가 아니면 켠다
   */
  intentRecheck: boolean;
  /**
   * PR CI 검사 처리 (D-30). 'skip'이면 리뷰·승인 전 확인에서 검사를 조회하지 않고 승인 조건에서도 뺀다.
   * GitHub Gateway의 checksPolicy와 같은 값으로 둔다. 기본 'enforce'(라이브러리). 서버는 DESKPET_PR_CHECKS=enforce가 아니면 skip
   */
  prChecks: 'enforce' | 'skip';
  /**
   * 승인할 수 있는 저장소 목록 `owner/name` (D-36, D-21 보안 보류분). 없거나 비면 제한 없음.
   * 목록 밖 저장소 PR은 리뷰(읽기)는 하지만 승인 질문을 만들지 않는다. 서버는 DESKPET_ALLOWED_REPOS로 정한다
   */
  allowedRepositories?: string[];
  /**
   * 승인 '요청' 단계의 입력 검사 (D-39, 2026-11-10). 'loose'면 STT·라우터 신뢰도로 막지 않고 확인 질문까지 간다
   * (질문이 대상을 다시 읽어 주고, 확인 답변 단계는 그대로 엄격). 'strict'면 예전처럼 신뢰도 미달 시 다시 말해 달라고 한다.
   * STT 정확도가 높아지면 strict로 되돌린다
   */
  approvalRequestInput: 'loose' | 'strict';
}

export const DEFAULT_POLICY: PolicyConfig = {
  policyVersion: 'policy-0.1',
  checkRuleVersion: 'rules-0.1',
  minSttConfidenceForWrite: 0.85,
  minRouteConfidenceForWrite: 0.53, // 2026-11-08 사용자 결정: 라우터 통합 신뢰도 0.53 이상이면 통과 (실증값으로 다시 조정)
  confirmationTtlMs: 2 * 60_000,
  clarificationTtlMs: 5 * 60_000,
  maxGuideSteps: 6,
  maxRecoveryAttempts: 3,
  recoveryBudgetBytes: 16_384,
  storeCapacityBytes: 4 * 1024 * 1024,
  minRetentionMs: 24 * 3600_000,
  eurekaConnectTimeoutMs: 2_000,
  eurekaTotalTimeoutMs: 8_000,
  githubToolTimeoutMs: 30_000,
  llmGuideTimeoutMs: 8_000,
  followUpReplyWaitMs: 3_000,
  evidenceNote: false,
  intentRecheck: false,
  prChecks: 'enforce',
  approvalRequestInput: 'loose',
};
