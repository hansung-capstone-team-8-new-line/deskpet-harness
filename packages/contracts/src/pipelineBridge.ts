import { z } from 'zod';
import { Id, UtcTimestamp } from './common.js';

/**
 * 파이프라인(Swift, 손한솔) 문서에 맞춘 Harness·출력 경계 형식.
 *
 * 근거
 * - wiki/deskpet-pipeline/class-diagrams.md §4·§5 (기준 코드 84d52f9): HarnessAdapter.run(HarnessRequest) → HarnessResult,
 *   reconcile(ActionRequest) → ActionResult, OutputModel.generate(OutputRequest) → String
 * - wiki/deskpet-interface-contracts.md §4·§6·§7: Transcript, RouteDecision, ActionResult 예시, 결과 상태 값
 *
 * 문서에 없는 부분(JSON 인코딩, 대상 형식, 질문 전달 보고, 상관 ID)은 현재 Harness 구현을 따른다. docs/pipeline-bridge.md 참고.
 * Swift 쪽 wire schema(docs/interface-map.md)가 정해지면 이 파일을 맞춘다. 알 수 없는 필드는 버리지 않고 통과시킨다.
 */

/** 문서 §7 결과 상태 + needs_clarification. 확인 질문도 needs_clarification으로 보낸다 (facts.questionKind로 구분) */
export const PipelineActionStatus = z.enum(['succeeded', 'failed', 'needs_clarification', 'unknown', 'cancelled']);
export type PipelineActionStatus = z.infer<typeof PipelineActionStatus>;

export const PipelineTranscript = z
  .object({
    text: z.string(),
    isFinal: z.boolean(),
    /** 없으면 STT 신뢰도 미제공(unavailable)으로 본다 */
    sttConfidence: z.number().min(0).max(1).optional(),
  })
  .passthrough();
export type PipelineTranscript = z.infer<typeof PipelineTranscript>;

export const PipelineHead = z.object({ value: z.unknown(), confidence: z.number().min(0).max(1) }).passthrough();

export const PipelineRouteDecision = z
  .object({
    /** intention, target, name, dueAt, priority, task, note — 각 {value, confidence} */
    headOutputs: z.record(PipelineHead),
    overallConfidence: z.number().min(0).max(1),
    missingRequiredSlots: z.array(z.string()).default([]),
    route: z.string().min(1),
    /** 형식 미정. Harness Target 형식({kind:'github_pr', repository, prNumber} 등)이면 대상으로 쓴다 */
    resolvedTarget: z.unknown().optional(),
  })
  .passthrough();
export type PipelineRouteDecision = z.infer<typeof PipelineRouteDecision>;

export const PipelineActionRequest = z
  .object({
    requestId: Id,
    operationId: Id,
    decision: PipelineRouteDecision,
    deadlineAt: UtcTimestamp,
  })
  .passthrough();
export type PipelineActionRequest = z.infer<typeof PipelineActionRequest>;

export const PipelineRouterInput = z
  .object({
    requestId: Id,
    turnId: Id,
    transcript: PipelineTranscript,
    /** ContextStamp. 형식 미정 — conversationId·contextId·version이 있으면 쓴다 */
    stamp: z.record(z.unknown()).default({}),
    turns: z.array(z.unknown()).default([]),
    activeTarget: z.unknown().optional(),
    /** 형식 미정. pendingId가 있으면 답변 연결에 쓴다 */
    pendingClarification: z.unknown().optional(),
  })
  .passthrough();
export type PipelineRouterInput = z.infer<typeof PipelineRouterInput>;

export const PipelineHarnessRequest = z
  .object({
    action: PipelineActionRequest,
    transcript: PipelineTranscript,
    context: PipelineRouterInput,
    wikiSearchAllowed: z.boolean().default(false),
    /** 기본 false. 라우터가 사용자의 승인 답변으로 판단했을 때만 true. Harness도 답변을 따로 검사한다 */
    mutationApproved: z.boolean().default(false),
    /** 문서에 없음(Harness 확장, 선택): 대화 ID. 없으면 stamp.conversationId → 기본 대화 */
    conversationId: Id.optional(),
  })
  .passthrough();
export type PipelineHarnessRequest = z.infer<typeof PipelineHarnessRequest>;

