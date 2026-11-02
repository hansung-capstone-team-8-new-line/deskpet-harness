import { z } from 'zod';
import { AllowedAction, ExternalRef, GitSha, Id, Repository, Revision, SourceRef, Target, UtcTimestamp } from './common.js';
import { CurrentTurnInput, ContextPacket } from './harness.js';
import {
  ActionStatus,
  ConfirmationRecord,
  DispatchState,
  ErrorInfo,
  ExpectedOutcome,
  OperationRecord,
  Pending,
} from './records.js';
import { Consistency, SectionKind } from './review.js';

/**
 * Guide / Sensor 계약.
 * 근거: guide-sensor §Guide Interface, §Sensor Interface, 다이어그램 DecisionContracts.
 */

// ------------------------------------------------------- typed arguments
export const ActionArgs = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('get_review_context'),
    repository: Repository,
    prNumber: z.number().int().positive(),
    requestedSections: z.array(SectionKind),
    expectedHeadSha: GitSha.optional(),
  }),
  z.object({
    action: z.literal('submit_approval'),
    repository: Repository,
    prNumber: z.number().int().positive(),
    expectedHeadSha: GitSha,
  }),
  z.object({ action: z.literal('get_approval_outcome'), operationId: Id }),
  z.object({ action: z.literal('list_tasks'), onlyOpen: z.boolean().default(true) }),
  z.object({ action: z.literal('get_task_state'), itemId: Id, stageId: Id.optional() }),
  z.object({ action: z.literal('complete_stage'), itemId: Id, stageId: Id, approvalOperationId: Id }),
  z.object({ action: z.literal('get_change_outcome'), operationId: Id }),
]);
export type ActionArgs = z.infer<typeof ActionArgs>;

// ------------------------------------------------------------ GuideInput
export const WikiEvidence = z.object({
  outcome: z.enum(['found', 'empty', 'failed', 'not_queried']),
  excerpts: z.array(z.object({ text: z.string(), source: SourceRef })).default([]),
});
export type WikiEvidence = z.infer<typeof WikiEvidence>;

export const GuideInput = z.object({
  requestId: Id,
  turnId: Id,
  stateRevision: Revision,
  goal: z.object({
    currentTurn: CurrentTurnInput,
    intent: z.string(),
    allowedScope: z.array(AllowedAction),
  }),
  context: z.object({ packet: ContextPacket, wiki: WikiEvidence, unverified: z.array(z.string()) }),
  operations: z.array(OperationRecord),
  pending: Pending.optional(),
  confirmations: z.array(ConfirmationRecord),
  observation: z.lazy(() => SensorAssessment).optional(),
  constraints: z.object({
    deadlineAt: UtcTimestamp,
    policyVersion: z.string(),
    maxSteps: z.number().int().positive(),
    wikiSearchAllowed: z.boolean().optional(),
  }),
  /** 구조화된 조회 facts (모델 요약으로 원 증거를 대체하지 않는다) */
  facts: z.record(z.unknown()).default({}),
});
export type GuideInput = z.infer<typeof GuideInput>;

// --------------------------------------------------------- GuideDecision
const decisionBase = {
  decisionId: Id,
  basedOnRevision: Revision,
  reasonRefs: z.array(z.string()),
  unknowns: z.array(z.string()),
};

export const ProposeActionPayload = z.object({
  action: AllowedAction,
  typedArguments: ActionArgs,
  target: Target,
  expectedVersion: z.object({ headSha: GitSha.optional() }).optional(),
  prerequisites: z.array(z.string()),
  /** 가이드 제안 기준. Harness가 행위별 고정 규칙으로 검증·보완한다. */
  expectedOutcome: ExpectedOutcome.optional(),
});
export const AskUserPayload = z.object({
  purpose: z.string(),
  questionKind: z.enum(['clarification', 'confirmation']),
  requiredSlots: z.array(z.string()).default([]),
  targetActionVersion: z
    .object({ action: z.enum(['submit_approval', 'complete_stage']), target: Target, headSha: GitSha.optional() })
    .optional(),
});
export const NeedContextPayload = z.object({ source: z.enum(['wiki', 'eureka', 'github']), searchScope: z.string() });
export const FinishPayload = z.object({ reason: z.string(), outputFactRefs: z.array(z.string()) });
export const BlockedPayload = z.object({
  unmetConditions: z.array(z.string()),
  unknownEvidence: z.array(z.string()),
  requiredUserOrSystemAction: z.enum(['user', 'system', 'none']),
});

export const GuideDecision = z.discriminatedUnion('kind', [
  z.object({ ...decisionBase, kind: z.literal('propose_action'), payload: ProposeActionPayload }),
  z.object({ ...decisionBase, kind: z.literal('ask_user'), payload: AskUserPayload }),
  z.object({ ...decisionBase, kind: z.literal('need_context'), payload: NeedContextPayload }),
  z.object({ ...decisionBase, kind: z.literal('finish'), payload: FinishPayload }),
  z.object({ ...decisionBase, kind: z.literal('blocked'), payload: BlockedPayload }),
]);
export type GuideDecision = z.infer<typeof GuideDecision>;

// ----------------------------------------------------------- SensorInput
export const GatewayResult = z.object({
  /** read는 조회, write는 외부 쓰기 */
  mode: z.enum(['read', 'write']),
  dispatchState: DispatchState,
  outcome: z.enum(['response', 'error', 'no_response']),
  response: z.record(z.unknown()).optional(),
  externalRefs: z.array(ExternalRef).default([]),
  respondedAt: UtcTimestamp.optional(),
  versionEvidence: z.object({ headSha: GitSha.optional(), source: z.string() }).optional(),
  consistency: Consistency.optional(),
  completeness: z.enum(['complete', 'partial', 'unknown']).optional(),
  error: ErrorInfo.optional(),
  /** dispatchState=not_sent일 때 전송하지 않았다는 확실한 증거 */
  notSentProof: z.string().optional(),
  /** MCP처럼 성공 문구만 반환한 경우 */
  successTextOnly: z.boolean().default(false),
});
export type GatewayResult = z.infer<typeof GatewayResult>;

export const SensorInput = z.object({
  requestId: Id,
  operationId: Id,
  attemptId: Id,
  executionRevision: Revision,
  expectedOutcome: ExpectedOutcome,
  actualRequest: z.record(z.unknown()),
  gatewayResult: GatewayResult,
  priorEvidence: z.record(z.unknown()),
  executionContext: z.object({ cancelled: z.boolean(), expired: z.boolean(), activeContextId: Id.optional() }),
});
export type SensorInput = z.infer<typeof SensorInput>;

// ------------------------------------------------------ SensorAssessment
export const CheckResult = z.enum(['pass', 'fail', 'unknown', 'not_applicable']);
export const SensorAssessment = z.object({
  assessmentId: Id,
  operationId: Id,
  attemptId: Id,
  basedOnRevision: Revision,
  verdict: z.enum(['confirmed_success', 'confirmed_failure', 'indeterminate', 'not_executed']),
  checks: z.array(z.object({ rule: z.string(), result: CheckResult, evidenceRef: z.string().optional() })),
  confirmedFacts: z.record(z.unknown()),
  externalRefs: z.array(ExternalRef),
  consistency: Consistency.optional(),
  completeness: z.enum(['complete', 'partial', 'unknown']).optional(),
  suggestedActionStatus: ActionStatus.optional(),
  followUpNeed: z.enum(['none', 'reconcile', 'refresh_context', 'user_input']),
  diagnostics: z.array(z.string()),
});
export type SensorAssessment = z.infer<typeof SensorAssessment>;
