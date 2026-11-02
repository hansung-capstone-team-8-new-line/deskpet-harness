import { SNAPSHOT_SCOPE_ALL, type OperationUpdated, type ProjectionSource, type Snapshot, type SourceSyncState, type Tombstone } from '@deskpet/contracts';

/**
 * RequestStateProjector — 요청·작업·출력 이벤트를 웹 표시 상태로 변환한다. 실행을 지시하지 않는다.
 * 근거: message-contracts §Output and Projection, Liability §Output and Monitoring.
 *
 * - 이벤트 ID·revision으로 중복·역순을 거른다.
 * - 재연결: 구독 확보 → 유한 버퍼 수집 → 전체 스냅샷 적용 → 버퍼의 더 높은 revision만 적용.
 * - 버퍼 포화·epoch 변경이면 불완전 동기화로 표시하고 다시 시작해야 한다.
 * - tombstone revision을 epoch 안에서 유지해 낡은 이벤트가 삭제된 객체를 되살리지 않는다.
 * - 원본별 동기화 상태를 표시한다. 원본 간 원자적 스냅샷을 보장하지 않는다.
 */
export interface ProjectedObject {
  entityType: OperationUpdated['entityType'];
  entityId: string;
  revision: number;
  state: Record<string, unknown>;
  relatedIds: Record<string, string>;
}

interface SourceState {
  epoch: number | undefined;
  scope: string;
  sync: SourceSyncState['synchronizationState'];
  incompleteReason?: string;
  objects: Map<string, ProjectedObject>;
  tombstones: Map<string, number>;
  buffer: (OperationUpdated | Tombstone)[] | null;
}

export interface ProjectorOptions {
  bufferLimit?: number;
}

/**
 * - applied: 적용
 * - not_syncing: resync 중이 아님 (resync 없이 도착, 버퍼 포화·epoch 변경 후 늦게 도착). 다시 resync해야 한다
 * - unsupported_scope: source 전체가 아닌 범위. 일부만 담긴 스냅샷이 다른 객체를 지우지 않도록 거부한다
 * - stale_epoch: 현재보다 오래된 epoch. 상태를 되돌리지 않도록 거부하고 계속 기다린다
 */
export type SnapshotOutcome = 'applied' | 'not_syncing' | 'unsupported_scope' | 'stale_epoch';

export type ApplyOutcome = 'applied' | 'duplicate_or_stale' | 'tombstoned' | 'buffered' | 'epoch_mismatch' | 'buffer_overflow';

export class RequestStateProjector {
  private sources = new Map<ProjectionSource, SourceState>();
  private readonly bufferLimit: number;
  private listeners = new Set<() => void>();

  constructor(o: ProjectorOptions = {}) {
    this.bufferLimit = o.bufferLimit ?? 500;
  }

  apply(event: OperationUpdated | Tombstone): ApplyOutcome {
    const s = this.source(event.source);
    if (s.buffer) {
      if (s.buffer.length >= this.bufferLimit) {
        this.markIncomplete(s, 'buffer_overflow');
        return 'buffer_overflow';
      }
      s.buffer.push(event);
      return 'buffered';
    }
    if (s.epoch === undefined) s.epoch = event.epoch;
    if (event.epoch !== s.epoch) {
      this.markIncomplete(s, `epoch_changed:${s.epoch}->${event.epoch}`);
      return 'epoch_mismatch';
    }
    const r = this.applyOne(s, event);
    if (r === 'applied') this.notify();
    return r;
  }

