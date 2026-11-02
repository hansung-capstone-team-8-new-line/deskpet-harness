import { describe, expect, it } from 'vitest';
import { STATUS_LABEL, filterRows, operationStatus, toRows } from '@/lib/model';

const op = (id: string, state: Record<string, unknown>, revision = 1) => ({ entityType: 'operation' as const, entityId: id, revision, relatedIds: {}, state: { requestId: 'req-1', action: 'submit_approval', target: { kind: 'github_pr', repository: { owner: 'o', name: 'r' }, prNumber: 7 }, updatedAt: '2026-10-05T10:00:00.000Z', recovery: 'none', ...state } });

describe('웹 표시 모델', () => {
  it('원본 상태를 완료·실패·결과 불명·판정 대기·진행 중으로 옮긴다 (판정을 새로 만들지 않음)', () => {
    expect(operationStatus({ actionResult: { status: 'succeeded' } })).toBe('succeeded');
    expect(operationStatus({ actionResult: { status: 'failed' } })).toBe('failed');
    expect(operationStatus({ actionResult: { status: 'unknown' } })).toBe('unknown');
    expect(operationStatus({ actionResult: { status: 'cancelled' } })).toBe('cancelled');
    expect(operationStatus({ assessment: 'pending', executionPhase: 'response_received' })).toBe('pending_assessment');
    expect(operationStatus({ assessment: 'pending', executionPhase: 'dispatching' })).toBe('in_progress');
  });

  it('기다리는 질문만 확인 대기 행으로 보이고, 닫힌 질문은 목록에 넣지 않는다', () => {
    const rows = toRows([
      { entityType: 'pending', entityId: 'p-1', revision: 2, relatedIds: {}, state: { requestId: 'req-2', state: 'waiting', purpose: 'confirm_pr_approval', expiresAt: '2026-10-05T10:02:00.000Z', questionDeliveryEvidence: {} } },
      { entityType: 'pending', entityId: 'p-2', revision: 3, relatedIds: {}, state: { requestId: 'req-3', state: 'consumed', purpose: 'confirm_pr_approval', expiresAt: '2026-10-05T10:02:00.000Z' } },
      { entityType: 'confirmation', entityId: 'c-1', revision: 1, relatedIds: {}, state: {} },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'question', status: 'awaiting', title: 'PR 승인 확인 질문', note: '질문 전달됨' });
  });

  it('주의가 필요한 상태(확인 대기·결과 불명)가 먼저 오고, 결과 확인 필요 같은 보조 설명을 붙인다', () => {
    const rows = toRows([
      op('op-done', { actionResult: { status: 'succeeded' } }),
      op('op-unknown', { actionResult: { status: 'unknown', error: { provisionalCode: 'GITHUB_RESULT_UNKNOWN', message: 'timeout' } }, recovery: 'needed' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['op-unknown', 'op-done']);
    expect(rows[0]).toMatchObject({ title: 'PR 승인', target: 'o/r #7', note: '결과 확인 필요', errorMessage: 'GITHUB_RESULT_UNKNOWN timeout' });
  });

  it('상태 라벨은 모두 텍스트로 구분된다', () => {
    expect(new Set(Object.values(STATUS_LABEL)).size).toBe(Object.keys(STATUS_LABEL).length);
  });

  it('검색은 작업·대상·요청·상태 라벨에서, 필터는 상태별로', () => {
    const rows = toRows([op('op-a', { actionResult: { status: 'failed' } }), op('op-b', { requestId: 'req-zz', actionResult: { status: 'succeeded' } })]);
    expect(filterRows(rows, '실패', 'all').map((r) => r.id)).toEqual(['op-a']);
    expect(filterRows(rows, 'req-zz', 'all').map((r) => r.id)).toEqual(['op-b']);
    expect(filterRows(rows, '', 'succeeded').map((r) => r.id)).toEqual(['op-b']);
    expect(filterRows(rows, 'o/r', 'all')).toHaveLength(2);
  });
});
