import type { ProjectedObject } from '@deskpet/projector';

/**
 * 표시 모델 — 투영된 원본 상태를 그대로 옮긴다. 업무 판정을 새로 만들지 않는다 (Projector 규칙).
 * 상태는 색상만이 아니라 항상 텍스트 라벨로 표시한다.
 */
export type StatusKey = 'awaiting' | 'in_progress' | 'pending_assessment' | 'unknown' | 'failed' | 'succeeded' | 'cancelled';

export const STATUS_LABEL: Record<StatusKey, string> = {
  awaiting: '확인 대기',
  in_progress: '진행 중',
  pending_assessment: '판정 대기',
  unknown: '결과 불명',
  failed: '실패',
  succeeded: '완료',
  cancelled: '취소됨',
};

/** 필터·정렬 순서 (주의가 필요한 것 먼저) */
export const STATUS_ORDER: StatusKey[] = ['awaiting', 'unknown', 'pending_assessment', 'in_progress', 'failed', 'cancelled', 'succeeded'];

export const STATUS_HELP: Record<StatusKey, string> = {
  awaiting: '사용자의 확인 답변을 기다리고 있어요.',
  in_progress: '작업을 처리하고 있어요.',
  pending_assessment: '응답은 받았지만 결과 판정이 끝나지 않았어요. 다시 보내지 않고 기록으로 다시 판정해요.',
  unknown: '요청을 보냈을 수 있지만 결과를 확인하지 못했어요. 중복을 막기 위해 자동으로 다시 보내지 않아요.',
  failed: '작업이 실패했어요.',
  succeeded: '결과를 확인했고 성공했어요.',
  cancelled: '실행하지 않고 취소했어요.',
};

const ACTION_LABEL: Record<string, string> = {
  get_review_context: 'PR 조회',
  submit_approval: 'PR 승인',
  complete_stage: 'Eureka 단계 완료',
  get_approval_outcome: '승인 결과 조회',
  get_task_state: 'Eureka 업무 조회',
};
const PURPOSE_LABEL: Record<string, string> = {
  confirm_pr_approval: 'PR 승인 확인 질문',
  confirm_stage_completion: 'Eureka 단계 완료 확인 질문',
  identify_pr: '대상 PR 질문',
  select_pr_candidate: 'PR 후보 선택 질문',
  restate_write_command: '승인 명령 재확인 질문',
  clarify_request: '요청 내용 질문',
};
export const DISPATCH_LABEL: Record<string, string> = {
  sent: '전송됨',
  may_have_been_sent: '전송됐을 수 있음',
  not_sent: '전송 안 함',
};
export const RECOVERY_LABEL: Record<string, string> = {
  none: '없음',
  needed: '결과 확인 필요',
  running: '결과 확인 중',
  blocked: '자동 확인 중단 — 운영 확인 필요',
};

export interface Row {
  id: string;
  kind: 'operation' | 'question';
  status: StatusKey;
  title: string;
  target: string;
  requestId: string;
  /** 정렬·표시용 시각 */
  at: string;
  /** 상태 옆 보조 설명 (예: 결과 확인 필요) */
  note?: string;
  errorMessage?: string;
  state: Record<string, unknown>;
  revision: number;
}

type Target = { kind?: string; repository?: { owner?: string; name?: string }; prNumber?: number; itemId?: string; stageId?: string };

function targetText(t: unknown): string {
  const x = (t ?? {}) as Target;
  if (x.kind === 'github_pr') return `${x.repository?.owner}/${x.repository?.name} #${x.prNumber}`;
  if (x.kind === 'eureka_stage') return `Eureka ${x.itemId} / ${x.stageId}`;
  if (x.kind === 'eureka_item') return `Eureka ${x.itemId}`;
  return '-';
}

export function operationStatus(s: Record<string, unknown>): StatusKey {
  const ar = s['actionResult'] as { status?: string } | undefined;
  if (ar?.status === 'succeeded' || ar?.status === 'failed' || ar?.status === 'unknown' || ar?.status === 'cancelled') return ar.status;
  const phase = String(s['executionPhase'] ?? '');
  if (s['assessment'] === 'pending' && (phase === 'response_received' || phase === 'stopped')) return 'pending_assessment';
  return 'in_progress';
}

export function toRows(objects: ProjectedObject[]): Row[] {
  const rows: Row[] = [];
  for (const o of objects) {
    const s = o.state;
    if (o.entityType === 'operation') {
      const recovery = String(s['recovery'] ?? 'none');
      const ar = s['actionResult'] as { error?: { message?: string; provisionalCode?: string } } | undefined;
      rows.push({
        id: o.entityId,
        kind: 'operation',
        status: operationStatus(s),
        title: ACTION_LABEL[String(s['action'])] ?? String(s['action'] ?? '작업'),
        target: targetText(s['target']),
        requestId: String(s['requestId'] ?? ''),
        at: String(s['updatedAt'] ?? ''),
        ...(recovery !== 'none' ? { note: RECOVERY_LABEL[recovery] ?? recovery } : {}),
        ...(ar?.error ? { errorMessage: `${ar.error.provisionalCode ?? ''} ${ar.error.message ?? ''}`.trim() } : {}),
        state: s,
        revision: o.revision,
      });
    } else if (o.entityType === 'pending' && s['state'] === 'waiting') {
      const scope = s['scope'] as { target?: unknown } | undefined;
      rows.push({
        id: o.entityId,
        kind: 'question',
        status: 'awaiting',
        title: PURPOSE_LABEL[String(s['purpose'])] ?? String(s['purpose'] ?? '질문'),
        target: scope?.target ? targetText(scope.target) : '-',
        requestId: String(s['requestId'] ?? ''),
        at: String(s['expiresAt'] ?? ''),
        note: s['questionDeliveryEvidence'] ? '질문 전달됨' : '질문 전달 전',
        state: s,
        revision: o.revision,
      });
    }
  }
  return rows.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.at.localeCompare(a.at));
}

export function filterRows(rows: Row[], query: string, status: StatusKey | 'all'): Row[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (status === 'all' || r.status === status) &&
      (!q || [r.title, r.target, r.requestId, r.id, STATUS_LABEL[r.status], r.note ?? ''].some((v) => v.toLowerCase().includes(q))),
  );
}

export function formatTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '-';
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(t);
}
