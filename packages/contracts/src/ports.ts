import type { GatewayResult } from './guideSensor.js';
import type { Repository } from './common.js';
import type { ReviewContext, ReviewQuery } from './review.js';
import type { StageNoteList, TaskList, TaskState } from './eureka.js';

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

export interface ChangeOutcomeQuery {
  operationId: string;
  itemId: string;
  stageId: string;
  priorStageStatus: string;
  dispatchedAt?: string;
}

export interface EurekaGatewayPort {
  listTasks(query: { onlyOpen?: boolean; limit?: number }, c: CallConstraints): Promise<ReadOutcome<TaskList>>;
  getTaskState(query: { itemId: string; stageId?: string }, c: CallConstraints): Promise<ReadOutcome<TaskState>>;
  completeStage(cmd: CompleteStageCommand, handle: DispatchHandle, c: CallConstraints): Promise<GatewayResult>;
  getChangeOutcome(q: ChangeOutcomeQuery, c: CallConstraints): Promise<GatewayResult>;
  /** 단계 기록(note) 조회. 복구 뒤 후속 질문 전에 기록의 PR 연결이 그대로인지 본다 (D-24). 없는 구현이면 이 확인을 건너뛴다 */
  listStageNotes?(query: { stageId: string; limit?: number }, c: CallConstraints): Promise<ReadOutcome<StageNoteList>>;
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
