import type {
  ActionName,
  ActionResult,
  ConfirmationRecord,
  ExecutionAuthority,
  ExpectedOutcome,
  HarnessResult,
  MinimumDedupRecord,
  OperationRecord,
  Pending,
  QuestionDeliveryEvidence,
  Target,
  AckResult,
} from '@deskpet/contracts';

export type { AckResult, DurableAck } from '@deskpet/contracts';

/**
 * 저장 책임 port.
 * 근거: 다이어그램 «port» OperationStore, Liability §Durable Records, message-contracts §Write and Reconciliation.
 * inference: 메서드 시그니처 세부는 다이어그램의 "미정"을 구체화한 것.
 *
 * 불변식
 * - 답변 소비·확인 판정·operation 연결·실행 권한 확보는 하나의 원자적 commit이다.
 * - 같은 confirmation은 하나의 operation에만 연결한다.
 * - 진행 중·unknown·판정 대기·복구 중 기록과 유효 확인은 삭제하지 않는다.
 * - 복구 공간 예약 또는 필수 기록 저장이 실패하면 dispatch하지 않는다.
 */

export interface PrepareCommand {
  owner: OperationRecord['owner'];
  requestId: string;
  action: ActionName;
  target: Target;
  isWrite: boolean;
  confirmationRef?: string;
  expectedOutcome: ExpectedOutcome;
  checkRuleVersion: string;
  actualRequest: Record<string, unknown>;
  priorEvidence: Record<string, unknown>;
  holderId: string;
}

export type PrepareResult =
  | { ok: true; operation: OperationRecord; authority: ExecutionAuthority }
  | { ok: false; reason: 'confirmation_already_linked'; existing: OperationRecord }
  | { ok: false; reason: 'confirmation_invalid'; detail: string }
  | { ok: false; reason: 'capacity_exhausted'; detail: string }
  | { ok: false; reason: 'retry_not_allowed'; detail: string };

export interface AnswerCommand {
  pendingId: string;
  expectedPendingRevision: number;
  requestId: string;
  conversationId: string;
  answerTurnId: string;
  answeredAtMs: number;
  /** clarification 답변 수락 또는 confirmation 판정 */
  decision:
    | { kind: 'clarification_answer' }
    | {
        kind: 'confirmation';
        confirmationId: string;
        verdict: 'approved' | 'rejected' | 'unclear';
        evidence: NonNullable<ConfirmationRecord['currentInputAndConfidenceEvidence']>;
        rawText: string;
        rationale: string;
        /** approved일 때만: 같은 commit 안에서 operation을 준비하고 실행 권한을 확보한다 */
        prepare?: PrepareCommand;
      };
}

export type AnswerResult =
  | { ok: true; pending: Pending; confirmation?: ConfirmationRecord; prepared?: PrepareResult }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'stale_revision'
        | 'not_waiting'
        | 'question_not_delivered'
        | 'expired'
        | 'mismatch'
        | 'confirmation_not_found'
        | 'capacity_exhausted';
      pending?: Pending;
      confirmation?: ConfirmationRecord;
    };

export interface OperationEvidence {
  attemptId: string;
  phase?: OperationRecord['executionPhase'];
  attemptDispatchState?: 'sent' | 'may_have_been_sent' | 'not_sent';
  notSentProof?: string;
  responseEvidence?: Record<string, unknown>;
  assessment?: OperationRecord['assessment'];
  recovery?: OperationRecord['recovery'];
  actionResult?: ActionResult;
  followUp?: OperationRecord['followUp'];
  releaseAuthority?: boolean;
}

export interface StoreChange {
  entityType: 'operation' | 'pending' | 'confirmation';
  entityId: string;
  revision: number;
  state: Record<string, unknown>;
  deleted?: boolean;
}

export interface StoreUsage {
  usedBytes: number;
  reservedBytes: number;
  capacityBytes: number;
  protectedCount: number;
  compactedCount: number;
}

export interface ProjectionSnapshotRecords {
  operations: OperationRecord[];
  pendings: Pending[];
  confirmations: ConfirmationRecord[];
}

export interface OperationStore {
  // -- 파이프라인 문서 경계용 조회 (답변 연결)
  listWaitingPendingsByConversation(conversationId: string): Promise<Pending[]>;
  getConfirmationForPending(pendingId: string): Promise<ConfirmationRecord | undefined>;

  // -- operation 준비·전송 경계
  reserveAndPrepare(cmd: PrepareCommand): Promise<PrepareResult>;
  persistMayHaveBeenSent(authority: ExecutionAuthority & { operationId: string }): Promise<AckResult>;
  appendEvidence(operationId: string, evidence: OperationEvidence): Promise<OperationRecord>;
  /** 전송하지 않았음이 확실한 경우에만: 새 attempt로 조건부 1회 재시도 권한 */
  prepareRetryAttempt(operationId: string, expectedRevision: number, holderId: string): Promise<PrepareResult>;
  /** dispatch 전 취소: 실행 권한 회수. 전송 가능 경계를 지났으면 false */
  revokeBeforeDispatch(operationId: string, reason: string): Promise<{ revoked: boolean; operation?: OperationRecord }>;

  // -- 복구
  claimSingleRecovery(operationId: string, expectedRevision: number, holderId: string): Promise<ExecutionAuthority | null>;
  releaseRecovery(operationId: string, holderId: string, outcome: 'resolved' | 'still_unknown'): Promise<OperationRecord>;
  readRecoveryRecord(operationId: string): Promise<OperationRecord | undefined>;
  listRecoverable(): Promise<OperationRecord[]>;

  // -- pending·confirmation
  createPending(pending: Pending, confirmation?: ConfirmationRecord): Promise<void>;
  getPending(pendingId: string): Promise<Pending | undefined>;
  getConfirmation(confirmationId: string): Promise<ConfirmationRecord | undefined>;
  listWaitingPendings(requestId: string): Promise<Pending[]>;
  markQuestionDelivered(pendingId: string, outputId: string, evidence: QuestionDeliveryEvidence): Promise<Pending | undefined>;
  markSpeechStarted(pendingId: string, atIso: string): Promise<Pending | undefined>;
  closePending(pendingId: string, to: 'expired' | 'revoked' | 'consumed', reason: string): Promise<Pending | undefined>;
  atomicCommitAnswerAndClaim(cmd: AnswerCommand): Promise<AnswerResult>;

  // -- 조회
  getOperation(operationId: string): Promise<OperationRecord | undefined>;
  findOperationByConfirmation(confirmationId: string): Promise<OperationRecord | undefined>;
  listOperations(requestId?: string): Promise<OperationRecord[]>;
  getDedupRecord(operationId: string): Promise<MinimumDedupRecord | undefined>;
  /** 투영 스냅샷용: operation·pending·confirmation을 같은 시점에 한 번에 읽는다 (scope = source 전체) */
  readProjectionSnapshot(): Promise<ProjectionSnapshotRecords>;

  // -- 턴 중복·이벤트 순서
  getTurnResult(turnId: string): Promise<HarnessResult | undefined>;
  recordTurnResult(turnId: string, result: HarnessResult): Promise<void>;
  getLastPipelineRevision(requestId: string): Promise<number | undefined>;
  setLastPipelineRevision(requestId: string, revision: number): Promise<void>;

  // -- 보존 정책
  protectByStateAndReferences(): Promise<Set<string>>;
  evictEligibleLRU(neededBytes: number): Promise<number>;
  compactEligibleRecord(operationId: string): Promise<boolean>;
  usage(): Promise<StoreUsage>;

  subscribe(listener: (c: StoreChange) => void): () => void;
}
