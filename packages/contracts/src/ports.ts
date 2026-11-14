import type { GatewayResult } from './guideSensor.js';
import type { Repository } from './common.js';
import type { ReviewContext, ReviewQuery } from './review.js';
import type { StageNoteList, TaskList, TaskState } from './eureka.js';
import type { McpCallRequest, McpCallResult, McpToolDescriptor } from './mcp.js';

/**
 * 패키지 간 공유하는 port 타입 (TS 전용, 직렬화 대상 아님).
 * Harness는 이 타입에만 의존하고 Gateway 구현은 packages/gateways에 둔다.
 */

// ------------------------------------------------------------ dispatch
/** may_have_been_sent 영속 저장 성공의 증거. 단순 접수 응답이 아니다. */
export interface DurableAck {
  kind: 'may_have_been_sent';
  operationId: string;
  attemptId: string;
  ownerRevision: number;
  persistedAt: string;
}

export type AckResult =
  | { ok: true; ack: DurableAck }
  | { ok: false; reason: 'stale_authority' | 'not_found' | 'authority_revoked' | 'storage_error'; detail: string };

/** Gateway에 넘기는 전송 핸들. 실행 문맥이며 JSON으로 직렬화하지 않는다. */
export interface DispatchHandle {
  operationId: string;
  attemptId: string;
  ownerRevision: number;
  beforeDispatch(): Promise<AckResult>;
  signal?: AbortSignal;
}

export interface CallConstraints {
  deadlineAt: string;
  signal?: AbortSignal;
}

// --------------------------------------------------------- eureka port
export interface ReadOutcome<T> {
  ok: boolean;
  data?: T;
  result: GatewayResult;
}

export interface CompleteStageCommand {
  operationId: string;
  confirmationId: string;
  itemId: string;
  stageId: string;
  /** 승인 operation·외부 ID·승인 SHA와 최신 조건 조회 근거 */
  githubSuccessEvidence: { approvalOperationId: string; reviewId: string; approvedSha: string; followUpObservedAt: string };
  expectedChange: { status: 'done' };
}

/**
 * 단계 기록(note) 작성. POST /_api_/stages/{stageId}/note {content, actorId?} (PDF에 없음, 2026-11-01 웹 요청에서 확인).
 * 멱등키가 없다: 응답을 못 받으면 결과 미확인으로 두고 다시 보내지 않는다.
 */
export interface AddStageNoteCommand {
  operationId: string;
  stageId: string;
  content: string;
}

export interface ChangeOutcomeQuery {
  operationId: string;
  itemId: string;
  stageId: string;
  priorStageStatus: string;
  dispatchedAt?: string;
}

export interface EurekaGatewayPort {
  listTasks(query: { onlyOpen?: boolean; limit?: number }, c: CallConstraints): Promise<ReadOutcome<TaskList>>;
  getItem?(itemId: string, c: CallConstraints): Promise<ReadOutcome<import('./eureka.js').TaskSummary>>;
  getTaskState(query: { itemId: string; stageId?: string }, c: CallConstraints): Promise<ReadOutcome<TaskState>>;
  completeStage(cmd: CompleteStageCommand, handle: DispatchHandle, c: CallConstraints): Promise<GatewayResult>;
  getChangeOutcome(q: ChangeOutcomeQuery, c: CallConstraints): Promise<GatewayResult>;
  /** 단계 기록(note) 조회. 복구 뒤 후속 질문 전에 기록의 PR 연결이 그대로인지 본다 (D-24). 없는 구현이면 이 확인을 건너뛴다 */
  listStageNotes?(query: { stageId: string; limit?: number }, c: CallConstraints): Promise<ReadOutcome<StageNoteList>>;
  /** 단계 기록 작성 (완료 근거 PR 기록, D-28). 없는 구현이면 기록을 남기지 않는다 */
  addStageNote?(cmd: AddStageNoteCommand, handle: DispatchHandle, c: CallConstraints): Promise<GatewayResult>;
  /** 단계 편집 1건 (EurekaGateway.replaceStages와 동일 모양) */
  checkSession?(c: CallConstraints): Promise<ReadOutcome<{ sid: string; roles: string[] }>>;
  registerItem?(
    cmd: { processId: string; name: string; dueAtMs?: number; priority?: 'low' | 'normal' | 'high' | 'urgent' },
    handle: DispatchHandle,
    c: CallConstraints,
  ): Promise<GatewayResult>;
  postponeItem?(cmd: { itemId: string; dueAtMs: number }, handle: DispatchHandle, c: CallConstraints): Promise<GatewayResult>;
  completeItem?(cmd: { itemId: string; actorId?: string }, handle: DispatchHandle, c: CallConstraints): Promise<GatewayResult>;
  deleteItem?(cmd: { itemId: string }, handle: DispatchHandle, c: CallConstraints): Promise<GatewayResult>;
  setItemStatus?(cmd: { itemId: string; status: 'hold' | 'todo' | 'doing' }, handle: DispatchHandle, c: CallConstraints): Promise<GatewayResult>;
  updateItemField?(cmd: { itemId: string; field: 'priority' | 'name'; value: string }, handle: DispatchHandle, c: CallConstraints): Promise<GatewayResult>;
  setStageStatus?(cmd: { stageId: string; status: 'todo' | 'doing' | 'done' | 'skip' }, handle: DispatchHandle, c: CallConstraints): Promise<GatewayResult>;
  replaceStages?(
    cmd: {
      itemId: string;
      stages: {
        id?: string;
        name: string;
        actorId: string;
        toolId: string;
        dueAt: number;
        guideText: string;
        isRequired: boolean;
      }[];
    },
    handle: DispatchHandle,
    c: CallConstraints,
  ): Promise<GatewayResult>;
  deleteStage?(cmd: { itemId: string; stageId: string }, handle: DispatchHandle, c: CallConstraints): Promise<GatewayResult>;
  listProcesses?(c: CallConstraints): Promise<ReadOutcome<{ id: string; name: string }[]>>;
}

