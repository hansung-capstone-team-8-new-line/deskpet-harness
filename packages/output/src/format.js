/** 날짜·시간 표현. 리마인더는 실제 마감 날짜·시간·시간대를 전달하며 남은 시간으로 대체하지 않는다 (interface-contracts §9). */
export function formatKoreanDateTime(iso, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date(iso));
    const get = (t) => Number(parts.find((p) => p.type === t)?.value);
    const h = get('hour') % 24;
    const m = get('minute');
    const date = `${get('year')}년 ${get('month')}월 ${get('day')}일`;
    // 0시대는 '새벽 12시'가 어색하고 '자정'은 날짜가 헷갈리므로 '0시'로 읽는다
    if (h === 0)
        return `${date} 0시${m ? ` ${m}분` : ''}`;
    const period = h < 6 ? '새벽' : h < 12 ? '오전' : h < 18 ? '오후' : '밤';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${date} ${period} ${h12}시${m ? ` ${m}분` : ''}`;
}
export const short = (sha) => (sha ? sha.slice(0, 7) : '알 수 없음');
