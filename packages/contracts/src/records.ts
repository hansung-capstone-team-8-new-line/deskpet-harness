import { z } from 'zod';
import {
  ActionName,
  ExternalRef,
  Id,
  OffsetTimestamp,
  Revision,
  Target,
  UtcTimestamp,
} from './common.js';

/**
 * 결과·확인·작업 기록.
 * 근거: message-contracts §Confirmation Record, §Operation Record and Recovery, §ActionResult and Error,
 *       guide-sensor §Expected Outcome, 다이어그램 ApprovalAndRecords.
 */

// ---------------------------------------------------------------- ErrorInfo
export const NextAction = z.enum(['none', 'bounded_read_retry', 'reconcile', 'user_input']);
export type NextAction = z.infer<typeof NextAction>;

/**
 * 오류 코드는 잠정값이다 ("코드명은 실제 반환값을 본 뒤 동결" — message-contracts).
 * interface-contracts §7 최소 집합 + Harness 내부 차단 사유(inference).
 */
export const ProvisionalErrorCode = z.enum([
  // interface-contracts §7
  'WIKI_SEARCH_FAILED',
  'MCP_AUTH_ERROR',
  'MCP_TOOL_UNAVAILABLE',
  'MCP_RESULT_UNKNOWN',
  'EUREKA_AUTH_ERROR',
  'EUREKA_NOT_FOUND',
  'EUREKA_CONFLICT',
  'EUREKA_TIMEOUT_RESULT_UNKNOWN',
  'OUTPUT_MODEL_ERROR',
  'CANCELLED',
  'DEADLINE_EXCEEDED',
  // inference: 정책 차단·입력 오류·일시 오류 분류
  'GITHUB_AUTH_ERROR',
  'GITHUB_NOT_FOUND',
  'GITHUB_RESULT_UNKNOWN',
  'GITHUB_TRANSIENT',
  'EUREKA_INPUT_INVALID',
  'EUREKA_SERVER_ERROR',
  'EUREKA_TRANSIENT',
  'POLICY_BLOCKED',
  'SHA_CHANGED',
  'CONFIRMATION_INVALID',
  'LOW_CONFIDENCE',
  'STORAGE_RESERVATION_FAILED',
  'GUIDE_ERROR',
  'SENSOR_ERROR',
  'INVALID_INPUT',
  'STALE_REVISION',
  'INTERNAL',
]);
export type ProvisionalErrorCode = z.infer<typeof ProvisionalErrorCode>;

export const ErrorInfo = z.object({
  stage: z.string().min(1),
  provisionalCode: ProvisionalErrorCode,
  message: z.string(),
  operationId: Id.optional(),
  attemptId: Id.optional(),
  nextAction: NextAction,
});
export type ErrorInfo = z.infer<typeof ErrorInfo>;

// ------------------------------------------------------------- ActionResult
export const ActionStatus = z.enum(['succeeded', 'failed', 'unknown', 'cancelled']);
export type ActionStatus = z.infer<typeof ActionStatus>;

export const DispatchState = z.enum(['not_sent', 'may_have_been_sent', 'sent']);
export type DispatchState = z.infer<typeof DispatchState>;

/**
 * 결과 계약. 실행 중 상태는 넣지 않는다 (OperationRecord가 담당).
 * confirmed succeeded에는 연결 가능한 외부 증거가 있어야 한다 → refine.
 */
export const ActionResult = z
  .object({
    operationId: Id,
    action: ActionName,
    target: Target,
    status: ActionStatus,
    dispatchState: DispatchState,
    facts: z.record(z.unknown()),
    externalRefs: z.array(ExternalRef),
    observedAt: UtcTimestamp,
    error: ErrorInfo.optional(),
  })
  .superRefine((r, ctx) => {
    const isWrite = ['submit_approval', 'complete_stage', 'register_item', 'postpone_item', 'complete_item'].includes(
      r.action,
    );
    if (isWrite && r.status === 'succeeded' && r.externalRefs.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'write succeeded requires linked external evidence' });
    }
    if (isWrite && r.status === 'succeeded' && r.dispatchState !== 'sent') {
      ctx.addIssue({ code: 'custom', message: 'write succeeded requires dispatchState=sent' });
    }
    if (r.status === 'unknown' && r.dispatchState === 'not_sent') {
      ctx.addIssue({ code: 'custom', message: 'unknown with not_sent is contradictory; use failed + not_sent' });
    }
  });
export type ActionResult = z.infer<typeof ActionResult>;

