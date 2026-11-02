import { z } from 'zod';
import { Id, Revision, SourceRef, Target, UtcTimestamp } from './common.js';
import { ActionResult, ConfirmationScope, ErrorInfo, PendingKind } from './records.js';

/**
 * Harness 경계 DTO.
 * 근거: message-contracts §Harness Boundary, §Pending Transitions, 다이어그램 RequestContracts.
 */

// ----------------------------------------------------------- RouteDecision
/**
 * 외부 계약 (손한솔 라우터). 상세 필드 미정 → interface-contracts §4 예시를 따른 stub.
 * STT confidence 대체 불가.
 */
export const HeadOutput = z.object({ value: z.unknown(), confidence: z.number().min(0).max(1) });
export const RouteDecision = z
  .object({
    headOutputs: z.record(HeadOutput),
    overallConfidence: z.number().min(0).max(1),
    missingRequiredSlots: z.array(z.string()),
    route: z.string().min(1),
    sourceTurnIds: z.array(Id),
  })
  .passthrough();
export type RouteDecision = z.infer<typeof RouteDecision>;

// -------------------------------------------------------- CurrentTurnInput
export const InputChannel = z.enum(['voice', 'web']);
export const SttConfidenceState = z.enum(['provided', 'unavailable', 'not_applicable']);

export const CurrentTurnInput = z
  .object({
    conversationId: Id,
    turnId: Id,
    rawText: z.string(),
    isFinal: z.boolean(),
    inputChannel: InputChannel,
    sttConfidenceState: SttConfidenceState,
    sttConfidence: z.number().min(0).max(1).optional(),
    routeDecision: RouteDecision,
  })
  .superRefine((t, ctx) => {
    if (t.sttConfidenceState === 'provided' && t.sttConfidence === undefined) {
      ctx.addIssue({ code: 'custom', message: 'sttConfidence required when state=provided' });
    }
    if (t.sttConfidenceState !== 'provided' && t.sttConfidence !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'sttConfidence must be absent unless state=provided' });
    }
    // web의 not_applicable은 음성 신뢰도 누락과 구분한다.
    if (t.inputChannel === 'web' && t.sttConfidenceState !== 'not_applicable') {
      ctx.addIssue({ code: 'custom', message: 'web input must use sttConfidenceState=not_applicable' });
    }
    if (t.inputChannel === 'voice' && t.sttConfidenceState === 'not_applicable') {
      ctx.addIssue({ code: 'custom', message: 'voice input cannot be not_applicable' });
    }
  });
export type CurrentTurnInput = z.infer<typeof CurrentTurnInput>;

// ----------------------------------------------------------- ContextPacket
/** 외부 계약 stub (파이프라인 선별). 현재 발화/RouteDecision은 중복하지 않는다. */
export const ContextTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  turnId: Id.optional(),
  outputId: Id.optional(),
});
export const TaskRef = z.object({
  itemId: Id,
  stageId: Id.optional(),
  repository: z.object({ owner: z.string(), name: z.string() }).optional(),
  prNumber: z.number().int().positive().optional(),
  source: SourceRef,
});
export type TaskRef = z.infer<typeof TaskRef>;

export const ContextPacket = z.object({
  contextId: Id,
  version: Revision,
  target: Target.optional(),
  candidates: z.array(Target).default([]),
  relatedTurns: z.array(ContextTurn).default([]),
  pendingRef: z.object({ pendingId: Id, revision: Revision }).optional(),
  taskRefs: z.array(TaskRef).default([]),
});
export type ContextPacket = z.infer<typeof ContextPacket>;

// ------------------------------------------------------------- Constraints
export const ExecutionConstraints = z.object({
  deadlineAt: UtcTimestamp,
  maxPages: z.number().int().positive().default(3),
  maxResultBytes: z.number().int().positive().default(256_000),
  allowedActions: z.array(z.string()).optional(),
  policyVersion: z.string().default('policy-0.1'),
  /** 파이프라인의 wikiSearchAllowed. false면 Wiki를 검색하지 않는다. 없으면 허용 (D-19) */
  wikiSearchAllowed: z.boolean().optional(),
});
export type ExecutionConstraints = z.infer<typeof ExecutionConstraints>;