// --------------------------------------------------------- github port
export interface SubmitApprovalCommand {
  operationId: string;
  confirmationId: string;
  repository: Repository;
  prNumber: number;
  expectedHeadSha: string;
}

export interface ApprovalOutcomeQuery {
  operationId: string;
  repository: Repository;
  prNumber: number;
  expectedHeadSha: string;
  submitter?: string;
  dispatchedAt?: string;
  /** 제출 응답에서 확보한 review ID (있으면) */
  reviewId?: string;
  /** 제출 전에 이미 존재하던 리뷰 ID (이번 제출과 구분) */
  priorReviewIds: string[];
}

export interface GitHubReviewGatewayPort {
  getReviewContext(query: ReviewQuery, c: CallConstraints): Promise<ReviewContext>;
  submitApproval(cmd: SubmitApprovalCommand, handle: DispatchHandle, c: CallConstraints): Promise<GatewayResult>;
  getApprovalOutcome(q: ApprovalOutcomeQuery, c: CallConstraints): Promise<GatewayResult>;
}

// ------------------------------------------------------------ mcp port
/** 범용 MCP 클라이언트 포트. 다중 서버의 동적 도구 조회 및 자유 실행을 추상화한다. */
export interface McpClientPort {
  listServerIds(): string[];
  hasServer(mcpId: string): boolean;
  listTools(mcpId?: string, c?: CallConstraints): Promise<McpToolDescriptor[]>;
  callTool(req: McpCallRequest, c?: CallConstraints): Promise<McpCallResult>;
}

// ------------------------------------------------------ workspace & worktree
/** 헤드리스 바이브 코딩용 로컬 워크스페이스 읽기·수정·명령 실행 포트 */
export interface WorkspaceGatewayPort {
  readonly defaultRoot: string;
  findFiles(
    query: { pattern?: string; subdir?: string; maxResults?: number; workingDir?: string },
    c?: CallConstraints,
  ): Promise<{ ok: boolean; files: string[]; truncated: boolean; error?: string }>;
  searchCode(
    query: { query: string; subdir?: string; regex?: boolean; glob?: string; maxMatches?: number; workingDir?: string },
    c?: CallConstraints,
  ): Promise<{ ok: boolean; matches: string[]; truncated: boolean; error?: string }>;
  readFile(
    query: { path: string; startLine?: number; endLine?: number; workingDir?: string },
    c?: CallConstraints,
  ): Promise<{
    ok: boolean;
    path: string;
    content: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated: boolean;
    error?: string;
  }>;
  editFile(
    cmd: { path: string; target: string; replacement: string; replaceAll?: boolean; workingDir?: string },
    c?: CallConstraints,
  ): Promise<{ ok: boolean; path: string; replacements: number; snippet?: string; error?: string }>;
  writeFile(
    cmd: { path: string; content: string; overwrite?: boolean; workingDir?: string },
    c?: CallConstraints,
  ): Promise<{ ok: boolean; path: string; bytesWritten: number; error?: string }>;
  gitStatus(
    query?: { workingDir?: string },
    c?: CallConstraints,
  ): Promise<{ ok: boolean; isGitRepo: boolean; summary: string; changedFiles: string[]; error?: string }>;
  gitDiff(
    query?: { staged?: boolean; path?: string; workingDir?: string },
    c?: CallConstraints,
  ): Promise<{ ok: boolean; diff: string; truncated: boolean; error?: string }>;
  runCommand(
    cmd: { command: string; timeoutMs?: number; workingDir?: string },
    c?: CallConstraints,
  ): Promise<{
    ok: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    error?: string;
  }>;
}

export interface WorktreeHandle {
  readonly id: string;
  readonly requestId: string;
  readonly workerId: string;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly baseCommitSha: string;
}

export interface WorktreeMergeResult {
  readonly merged: boolean;
  readonly changedFiles: string[];
  readonly conflicts: string[];
  readonly error?: string;
}

/** Agent Swarm Worker별 git worktree 격리 및 병합 포트 */
export interface WorktreeIsolatorPort {
  createWorkerWorktree(requestId: string, workerId: string): Promise<WorktreeHandle | null>;
  mergeAndCleanup(handle: WorktreeHandle): Promise<WorktreeMergeResult>;
  cleanupWorktree(handle: WorktreeHandle): Promise<void>;
}
