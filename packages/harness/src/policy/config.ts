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
}

export const DEFAULT_POLICY: PolicyConfig = {
  policyVersion: 'policy-0.1',
  checkRuleVersion: 'rules-0.1',
  minSttConfidenceForWrite: 0.85,
  minRouteConfidenceForWrite: 0.8,
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
};
