import { z } from 'zod';
import { Id, SourceRef } from './common.js';
import { ActionResult, ActionStatus, ErrorInfo, ReminderPayload } from './records.js';

/**
 * 출력 체인 계약.
 * 근거: message-contracts §Output and Projection, interface-contracts I-12/I-13/§4, 다이어그램 OutputAndProjectionContracts.
 */

export const OutputPurpose = z.enum(['result', 'question', 'progress', 'reminder']);
export type OutputPurpose = z.infer<typeof OutputPurpose>;

/** 지원 표현 범위는 하드웨어/UX 담당(박종하)이 확정한다. 잠정 enum. */
export const Emotion = z.enum(['neutral', 'cheerful', 'concerned', 'thinking', 'apologetic']);
export type Emotion = z.infer<typeof Emotion>;

export const OutputRequest = z
  .object({
    outputId: Id,
    requestRefs: z.object({ requestId: Id, conversationId: Id.optional(), operationIds: z.array(Id).default([]) }),
    purpose: OutputPurpose,
    actionResults: z.array(ActionResult),
    facts: z.record(z.unknown()),
    sources: z.array(SourceRef),
    /** 출력 체인이 바꿔서는 안 되는 필수 의미 (예: 확인 질문의 대상·행위·SHA) */
    requiredMeaning: z.array(z.string()),
    constraints: z.object({
      language: z.literal('ko-KR'),
      maxSpeechChars: z.number().int().positive(),
      allowedEmotions: z.array(Emotion),
    }),
    pendingId: Id.optional(),
    confirmationId: Id.optional(),
    reminder: ReminderPayload.optional(),
  })
  .superRefine((r, ctx) => {
    if (r.purpose === 'question' && !r.pendingId) {
      ctx.addIssue({ code: 'custom', message: 'question output requires pendingId' });
    }
    if (r.purpose === 'reminder' && !r.reminder) {
      ctx.addIssue({ code: 'custom', message: 'reminder output requires reminder payload' });
    }
    if (r.purpose !== 'reminder' && r.reminder) {
      ctx.addIssue({ code: 'custom', message: 'reminder payload only for reminder purpose' });
    }
  });
export type OutputRequest = z.infer<typeof OutputRequest>;

export const OutputContent = z.object({
  outputId: Id,
  text: z.string().min(1),
  displayText: z.string().min(1),
  emotion: Emotion,
  /** 업무 status는 일반 코드가 복사한다. 모델이 수정하지 않는다. */
  actionStatuses: z.array(z.object({ operationId: Id, status: ActionStatus })),
  validationResult: z.object({ passed: z.boolean(), failures: z.array(z.string()) }),
  fallbackUsed: z.boolean(),
  /** 출력 모델 호출에 걸린 시간(ms). 모델을 부르지 않았으면 없음 (NFR-01, D-26) */
  modelMs: z.number().nonnegative().optional(),
});
export type OutputContent = z.infer<typeof OutputContent>;

export const OutputChannel = z.enum(['speech', 'display', 'web', 'motion']);

export const OutputEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('content_ready'), outputId: Id, requestRefs: z.object({ requestId: Id }), content: OutputContent }),
  z.object({ kind: z.literal('content_failed'), outputId: Id, requestRefs: z.object({ requestId: Id }), error: ErrorInfo }),
  z.object({
    kind: z.enum(['channel_started', 'channel_completed', 'channel_failed']),
    outputId: Id,
    requestRefs: z.object({ requestId: Id }),
    channel: OutputChannel,
    deliveryEvidence: z.record(z.unknown()).optional(),
    error: ErrorInfo.optional(),
  }),
]);
export type OutputEvent = z.infer<typeof OutputEvent>;
