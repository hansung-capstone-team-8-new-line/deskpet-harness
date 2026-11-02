import { describe, expect, it } from 'vitest';
import type { OperationUpdated } from '@deskpet/contracts';
import { OutputProjectionFeed, RequestStateProjector, snapshotFromHarness } from '@deskpet/projector';

const upd = (id: string, revision: number, state: Record<string, unknown> = {}, epoch = 1): OperationUpdated => ({
  kind: 'operation.updated',
  source: 'harness',
  epoch,
  entityType: 'operation',
  entityId: id,
  revision,
  currentState: { requestId: 'req-1', action: 'submit_approval', ...state },
  relatedIds: {},
});

describe('RequestStateProjector', () => {
  it('drops duplicates and out-of-order revisions', () => {
    const p = new RequestStateProjector();
    expect(p.apply(upd('op-1', 2, { executionPhase: 'dispatching' }))).toBe('applied');
    expect(p.apply(upd('op-1', 1, { executionPhase: 'prepared' }))).toBe('duplicate_or_stale');
    expect(p.apply(upd('op-1', 2))).toBe('duplicate_or_stale');
    expect(p.project().operations[0]!.phase).toBe('dispatching');
  });

  it('tombstone prevents resurrection by late events', () => {
    const p = new RequestStateProjector();
    p.apply(upd('op-1', 3));
    p.apply({ kind: 'tombstone', source: 'harness', epoch: 1, entityId: 'op-1', revision: 4 });
    expect(p.apply(upd('op-1', 3))).toBe('tombstoned');
    expect(p.project().operations).toHaveLength(0);
  });

  it('resync: buffer → snapshot replaces scope → only higher buffered revisions applied', () => {
    const p = new RequestStateProjector();
    p.apply(upd('op-old', 1));
    p.resync('harness');
    expect(p.apply(upd('op-1', 5, { executionPhase: 'stopped' }))).toBe('buffered');
    expect(p.apply(upd('op-1', 3, { executionPhase: 'prepared' }))).toBe('buffered');
    p.applySnapshot({
      source: 'harness',
      scope: 'all',
      epoch: 1,
      objectsWithRevisions: [{ entityType: 'operation', entityId: 'op-1', revision: 4, state: { requestId: 'req-1', executionPhase: 'dispatching' } }],
      tombstones: [],
    });
    const v = p.project();
    expect(v.operations.map((o) => o.operationId)).toEqual(['op-1']); // op-old는 source 전체 교체로 제거
    expect(v.operations[0]!.phase).toBe('stopped');
    expect(v.sources[0]!.synchronizationState).toBe('synced');
  });

  it('epoch change marks the source incomplete instead of guessing', () => {
    const p = new RequestStateProjector();
    p.apply(upd('op-1', 1));
    expect(p.apply(upd('op-1', 1, {}, 2))).toBe('epoch_mismatch');
    expect(p.syncStates()[0]).toMatchObject({ synchronizationState: 'incomplete' });
  });

  it('buffer overflow marks incomplete and requires a new resync', () => {
    const p = new RequestStateProjector({ bufferLimit: 1 });
    p.resync('harness');
    p.apply(upd('a', 1));
    expect(p.apply(upd('b', 1))).toBe('buffer_overflow');
    expect(p.syncStates()[0]!.incompleteReason).toBe('buffer_overflow');
  });

  it('task result and output channel results are projected independently (S-10)', () => {
    const p = new RequestStateProjector();
    p.apply(upd('op-1', 3, { actionResult: { status: 'succeeded', dispatchState: 'sent' } }));
    const feed = new OutputProjectionFeed();
    p.apply(feed.toUpdate({ kind: 'channel_failed', outputId: 'out-1', requestRefs: { requestId: 'req-1' }, channel: 'speech' })!);
    p.apply(feed.toUpdate({ kind: 'channel_completed', outputId: 'out-1', requestRefs: { requestId: 'req-1' }, channel: 'display' })!);
    const v = p.project();
    expect(v.operations[0]!.status).toBe('succeeded');
    expect(v.outputs[0]!.channels).toEqual({ speech: 'failed', display: 'completed' });
  });

  describe('OutputProjectionFeed 메모리·중복 (감사 F-07)', () => {
    const ev = (outputId: string, kind: 'channel_started' | 'channel_completed' = 'channel_completed') => ({ kind, outputId, requestRefs: { requestId: 'req-1' }, channel: 'speech' as const });

    it('같은 이벤트가 다시 와도 revision을 늘리지 않는다', () => {
      const feed = new OutputProjectionFeed();
      expect(feed.toUpdate(ev('o-1'))).not.toBeNull();
      expect(feed.toUpdate(ev('o-1'))).toBeNull();
    });

    it('끝난 채널을 늦게 온 started로 되돌리지 않는다', () => {
      const feed = new OutputProjectionFeed();
      feed.toUpdate(ev('o-1'));
      expect(feed.toUpdate(ev('o-1', 'channel_started'))).toBeNull();
    });

    it('최근 출력만 들고 있고, 지운 뒤 다시 와도 revision은 계속 커진다', () => {
      const feed = new OutputProjectionFeed(1, 3);
      const first = feed.toUpdate(ev('o-0'))!;
      for (let i = 1; i <= 5; i++) feed.toUpdate(ev(`o-${i}`));
      expect(feed.size).toBe(3);
      const again = feed.toUpdate(ev('o-0'))!;
      expect(again.revision).toBeGreaterThan(first.revision);
    });
  });

  describe('snapshot scope = source 전체 (MVP)', () => {
    const pendingUpd = (id: string, revision: number): OperationUpdated => ({ ...upd(id, revision), entityType: 'pending', currentState: { state: 'waiting', purpose: 'confirm_pr_approval' } });

    it('Harness 스냅샷은 operation·pending·confirmation을 함께 담아 pending이 사라지지 않는다', () => {
      const p = new RequestStateProjector();
      p.apply(upd('op-1', 1));
      p.apply(pendingUpd('p-1', 1));
      p.resync('harness');
      const snap = snapshotFromHarness(
        {
          operations: [{ operationId: 'op-1', revision: 2, requestId: 'req-1', action: 'submit_approval' } as never],
          pendings: [{ pendingId: 'p-1', revision: 2, state: 'waiting', purpose: 'confirm_pr_approval' } as never],
          confirmations: [{ confirmationId: 'c-1', pendingId: 'p-1', revision: 1 } as never],
        },
        1,
      );
      expect(snap.scope).toBe('all');
      expect(p.applySnapshot(snap)).toBe('applied');
      const v = p.project();
      expect(v.operations.map((o) => o.revision)).toEqual([2]);
      expect(v.pendings).toEqual([{ pendingId: 'p-1', state: 'waiting', purpose: 'confirm_pr_approval', revision: 2 }]);
      expect(p.objects('harness').map((o) => o.entityType).sort()).toEqual(['confirmation', 'operation', 'pending']);
    });

    it('source 전체가 아닌 범위의 스냅샷은 거부하고 기존 투영을 지우지 않는다', () => {
      const p = new RequestStateProjector();
      p.apply(pendingUpd('p-1', 1));
      p.resync('harness');
      const partial = { source: 'harness', scope: 'operations', epoch: 1, objectsWithRevisions: [], tombstones: [] } as never;
      expect(p.applySnapshot(partial)).toBe('unsupported_scope');
      expect(p.project().pendings).toHaveLength(1);
      expect(p.syncStates()[0]).toMatchObject({ synchronizationState: 'incomplete', incompleteReason: 'unsupported_scope:operations' });
    });

    it('resync 없이 도착한 스냅샷은 적용하지 않는다', () => {
      const p = new RequestStateProjector();
      p.apply(upd('op-1', 3));
      expect(p.applySnapshot(snapshotFromHarness({ operations: [], pendings: [], confirmations: [] }, 1))).toBe('not_syncing');
      expect(p.project().operations).toHaveLength(1);
    });

    it('현재보다 오래된 epoch의 스냅샷은 거부하고 계속 동기화를 기다린다', () => {
      const p = new RequestStateProjector();
      p.apply(upd('op-1', 1, {}, 2));
      p.resync('harness');
      expect(p.applySnapshot(snapshotFromHarness({ operations: [], pendings: [], confirmations: [] }, 1))).toBe('stale_epoch');
      expect(p.project().operations).toHaveLength(1);
      expect(p.syncStates()[0]!.synchronizationState).toBe('syncing');
      expect(p.applySnapshot(snapshotFromHarness({ operations: [], pendings: [], confirmations: [] }, 2))).toBe('applied');
      expect(p.project().operations).toHaveLength(0);
    });

    it('버퍼 포화 뒤 늦게 온 스냅샷은 적용하지 않는다', () => {
      const p = new RequestStateProjector({ bufferLimit: 1 });
      p.resync('harness');
      p.apply(upd('a', 1));
      p.apply(upd('b', 1));
      expect(p.applySnapshot(snapshotFromHarness({ operations: [], pendings: [], confirmations: [] }, 1))).toBe('not_syncing');
    });
  });
});
