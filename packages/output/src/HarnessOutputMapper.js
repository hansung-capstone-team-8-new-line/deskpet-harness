import { EMOTIONS, confirmationTokens } from '@deskpet/contracts';
const ALL_EMOTIONS = [...EMOTIONS];
export function mapHarnessResult(r, ctx = {}) {
    const isQuestion = r.disposition === 'awaiting_user' && !!r.pending;
    const outputId = isQuestion ? r.pending.outputId : (ctx.outputId ?? `out-${r.requestId}-${r.actionResults.length}`);
    return {
        outputId,
        requestRefs: {
            requestId: r.requestId,
            ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
            operationIds: r.actionResults.map((a) => a.operationId),
        },
        purpose: isQuestion ? 'question' : 'result',
        actionResults: r.actionResults,
        facts: { ...r.facts, disposition: r.disposition, processingErrors: r.processingErrors.map((e) => e.provisionalCode) },
        sources: r.sources,
        requiredMeaning: requiredMeaning(r),
        // 팀 문서 배경을 함께 말할 때는 조금 더 길게 허용한다
        constraints: { language: 'ko-KR', maxSpeechChars: ctx.maxSpeechChars ?? (r.facts['wiki'] ? 360 : 220), allowedEmotions: ctx.allowedEmotions ?? ALL_EMOTIONS },
        ...(isQuestion ? { pendingId: r.pending.pendingId } : {}),
        ...(isQuestion && r.pending.confirmationId ? { confirmationId: r.pending.confirmationId } : {}),
    };
}
/**
 * 출력 체인이 바꿔서는 안 되는 의미 토큰. 확인 질문은 코드가 만든 고정 범위 문구(저장소·PR·커밋·행위)를 글자 그대로 포함한다 (감사 F-02).
 * Harness도 같은 문구로 실제 전달 문장을 검사한다 (contracts/confirmation.ts).
 */
export function requiredMeaning(r) {
    const scope = r.facts['question']?.scope;
    if (r.disposition === 'awaiting_user' && scope)
        return confirmationTokens(scope);
    return [];
}