export const PipelineError = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    operationId: Id.optional(),
    stage: z.string().optional(),
  })
  .passthrough();
export type PipelineError = z.infer<typeof PipelineError>;

export const PipelineActionResult = z.object({
  operationId: Id,
  status: PipelineActionStatus,
  /** 문서: String dictionary. 상관 ID·사실은 모두 문자열로 담는다 */
  facts: z.record(z.string()),
  error: PipelineError.nullable().optional(),
});
export type PipelineActionResult = z.infer<typeof PipelineActionResult>;

export const PipelineHarnessResult = z.object({
  action: PipelineActionResult,
  question: z.string().nullable(),
  resultText: z.string().nullable(),
});
export type PipelineHarnessResult = z.infer<typeof PipelineHarnessResult>;

/** 출력 모델 입력 (class-diagrams §5). reminder 형식은 미정 → 현재 Harness 리마인더 형식이면 쓴다 */
export const PipelineOutputRequest = z
  .object({
    requestId: Id,
    outputId: Id,
    action: PipelineActionResult.nullable().optional(),
    reminder: z.unknown().optional(),
    /** 반드시 남길 기준 문장. Harness 결과의 question/resultText를 그대로 넣는다 */
    requiredText: z.string(),
    isQuestion: z.boolean(),
  })
  .passthrough();
export type PipelineOutputRequest = z.infer<typeof PipelineOutputRequest>;

export const PipelineOutputText = z.object({ text: z.string() });
export type PipelineOutputText = z.infer<typeof PipelineOutputText>;

/** facts 키 (Harness → 파이프라인). 파이프라인은 질문 전달 보고(pipeline.event)에 pendingId·outputId를 그대로 쓴다 */
export const BRIDGE_FACT_KEYS = {
  harnessRequestId: 'harnessRequestId',
  disposition: 'disposition',
  harnessOperationId: 'harnessOperationId',
  action: 'action',
  dispatchState: 'dispatchState',
  questionKind: 'questionKind',
  questionPurpose: 'questionPurpose',
  pendingId: 'pendingId',
  outputId: 'outputId',
  expiresAt: 'expiresAt',
  requiredMeaning: 'requiredMeaning',
} as const;

// ======================================================= EurekaAdapter (class-diagrams §4)
/**
 * EurekaAdapter.execute(ActionRequest) / reconcile(ActionRequest)의 입력. 문서의 ActionRequest와 같다.
 * mutationApproved는 문서에 없음(Harness 확장): 직접 경로 쓰기는 파이프라인이 사용자 확인을 받은 뒤 true로 보낸다.
 */
export const PipelineEurekaActionRequest = PipelineActionRequest.extend({ mutationApproved: z.boolean().default(false) });
export type PipelineEurekaActionRequest = z.infer<typeof PipelineEurekaActionRequest>;

/** reminders() / reminder(itemId) — 형식 미정. interface-contracts §9 리마인더 예시를 따른다 */
export const PipelineReminderItem = z.object({
  itemId: Id,
  /** itemId + dueAt. 같은 마감 알림 중복 방지용 */
  reminderKey: z.string().min(1),
  name: z.string(),
  /** 업무 설명. 없으면 리마인더 대상에서 뺀다 (업무명으로 대체하지 않음) */
  description: z.string().min(1),
  /** 시간대 오프셋 포함 (예: 2026-09-28T23:59:00+09:00) */
  dueAt: z.string(),
  timezone: z.string(),
  state: z.string(),
});
export type PipelineReminderItem = z.infer<typeof PipelineReminderItem>;

export const PipelineRemindersRequest = z.object({ requestId: Id }).passthrough();
export const PipelineReminderRequest = z.object({ requestId: Id, itemId: Id }).passthrough();
/** eureka.links (파이프라인 문서에 없음, P-19): 업무 단계 기록에서 연결된 PR을 찾는다. 결과는 PrLinkLookup */
export const PipelineLinksRequest = z.object({ requestId: Id, itemId: Id }).passthrough();
export const PipelineRemindersResult = z.object({
  items: z.array(PipelineReminderItem),
  /** 설명·마감이 없어 뺀 업무 수 (보고용) */
  skipped: z.number().int().nonnegative(),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  observedAt: UtcTimestamp,
});
export type PipelineRemindersResult = z.infer<typeof PipelineRemindersResult>;