// ---------------------------------------------------------- ExpectedOutcome
/** 등록된 검사 규칙 참조. 임의 실행 코드가 아니다 (guide-sensor §Expected Outcome). */
export const CheckRuleRef = z.enum([
  'review.sections_version_consistent',
  'review.requested_sections_present',
  'approval.review_state_approved',
  'approval.commit_matches_expected_sha',
  'approval.linked_to_this_submission',
  'eureka.stage_status_done',
  'eureka.linked_to_this_change',
  'eureka.read_complete',
]);
export type CheckRuleRef = z.infer<typeof CheckRuleRef>;

export const EvidenceKind = z.enum([
  'review_id',
  'review_state',
  'review_commit_sha',
  'submission_response',
  'stage_status',
  'stage_completed_at',
  'change_response',
  'read_payload',
  'version_evidence',
]);

export const ExpectedOutcome = z.object({
  action: ActionName,
  target: Target,
  expectedVersion: z
    .object({ headSha: z.string().optional(), comparisonBase: z.string().optional(), externalVersion: z.string().optional() })
    .optional(),
  postconditions: z.array(CheckRuleRef),
  requiredEvidence: z.array(EvidenceKind),
  completenessRequirement: z.object({
    sections: z.array(z.string()).default([]),
    allowTruncation: z.boolean().default(false),
  }),
});
export type ExpectedOutcome = z.infer<typeof ExpectedOutcome>;

// ------------------------------------------------------------------ Pending
export const PendingKind = z.enum(['clarification', 'confirmation']);
export const PendingState = z.enum(['waiting', 'consumed', 'expired', 'revoked']);
export type PendingState = z.infer<typeof PendingState>;

export const QuestionDeliveryEvidence = z.object({
  deliveredAt: UtcTimestamp,
  /** retry_request: 사용자가 실패한 반영을 "다시 해줘"로 직접 요청함 — 그 요청을 동의로 본다 (D-23). 질문을 말하지 않았다 */
  channel: z.enum(['speech', 'display', 'web', 'retry_request']),
  sourceMessageId: Id,
  deliveredText: z.string().optional(),
});
export type QuestionDeliveryEvidence = z.infer<typeof QuestionDeliveryEvidence>;

/** 확인할 대상·행위·버전 또는 정확한 변경 내용. */
export const ConfirmationScope = z.object({
  action: ActionName,
  target: Target,
  headSha: z.string().optional(),
  exactChange: z.record(z.unknown()).optional(),
});
export type ConfirmationScope = z.infer<typeof ConfirmationScope>;

export const Pending = z.object({
  pendingId: Id,
  requestId: Id,
  conversationId: Id,
  contextId: Id,
  contextVersion: Revision,
  revision: Revision,
  kind: PendingKind,
  state: PendingState,
  purpose: z.string().min(1),
  requiredSlots: z.array(z.string()).default([]),
  scope: ConfirmationScope.optional(),
  outputId: Id,
  /** 실제 질문 전달 전에는 답변을 수락하지 않는다. */
  questionDeliveryEvidence: QuestionDeliveryEvidence.optional(),
  /** 질문 음성 재생 뒤 발화 시작 여부. 무응답 타이머만 멈추며 expiresAt을 연장하지 않는다. */
  speechStartedAt: UtcTimestamp.optional(),
  expiresAt: UtcTimestamp,
  closedReason: z.string().optional(),
});
export type Pending = z.infer<typeof Pending>;

// ------------------------------------------------------- ConfirmationRecord
export const ConfirmationVerdict = z.enum(['approved', 'rejected', 'unclear']);
export const ConfirmationState = z.enum(['waiting', 'approved', 'rejected', 'expired', 'revoked']);
export type ConfirmationState = z.infer<typeof ConfirmationState>;

export const ConfirmationRecord = z.object({
  confirmationId: Id,
  pendingId: Id,
  requestId: Id,
  conversationId: Id,
  revision: Revision,
  scope: ConfirmationScope,
  requiredQuestionMeaning: z.string().min(1),
  outputId: Id,
  deliveredContentAndChannelEvidence: QuestionDeliveryEvidence.optional(),
  answerTurnId: Id.optional(),
  currentInputAndConfidenceEvidence: z
    .object({
      inputChannel: z.enum(['voice', 'web']),
      sttConfidenceState: z.enum(['provided', 'unavailable', 'not_applicable']),
      sttConfidence: z.number().min(0).max(1).optional(),
      routeOverallConfidence: z.number().min(0).max(1).optional(),
    })
    .optional(),
  answerAndRationale: z.object({ rawText: z.string(), rationale: z.string() }).optional(),
  verdict: ConfirmationVerdict.optional(),
  state: ConfirmationState,
  expiresAt: UtcTimestamp,
  /** 하나의 확인은 하나의 operation에만 연결한다. */
  operationId: Id.optional(),
});
export type ConfirmationRecord = z.infer<typeof ConfirmationRecord>;

