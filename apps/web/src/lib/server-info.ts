/**
 * 서버가 보내는 세션 기록·서버 정보 (D-47, D-49). 서버 쪽 정의: packages/server/src/history.ts, scripts/updater.ts.
 * 화면은 받은 값을 보여 주기만 한다.
 */
export type HistoryStatus = 'succeeded' | 'failed' | 'question' | 'unknown' | 'cancelled' | 'rejected';

export interface HistoryEntry {
  id: string;
  at: string;
  sessionId: string;
  kind: string;
  requestId: string;
  conversationId?: string;
  input?: string;
  inputChannel?: string;
  sttConfidence?: number;
  route?: string;
  status: HistoryStatus;
  resultText?: string;
  actions?: { action: string; status: string }[];
  errorCode?: string;
  ms: number;
}

export type UpdateState = 'disabled' | 'idle' | 'checking' | 'up_to_date' | 'available' | 'check_failed' | 'updating' | 'restarting' | 'restart_required' | 'failed';

export interface UpdateStatus {
  state: UpdateState;
  canApply: boolean;
  current?: { commit: string; subject: string; branch: string };
  upstream?: string;
  behind?: number;
  ahead?: number;
  commits?: { sha: string; subject: string }[];
  checkedAt?: string;
  step?: string;
  message?: string;
  log?: string;
}

export interface ServerInfo {
  startedAt?: string;
  version?: { commit: string; subject: string; branch: string };
  update?: UpdateStatus;
  admin?: boolean;
  history?: { persistent: boolean } | null;
  supervised?: boolean;
  /** 웹에서 바꾸는 서버 설정 (D-52) */
  settings?: { allowedRepositories: string[]; source: 'file' | 'env'; persistent: boolean; updatedAt?: string };
}

export const HISTORY_STATUS_LABEL: Record<HistoryStatus, string> = {
  succeeded: '완료',
  failed: '실패',
  question: '질문함',
  unknown: '결과 불명',
  cancelled: '취소됨',
  rejected: '거부됨',
};

const KIND_LABEL: Record<string, string> = {
  'harness.request': '요청',
  'harness.resume': '답변',
  'harness.run': '요청',
  'eureka.execute': 'Eureka 요청',
};
export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export const ACTION_LABEL: Record<string, string> = {
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

export interface HistorySession {
  sessionId: string;
  entries: HistoryEntry[];
}

/** 최신 순 기록을 세션(서버 실행)별로 묶는다. 세션 순서도 최신 먼저 */
export function groupBySession(entries: HistoryEntry[]): HistorySession[] {
  const out: HistorySession[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.sessionId === e.sessionId) last.entries.push(e);
    else out.push({ sessionId: e.sessionId, entries: [e] });
  }
  return out;
}

export function filterHistory(entries: HistoryEntry[], query: string, status: HistoryStatus | 'all'): HistoryEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter(
    (e) =>
      (status === 'all' || e.status === status) &&
      (!q || [e.input ?? '', e.route ?? '', e.resultText ?? '', e.requestId, e.errorCode ?? '', HISTORY_STATUS_LABEL[e.status]].some((v) => v.toLowerCase().includes(q))),
  );
}

export function formatDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '-';
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
}

// ------------------------------------------------------------ 현황 (D-51)
export interface OverviewPr {
  owner: string;
  name: string;
  prNumber: number;
  url: string;
  stageName?: string;
  state?: 'open' | 'merged' | 'closed';
  title?: string;
  draft?: boolean;
}

export interface OverviewItem {
  itemId: string;
  name: string;
  state: string;
  description?: string;
  priority?: string;
  dueAt?: string;
  stages: { stageId: string; name: string; status: string; dueAt?: string }[];
  doneStages: number;
  currentStage?: string;
  prs: OverviewPr[];
}

export interface OpenPullRequest {
  number: number;
  title: string;
  author: string;
  url: string;
  draft: boolean;
  updatedAt?: string;
  reviewRequested: boolean;
}

export interface Overview {
  state: 'loading' | 'ok' | 'partial' | 'failed';
  observedAt?: string;
  items: OverviewItem[];
  autoFocusId?: string;
  reminders: { itemId: string; name: string; stageName?: string; dueAt: string; overdue: boolean; daysLeft: number }[];
  links: { eurekaWebUrl?: string; repos: { owner: string; name: string; url: string; openPrs?: OpenPullRequest[]; hasMore?: boolean; error?: string }[] };
  problems: string[];
  refreshing?: boolean;
}

export const STAGE_LABEL: Record<string, string> = { todo: '대기', doing: '진행 중', done: '완료', skip: '건너뜀', unknown: '알 수 없음' };
export const ITEM_STATE_LABEL: Record<string, string> = { todo: '시작 전', doing: '진행 중', done: '완료', hold: '보류' };
export const PR_STATE_LABEL: Record<string, string> = { open: '열림', merged: '병합됨', closed: '닫힘' };

/** 마감까지 남은 날: D-3, D-day, 2일 지남 */
export function dDay(dueAt: string, now = Date.now()): string {
  const due = new Date(dueAt);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(due) - start(new Date(now))) / 86_400_000);
  return days === 0 ? 'D-day' : days > 0 ? `D-${days}` : `${-days}일 지남`;
}

/** 웹에서 고른 업무가 아직 열려 있으면 그것, 아니면 서버가 자동으로 고른 업무 */
export function pickFocus(o: Overview, chosen?: string): OverviewItem | undefined {
  return o.items.find((i) => i.itemId === chosen) ?? o.items.find((i) => i.itemId === o.autoFocusId) ?? o.items[0];
}