  /** 재연결 시작: 이후 이벤트를 버퍼에 모은다. MVP 범위는 source 전체 */
  resync(source: ProjectionSource): void {
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
  applySnapshot(snap: Snapshot): SnapshotOutcome {
    const s = this.source(snap.source);
    if (!s.buffer) return 'not_syncing';
    if ((snap.scope as string) !== SNAPSHOT_SCOPE_ALL) {
      this.markIncomplete(s, `unsupported_scope:${String(snap.scope)}`);
      return 'unsupported_scope';
    }
    if (s.epoch !== undefined && snap.epoch < s.epoch) return 'stale_epoch';
    s.epoch = snap.epoch;
    s.scope = snap.scope;
    s.objects = new Map();
    s.tombstones = new Map(snap.tombstones.map((t) => [t.entityId, t.revision]));
    for (const o of snap.objectsWithRevisions) {
      if ((s.tombstones.get(o.entityId) ?? -1) >= o.revision) continue;
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

  syncStates(): SourceSyncState[] {
    return [...this.sources.entries()].map(([source, s]) => ({
      source,
      scope: s.scope,
      ...(s.epoch !== undefined ? { epoch: s.epoch } : {}),
      synchronizationState: s.sync,
      ...(s.incompleteReason ? { incompleteReason: s.incompleteReason } : {}),
    }));
  }

  objects(source?: ProjectionSource): ProjectedObject[] {
    const out: ProjectedObject[] = [];
    for (const [k, s] of this.sources) if (!source || k === source) out.push(...s.objects.values());
    return out;
  }

  /** 표시용 뷰 모델. 업무 판정을 소유하지 않는다: 원본 상태를 그대로 노출한다 */
  project(): ProjectedView {
    const ops = this.objects().filter((o) => o.entityType === 'operation');
    const outputs = this.objects().filter((o) => o.entityType === 'output');
    const pendings = this.objects().filter((o) => o.entityType === 'pending');
    return {
      sources: this.syncStates(),
      operations: ops.map((o) => {
        const st = o.state as Record<string, unknown>;
        const ar = st['actionResult'] as Record<string, unknown> | undefined;
        return {
          operationId: o.entityId,
          requestId: String(st['requestId'] ?? ''),
          action: String(st['action'] ?? ''),
          phase: String(st['executionPhase'] ?? ''),
          status: (ar?.['status'] as string | undefined) ?? 'in_progress',
          dispatchState: (ar?.['dispatchState'] as string | undefined) ?? 'unknown',
          recovery: String(st['recovery'] ?? 'none'),
          followUp: ((st['followUp'] as Record<string, unknown> | undefined)?.['eligibility'] as string | undefined) ?? null,
          revision: o.revision,
        };
      }),
      pendings: pendings.map((p) => ({ pendingId: p.entityId, state: String(p.state['state'] ?? ''), purpose: String(p.state['purpose'] ?? ''), revision: p.revision })),
      outputs: outputs.map((o) => ({ outputId: o.entityId, requestId: String(o.state['requestId'] ?? ''), text: (o.state['text'] as string | undefined) ?? null, channels: (o.state['channels'] as Record<string, string> | undefined) ?? {}, revision: o.revision })),
    };
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // ---------------------------------------------------------------- private
  private applyOne(s: SourceState, e: OperationUpdated | Tombstone): ApplyOutcome {
    const tomb = s.tombstones.get(e.entityId);
    if (e.kind === 'tombstone') {
      if (tomb !== undefined && tomb >= e.revision) return 'duplicate_or_stale';
      s.tombstones.set(e.entityId, e.revision);
      const cur = s.objects.get(e.entityId);
      if (cur && cur.revision <= e.revision) s.objects.delete(e.entityId);
      return 'applied';
    }
    if (tomb !== undefined && tomb >= e.revision) return 'tombstoned';
    const cur = s.objects.get(e.entityId);
    if (cur && cur.revision >= e.revision) return 'duplicate_or_stale';
    s.objects.set(e.entityId, { entityType: e.entityType, entityId: e.entityId, revision: e.revision, state: e.currentState, relatedIds: e.relatedIds });
    return 'applied';
  }

  private source(src: ProjectionSource): SourceState {
    let s = this.sources.get(src);
    if (!s) {
      s = { epoch: undefined, scope: 'all', sync: 'synced', objects: new Map(), tombstones: new Map(), buffer: null };
      this.sources.set(src, s);
    }
    return s;
  }

  private markIncomplete(s: SourceState, reason: string) {
    s.sync = 'incomplete';
    s.incompleteReason = reason;
    s.buffer = null;
    this.notify();
  }

  private notify() {
    for (const l of this.listeners) l();
  }
}

export interface ProjectedView {
  sources: SourceSyncState[];
  operations: { operationId: string; requestId: string; action: string; phase: string; status: string; dispatchState: string; recovery: string; followUp: string | null; revision: number }[];
  pendings: { pendingId: string; state: string; purpose: string; revision: number }[];
  outputs: { outputId: string; requestId: string; text: string | null; channels: Record<string, string>; revision: number }[];
}