// ------------------------------------------------------------ AttemptRecord
export const AttemptRecord = z.object({
  attemptId: Id,
  dispatchState: DispatchState,
  /** not_sent는 "전송하지 않았다는 확실한 증거"가 있을 때만. */
  notSentProof: z.string().optional(),
  dispatchEvidence: z
    .object({ preparedAt: UtcTimestamp, mayHaveBeenSentAt: UtcTimestamp.optional(), sentAt: UtcTimestamp.optional() })
    .optional(),
  responseEvidence: z.record(z.unknown()).optional(),
  startedAt: UtcTimestamp,
});
export type AttemptRecord = z.infer<typeof AttemptRecord>;

// ---------------------------------------------------------- OperationRecord
export const OperationOwner = z.enum(['harness', 'pipeline_eureka_module']);
export const ExecutionPhase = z.enum(['prepared', 'dispatching', 'awaiting_response', 'response_received', 'stopped']);
export type ExecutionPhase = z.infer<typeof ExecutionPhase>;
export const AssessmentState = z.enum(['pending', 'assessed']);
export const RecoveryState = z.enum(['none', 'needed', 'running', 'blocked']);
export type RecoveryState = z.infer<typeof RecoveryState>;
export const FollowUpEligibility = z.enum(['eligible', 'blocked', 'unverified']);

export const ExecutionAuthority = z.object({
  holderId: Id,
  attemptId: Id,
  ownerRevision: Revision,
  kind: z.enum(['write', 'read', 'read_recovery_only']),
});
export type ExecutionAuthority = z.infer<typeof ExecutionAuthority>;

export const OperationRecord = z.object({
  owner: OperationOwner,
  operationId: Id,
  revision: Revision,
  requestId: Id,
  action: ActionName,
  target: Target,
  confirmationRef: Id.optional(),
  currentExecutionAuthority: ExecutionAuthority.optional(),
  attempts: z.array(AttemptRecord),
  executionPhase: ExecutionPhase,
  assessment: AssessmentState,
  recovery: RecoveryState,
  recoveryAttempts: z.number().int().nonnegative().default(0),
  followUp: z
    .object({
      eligibility: FollowUpEligibility,
      conditions: z.array(z.string()),
      evidence: z.record(z.unknown()),
      observedAt: UtcTimestamp,
    })
    .optional(),
  expectedOutcome: ExpectedOutcome,
  checkRuleVersion: z.string().min(1),
  /** 실제 보낸 대상·행위·버전. 민감 인증정보 제외 */
  actualRequest: z.record(z.unknown()),
  priorEvidence: z.record(z.unknown()),
  /** 수락 시 예약한 복구 기록 공간 (바이트, 잠정) */
  reservedRecoveryBytes: z.number().int().nonnegative(),
  actionResult: ActionResult.optional(),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  /** 마지막 접근(LRU). 웹 조회는 갱신하지 않는다. */
  lastMeaningfulAccessAt: UtcTimestamp,
});
export type OperationRecord = z.infer<typeof OperationRecord>;

/** 종료·참조 해제된 기록만 축약한다. */
export const MinimumDedupRecord = z.object({
  operationId: Id,
  confirmationId: Id.optional(),
  target: Target,
  action: ActionName,
  shaOrChangeScope: z.string().optional(),
  result: ActionStatus,
  externalIds: z.array(z.string()),
  keyTimestamps: z.object({ createdAt: UtcTimestamp, completedAt: UtcTimestamp }),
});
export type MinimumDedupRecord = z.infer<typeof MinimumDedupRecord>;

/** 리마인더 payload (inference, interface-contracts §9). dueAt은 실제 마감 일시·시간대 포함. */
export const ReminderPayload = z.object({
  description: z.string().min(1),
  dueAt: OffsetTimestamp,
  timezone: z.string().min(1),
  relatedIds: z.object({ itemId: Id, reminderKey: z.string().min(1) }),
});
export type ReminderPayload = z.infer<typeof ReminderPayload>;
