import { SNAPSHOT_SCOPE_ALL } from '@deskpet/contracts';
export class RequestStateProjector {
    sources = new Map();
    bufferLimit;
    listeners = new Set();
    constructor(o = {}) {
        this.bufferLimit = o.bufferLimit ?? 500;
    }
    apply(event) {
        const s = this.source(event.source);
        if (s.buffer) {
            if (s.buffer.length >= this.bufferLimit) {
                this.markIncomplete(s, 'buffer_overflow');
                return 'buffer_overflow';
            }
            s.buffer.push(event);
            return 'buffered';
        }
        if (s.epoch === undefined)
            s.epoch = event.epoch;
        if (event.epoch !== s.epoch) {
            this.markIncomplete(s, `epoch_changed:${s.epoch}->${event.epoch}`);
            return 'epoch_mismatch';
        }
        const r = this.applyOne(s, event);
        if (r === 'applied')
            this.notify();
        return r;
    }
    /** 재연결 시작: 이후 이벤트를 버퍼에 모은다. MVP 범위는 source 전체 */
    resync(source) {
        const s = this.source(source);
        s.buffer = [];
        s.scope = SNAPSHOT_SCOPE_ALL;
        s.sync = 'syncing';
        delete s.incompleteReason;
    }
    /**
     * 전체 스냅샷 적용: source의 기존 투영을 모두 교체하고 버퍼의 더 높은 revision만 적용한다.
     * 스냅샷이 source의 모든 객체 종류를 같은 시점에 담는다는 전제다 (scope = source 전체).
     */
    applySnapshot(snap) {
        const s = this.source(snap.source);
        if (!s.buffer)
            return 'not_syncing';
        if (snap.scope !== SNAPSHOT_SCOPE_ALL) {
            this.markIncomplete(s, `unsupported_scope:${String(snap.scope)}`);
            return 'unsupported_scope';
        }
        if (s.epoch !== undefined && snap.epoch < s.epoch)
            return 'stale_epoch';
        s.epoch = snap.epoch;
        s.scope = snap.scope;
        s.objects = new Map();
        s.tombstones = new Map(snap.tombstones.map((t) => [t.entityId, t.revision]));
        for (const o of snap.objectsWithRevisions) {
            if ((s.tombstones.get(o.entityId) ?? -1) >= o.revision)
                continue;
            s.objects.set(o.entityId, { entityType: o.entityType, entityId: o.entityId, revision: o.revision, state: o.state, relatedIds: {} });
        }
        const buffered = s.buffer ?? [];
        s.buffer = null;
        s.sync = 'synced';
        for (const e of buffered) {
            if (e.epoch !== s.epoch) {
                this.markIncomplete(s, 'epoch_changed_during_resync');
                break;
            }
            this.applyOne(s, e);
        }
        this.notify();
        return 'applied';
    }
    syncStates() {
        return [...this.sources.entries()].map(([source, s]) => ({
            source,
            scope: s.scope,
            ...(s.epoch !== undefined ? { epoch: s.epoch } : {}),
            synchronizationState: s.sync,
            ...(s.incompleteReason ? { incompleteReason: s.incompleteReason } : {}),
        }));
    }
    objects(source) {
        const out = [];
        for (const [k, s] of this.sources)
            if (!source || k === source)
                out.push(...s.objects.values());
        return out;
    }
    /** 표시용 뷰 모델. 업무 판정을 소유하지 않는다: 원본 상태를 그대로 노출한다 */
    project() {
        const ops = this.objects().filter((o) => o.entityType === 'operation');
        const outputs = this.objects().filter((o) => o.entityType === 'output');
        const pendings = this.objects().filter((o) => o.entityType === 'pending');
        return {
            sources: this.syncStates(),
            operations: ops.map((o) => {
                const st = o.state;
                const ar = st['actionResult'];
                return {
                    operationId: o.entityId,
                    requestId: String(st['requestId'] ?? ''),
                    action: String(st['action'] ?? ''),
                    phase: String(st['executionPhase'] ?? ''),
                    status: ar?.['status'] ?? 'in_progress',
                    dispatchState: ar?.['dispatchState'] ?? 'unknown',
                    recovery: String(st['recovery'] ?? 'none'),
                    followUp: st['followUp']?.['eligibility'] ?? null,
                    revision: o.revision,
                };
            }),
            pendings: pendings.map((p) => ({ pendingId: p.entityId, state: String(p.state['state'] ?? ''), purpose: String(p.state['purpose'] ?? ''), revision: p.revision })),
            outputs: outputs.map((o) => ({ outputId: o.entityId, requestId: String(o.state['requestId'] ?? ''), text: o.state['text'] ?? null, channels: o.state['channels'] ?? {}, revision: o.revision })),
        };
    }
    subscribe(l) {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    }
    // ---------------------------------------------------------------- private
    applyOne(s, e) {
        const tomb = s.tombstones.get(e.entityId);
        if (e.kind === 'tombstone') {
            if (tomb !== undefined && tomb >= e.revision)
                return 'duplicate_or_stale';
            s.tombstones.set(e.entityId, e.revision);
            const cur = s.objects.get(e.entityId);
            if (cur && cur.revision <= e.revision)
                s.objects.delete(e.entityId);
            return 'applied';
        }
        if (tomb !== undefined && tomb >= e.revision)
            return 'tombstoned';
        const cur = s.objects.get(e.entityId);
        if (cur && cur.revision >= e.revision)
            return 'duplicate_or_stale';
        s.objects.set(e.entityId, { entityType: e.entityType, entityId: e.entityId, revision: e.revision, state: e.currentState, relatedIds: e.relatedIds });
        return 'applied';
    }
    source(src) {
        let s = this.sources.get(src);
        if (!s) {
            s = { epoch: undefined, scope: 'all', sync: 'synced', objects: new Map(), tombstones: new Map(), buffer: null };
            this.sources.set(src, s);
        }
        return s;
    }
    markIncomplete(s, reason) {
        s.sync = 'incomplete';
        s.incompleteReason = reason;
        s.buffer = null;
        this.notify();
    }
    notify() {
        for (const l of this.listeners)
            l();
    }
}
