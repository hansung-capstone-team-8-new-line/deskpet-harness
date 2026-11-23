import { z } from 'zod';
import { Id, SourceRef } from './common.js';
import { ActionResult, ActionStatus, ErrorInfo, ReminderPayload } from './records.js';
/**
 * 출력 체인 계약.
 * 근거: message-contracts §Output and Projection, interface-contracts I-12/I-13/§4, 다이어그램 OutputAndProjectionContracts.
 */
export const OutputPurpose = z.enum(['result', 'question', 'progress', 'reminder']);
/**
 * 출력 감정 값. wiki deskpet-display-interface(김도헌 담당 출력 모델 → 화면): 출력 모델 값은 neutral·happy·sad만 쓴다.
 * 업무 결과는 감정이 아니라 actionStatus(succeeded·failed·unknown)로 따로 전달한다.
 */
export const Emotion = z.enum(['neutral', 'happy', 'sad']);
export const EMOTIONS = Emotion.options;
/** 모델이 다른 이름(cheerful·apologetic 등)을 내면 지원 값으로 정규화한다. 모르는 값은 neutral */
export function normalizeEmotion(v) {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (s === 'happy' || s === 'cheerful' || s === 'joy' || s === 'excited' || s === 'pleased')
        return 'happy';
    if (s === 'sad' || s === 'apologetic' || s === 'sorry' || s === 'disappointed')
        return 'sad';
    return 'neutral';
}
/** 화면에 보낼 업무 결과. 결과가 없거나 취소면 생략한다 (결과 없는데 unknown을 쓰지 않음) */
export const DisplayActionStatus = z.enum(['succeeded', 'failed', 'unknown']);
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
export const OutputContent = z.object({
    outputId: Id,
    text: z.string().min(1),
    displayText: z.string().min(1),
    emotion: Emotion,
    /** 업무 status는 일반 코드가 복사한다. 모델이 수정하지 않는다. */
    actionStatuses: z.array(z.object({ operationId: Id, status: ActionStatus })),
    /** 화면용 대표 업무 결과 (마지막 쓰기 작업). 실제 결과에서 복사한다. 조회만 했거나 결과가 없으면 생략 */
    actionStatus: DisplayActionStatus.optional(),
    validationResult: z.object({ passed: z.boolean(), failures: z.array(z.string()) }),
    fallbackUsed: z.boolean(),
    /** 출력 모델 호출에 걸린 시간(ms). 모델을 부르지 않았으면 없음 (NFR-01, D-26) */
    modelMs: z.number().nonnegative().optional(),
});
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
