export const WIFI_STATE_LABEL = {
    connected: '연결됨',
    connecting: '연결 중',
    disconnected: '연결 안 됨',
    unavailable: '사용할 수 없음',
    unmanaged: '관리 안 함',
};
/** 업데이트할 저장소 목록: Harness + 함께 받는 저장소 중 뒤처진 것 (D-58) */
export function pendingUpdates(u) {
    return [
        ...(u.behind ? [{ name: 'harness', behind: u.behind, commits: u.commits ?? [], codeOnly: false }] : []),
        ...(u.repos ?? []).filter((r) => r.behind > 0).map((r) => ({ name: r.name, behind: r.behind, commits: r.commits, codeOnly: true })),
    ];
}
/** 설정의 '지금 새 버전 확인' 결과 문구 */
export function checkResultText(u) {
    if (!u)
        return '확인했어요.';
    if (u.state === 'check_failed')
        return `확인하지 못했어요: ${u.message ?? ''}`;
    const p = pendingUpdates(u);
    const failed = (u.repos ?? []).filter((r) => r.error).map((r) => `${r.name}(${r.error})`);
    const tailNote = failed.length ? ` 확인 못 한 저장소: ${failed.join(', ')}` : '';
    if (!p.length)
        return `지금 최신이에요.${tailNote}`;
    return `새 버전이 있어요 — ${p.map((x) => `${x.name} ${x.behind}개`).join(', ')}. 화면 위 알림의 '업데이트'를 누르세요.${tailNote}`;
}
export const HISTORY_STATUS_LABEL = {
    succeeded: '완료',
    failed: '실패',
    question: '질문함',
    unknown: '결과 불명',
    cancelled: '취소됨',
    rejected: '거부됨',
};
const KIND_LABEL = {
    'harness.request': '요청',
    'harness.resume': '답변',
    'harness.run': '요청',
    'eureka.execute': 'Eureka 요청',
};
export function kindLabel(kind) {
    return KIND_LABEL[kind] ?? kind;
}
export const ACTION_LABEL = {
    get_review_context: 'PR 조회',
    submit_approval: 'PR 승인',
    complete_stage: 'Eureka 단계 완료',
    get_approval_outcome: '승인 결과 조회',
    get_task_state: 'Eureka 업무 조회',
    register_item: 'Eureka 업무 등록',
    postpone_item: 'Eureka 마감 변경',
    complete_item: 'Eureka 업무 완료',
    delete_item: 'Eureka 업무 삭제',
    hold_item: 'Eureka 업무 보류',
    resume_item: 'Eureka 업무 재개',
    set_stage_status: 'Eureka 단계 상태 변경',
    set_item_priority: 'Eureka 우선순위 변경',
    rename_item: 'Eureka 업무 이름 변경',
    add_stage_note: 'Eureka 단계 기록',
};
/** 최신 순 기록을 세션(서버 실행)별로 묶는다. 세션 순서도 최신 먼저 */
export function groupBySession(entries) {
    const out = [];
    for (const e of entries) {
        const last = out[out.length - 1];
        if (last && last.sessionId === e.sessionId)
            last.entries.push(e);
        else
            out.push({ sessionId: e.sessionId, entries: [e] });
    }
    return out;
}
export function filterHistory(entries, query, status) {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => (status === 'all' || e.status === status) &&
        (!q || [e.input ?? '', e.route ?? '', e.resultText ?? '', e.requestId, e.errorCode ?? '', HISTORY_STATUS_LABEL[e.status]].some((v) => v.toLowerCase().includes(q))));
}
export function formatDateTime(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t))
        return '-';
    return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
}
export const STAGE_LABEL = { todo: '대기', doing: '진행 중', done: '완료', skip: '건너뜀', unknown: '알 수 없음' };
export const ITEM_STATE_LABEL = { todo: '시작 전', doing: '진행 중', done: '완료', hold: '보류' };
export const PR_STATE_LABEL = { open: '열림', merged: '병합됨', closed: '닫힘' };
/** 마감까지 남은 날: D-3, D-day, 2일 지남 */
export function dDay(dueAt, now = Date.now()) {
    const due = new Date(dueAt);
    const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((start(due) - start(new Date(now))) / 86_400_000);
    return days === 0 ? 'D-day' : days > 0 ? `D-${days}` : `${-days}일 지남`;
}
/** 웹에서 고른 업무가 아직 열려 있으면 그것, 아니면 서버가 자동으로 고른 업무 */
export function pickFocus(o, chosen) {
    return o.items.find((i) => i.itemId === chosen) ?? o.items.find((i) => i.itemId === o.autoFocusId) ?? o.items[0];
}
