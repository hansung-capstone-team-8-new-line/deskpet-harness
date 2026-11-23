import { SNAPSHOT_SCOPE_ALL } from '@deskpet/contracts';
export function fromStoreChange(c, epoch) {
    if (c.deleted)
        return { kind: 'tombstone', source: 'harness', epoch, entityId: c.entityId, revision: c.revision };
    const related = {};
    if (typeof c.state['requestId'] === 'string')
        related['requestId'] = c.state['requestId'];
    return { kind: 'operation.updated', source: 'harness', epoch, entityType: c.entityType, entityId: c.entityId, revision: c.revision, currentState: c.state, relatedIds: related };
}
export function snapshotFromHarness(r, epoch, tombstones = []) {
    const state = (v) => v;
    return {
        source: 'harness',
        scope: SNAPSHOT_SCOPE_ALL,
        epoch,
        objectsWithRevisions: [
            ...r.operations.map((o) => ({ entityType: 'operation', entityId: o.operationId, revision: o.revision, state: state(o) })),
            ...r.pendings.map((p) => ({ entityType: 'pending', entityId: p.pendingId, revision: p.revision, state: state(p) })),
            ...r.confirmations.map((c) => ({ entityType: 'confirmation', entityId: c.confirmationId, revision: c.revision, state: state(c) })),
        ],
        tombstones,
    };
}
/**
 * 출력 채널 상태 누적 (파이프라인 원본). 출력 실패는 업무 결과와 독립적으로 표시한다.
 *
 * 감사 F-07:
 * - 같은 내용의 이벤트가 다시 와도 새 revision을 만들지 않는다 (null 반환).
 * - 채널이 completed/failed로 끝난 뒤 늦게 도착한 started는 무시한다.
 * - revision은 피드 전체에서 단조 증가하는 번호라, 오래된 항목을 지운 뒤 같은 outputId가 다시 와도 투영에서 낡은 값으로 버려지지 않는다.
 * - 최근 maxEntries개 출력만 메모리에 둔다.
 */
export class OutputProjectionFeed {
    epoch;
    maxEntries;
    states = new Map();
    seq = 0;
    constructor(epoch = 1, maxEntries = 500) {
        this.epoch = epoch;
        this.maxEntries = maxEntries;
    }
    toUpdate(e) {
        const cur = this.states.get(e.outputId) ?? { revision: 0, requestId: e.requestRefs.requestId, text: null, channels: {} };
        const next = { ...cur, channels: { ...cur.channels } };
        if (e.kind === 'content_ready')
            next.text = e.content.text;
        if (e.kind === 'content_failed')
            next.channels['content'] = 'failed';
        if (e.kind === 'channel_started' || e.kind === 'channel_completed' || e.kind === 'channel_failed') {
            const prev = next.channels[e.channel];
            const to = e.kind.replace('channel_', '');
            // 끝난 채널을 진행 중으로 되돌리지 않는다
            if (!(to === 'started' && (prev === 'completed' || prev === 'failed')))
                next.channels[e.channel] = to;
        }
        if (cur.revision > 0 && next.text === cur.text && sameChannels(next.channels, cur.channels))
            return null;
        next.revision = ++this.seq;
        this.states.delete(e.outputId);
        this.states.set(e.outputId, next);
        while (this.states.size > this.maxEntries)
            this.states.delete(this.states.keys().next().value);
        return {
            kind: 'operation.updated',
            source: 'pipeline',
            epoch: this.epoch,
            entityType: 'output',
            entityId: e.outputId,
            revision: next.revision,
            currentState: { requestId: next.requestId, text: next.text, channels: next.channels },
            relatedIds: { requestId: next.requestId },
        };
    }
    get size() {
        return this.states.size;
    }
}
function sameChannels(a, b) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}
