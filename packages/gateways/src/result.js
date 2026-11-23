export function err(stage, code, message, nextAction, ids = {}) {
    return {
        stage,
        provisionalCode: code,
        message,
        nextAction,
        ...(ids.operationId ? { operationId: ids.operationId } : {}),
        ...(ids.attemptId ? { attemptId: ids.attemptId } : {}),
    };
}
export function gr(p) {
    return { externalRefs: [], successTextOnly: false, ...p };
}
/** 오류 본문은 JSON {"message"} 또는 평문 두 형식이 있다 (Eureka PDF §6). */
export function parseErrorBody(text) {
    try {
        const j = JSON.parse(text);
        if (j && typeof j === 'object' && 'message' in j && typeof j.message === 'string') {
            return j.message;
        }
        return text;
    }
    catch {
        return text;
    }
}