// --------------------------------------------------------- HarnessRequest
export const HarnessRequest = z.object({
  requestId: Id,
  currentTurn: CurrentTurnInput,
  context: ContextPacket,
  constraints: ExecutionConstraints,
});
export type HarnessRequest = z.infer<typeof HarnessRequest>;

export const HarnessResumeRequest = z.object({
  originalRequestId: Id,
  currentTurn: CurrentTurnInput,
  context: ContextPacket,
  pendingId: Id,
  expectedPendingRevision: Revision,
  confirmationId: Id.optional(),
  newCallConstraints: ExecutionConstraints,
  /**
   * 파이프라인의 mutationApproved (pipeline 문서). false면 답변이 승인처럼 들려도 쓰기를 하지 않고 다시 묻는다.
   * 없으면(기존 경로) Harness 답변 해석만 쓴다.
   */
  externalApproval: z.boolean().optional(),
});
export type HarnessResumeRequest = z.infer<typeof HarnessResumeRequest>;

// ----------------------------------------------------------- HarnessResult
export const Disposition = z.enum(['completed', 'awaiting_user', 'failed', 'cancelled']);
export type Disposition = z.infer<typeof Disposition>;

export const PendingView = z.object({
  pendingId: Id,
  revision: Revision,
  kind: PendingKind,
  purpose: z.string(),
  requiredSlots: z.array(z.string()),
  scope: ConfirmationScope.optional(),
  confirmationId: Id.optional(),
  outputId: Id,
  expiresAt: UtcTimestamp,
});
export type PendingView = z.infer<typeof PendingView>;

export const HarnessResult = z.object({
  requestId: Id,
  disposition: Disposition,
  actionResults: z.array(ActionResult),
  pending: PendingView.optional(),
  facts: z.record(z.unknown()),
  sources: z.array(SourceRef),
  processingErrors: z.array(ErrorInfo),
});
export type HarnessResult = z.infer<typeof HarnessResult>;

/**
 * 요청이 끝난 뒤 확정된 결과 알림 (D-23). 서버가 파이프라인 연결에 notice로 보낸다.
 * - late_completion: 잠깐 기다리는 동안 끝나지 않았던 Eureka 반영이 끝남
 * - recovery: 결과 불명(unknown)·판정 대기 작업을 주기 확인으로 확정함 (다시 보내지 않음)
 */
export const FollowUpNotice = z.object({
  noticeId: Id,
  source: z.enum(['late_completion', 'recovery']),
  requestId: Id,
  operationId: Id,
  action: z.string(),
  status: z.string(),
  result: HarnessResult,
  observedAt: UtcTimestamp,
});
export type FollowUpNotice = z.infer<typeof FollowUpNotice>;

// ----------------------------------------------------------- PipelineEvent
export const PipelineEventKind = z.enum([
  'question_delivered',
  'speech_started',
  'question_wait_expired',
  'target_changed',
  'request_cancelled',
]);
export type PipelineEventKind = z.infer<typeof PipelineEventKind>;

export const PipelineEvent = z.object({
  messageId: Id,
  requestId: Id,
  pendingId: Id.optional(),
  outputId: Id.optional(),
  /** 같은 요청 내 순서. 누락 시 resume 실행을 차단한다 (inference: 단조 증가 정수). */
  sourceRevision: Revision,
  occurredAt: UtcTimestamp,
  kind: PipelineEventKind,
  channel: z.enum(['speech', 'display', 'web']).optional(),
  deliveredText: z.string().optional(),
});
export type PipelineEvent = z.infer<typeof PipelineEvent>;

// --------------------------------------------------------- HarnessCancel
/** 명시적 취소 요청. 연결 끊김은 취소가 아니다 (서비스 경계 규칙) */
export const HarnessCancel = z.object({ requestId: Id, reason: z.string().min(1).max(200) });
export type HarnessCancel = z.infer<typeof HarnessCancel>;

// --------------------------------------------------------- RecoveryRequest
/** inference: 원 호출 deadline 이후 읽기 복구 추적. */
export const RecoveryRequest = z.object({
  operationId: Id,
  systemRequestId: Id,
  deadlineAt: UtcTimestamp,
  finiteRecoveryLimits: z.object({ maxAttempts: z.number().int().positive() }),
  authority: z.literal('read_recovery_only'),
});
export type RecoveryRequest = z.infer<typeof RecoveryRequest>;
