import { SNAPSHOT_SCOPE_ALL, type ConfirmationRecord, type OperationRecord, type OperationUpdated, type OutputContent, type OutputEvent, type Pending, type Snapshot, type Tombstone } from '@deskpet/contracts';

/**
 * 원본 → 투영 이벤트 변환 헬퍼.
 * Harness 저장소 변경(StoreChange 모양)과 파이프라인 출력 이벤트를 OperationUpdated/Tombstone으로 바꾼다.
 */
export interface StoreChangeLike {
  entityType: 'operation' | 'pending' | 'confirmation';
  entityId: string;
  revision: number;
  state: Record<string, unknown>;
  deleted?: boolean;
}

export function fromStoreChange(c: StoreChangeLike, epoch: number): OperationUpdated | Tombstone {
  if (c.deleted) return { kind: 'tombstone', source: 'harness', epoch, entityId: c.entityId, revision: c.revision };
  const related: Record<string, string> = {};
  if (typeof c.state['requestId'] === 'string') related['requestId'] = c.state['requestId'];
  return { kind: 'operation.updated', source: 'harness', epoch, entityType: c.entityType, entityId: c.entityId, revision: c.revision, currentState: c.state, relatedIds: related };
}

/**
 * Harness source 전체 스냅샷 (MVP: scope = source 전체).
 * 입력은 저장소의 readProjectionSnapshot()처럼 같은 시점에 함께 읽은 세 종류여야 한다.
 * 한 종류라도 빠지면 그 종류의 투영이 지워지므로 세 필드를 모두 요구한다.
 */
export interface HarnessSnapshotRecords {
  operations: OperationRecord[];
  pendings: Pending[];
  confirmations: ConfirmationRecord[];
}

export function snapshotFromHarness(r: HarnessSnapshotRecords, epoch: number, tombstones: Snapshot['tombstones'] = []): Snapshot {
  const state = (v: unknown) => v as Record<string, unknown>;
  return {
    source: 'harness',
    scope: SNAPSHOT_SCOPE_ALL,
    epoch,
    objectsWithRevisions: [
      ...r.operations.map((o) => ({ entityType: 'operation' as const, entityId: o.operationId, revision: o.revision, state: state(o) })),
      ...r.pendings.map((p) => ({ entityType: 'pending' as const, entityId: p.pendingId, revision: p.revision, state: state(p) })),
      ...r.confirmations.map((c) => ({ entityType: 'confirmation' as const, entityId: c.confirmationId, revision: c.revision, state: state(c) })),
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
  private states = new Map<string, { revision: number; requestId: string; text: string | null; channels: Record<string, string> }>();
  private seq = 0;

  constructor(
    private readonly epoch = 1,
    private readonly maxEntries = 500,
  ) {}

  toUpdate(e: OutputEvent): OperationUpdated | null {
    const cur = this.states.get(e.outputId) ?? { revision: 0, requestId: e.requestRefs.requestId, text: null, channels: {} };
    const next = { ...cur, channels: { ...cur.channels } };
    if (e.kind === 'content_ready') next.text = (e.content as OutputContent).text;
    if (e.kind === 'content_failed') next.channels['content'] = 'failed';
    if (e.kind === 'channel_started' || e.kind === 'channel_completed' || e.kind === 'channel_failed') {
      const prev = next.channels[e.channel];
      const to = e.kind.replace('channel_', '');
      // 끝난 채널을 진행 중으로 되돌리지 않는다
      if (!(to === 'started' && (prev === 'completed' || prev === 'failed'))) next.channels[e.channel] = to;
    }
    if (cur.revision > 0 && next.text === cur.text && sameChannels(next.channels, cur.channels)) return null;
    next.revision = ++this.seq;
    this.states.delete(e.outputId);
    this.states.set(e.outputId, next);
    while (this.states.size > this.maxEntries) this.states.delete(this.states.keys().next().value!);
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

  get size(): number {
    return this.states.size;
  }
}

function sameChannels(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}
