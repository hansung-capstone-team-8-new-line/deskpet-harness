import type {
  ConfirmationScope,
  FollowUpNotice,
  Pending,
  PendingView,
  PermissionRequest,
  PermissionResolution,
} from '@deskpet/contracts';

export interface QueuedPermissionEntry {
  readonly requestId: string;
  readonly workerId: string;
  readonly pending: PendingView;
  readonly questionText: string;
  readonly tokens: string[];
  readonly scope?: ConfirmationScope;
  readonly facts?: Record<string, unknown>;
  resolve(res: PermissionResolution): void;
}

export interface CreatePendingFn {
  (params: {
    requestId: string;
    kind: Pending['kind'];
    purpose: string;
    requiredSlots: string[];
    scope?: ConfirmationScope;
    questionText: string;
    tokens?: string[];
  }): Promise<PendingView>;
}

/**
 * Worker별 Pipeline 허가 큐 브릿지.
 *
 * - Swarm의 각 Worker는 중앙 소유자 없이 MCP 도구를 직접 실행한다.
 * - Guide의 `requiresPermission`에 해당하는 작업에 도달했을 때만 해당 Worker가 이 큐에 허가를 요청하고 일시 대기한다.
 * - 파이프라인 코드를 수정하지 않고 기존 1건 Pending(`awaiting_user`) 및 `FollowUpNotice` 경계를 재사용해
 *   다중 Worker의 허가 요청을 순서대로 직렬화하고, 사용자 응답(`resume`) 수신 시 해당 Worker만 재개한다.
 */
export class PipelinePermissionQueue {
  private readonly queues = new Map<string, QueuedPermissionEntry[]>();
  private readonly byPendingId = new Map<string, QueuedPermissionEntry>();
  private readonly waiters = new Map<string, (entry: QueuedPermissionEntry) => void>();

  constructor(
    private readonly createPending: CreatePendingFn,
    private readonly onFollowUp?: (notice: FollowUpNotice) => void,
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Worker가 사용자 허가/재질문 응답을 요청하고 응답이 도착할 때까지 대기한다.
   */
  async requestPermission(
    requestId: string,
    req: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionResolution> {
    if (signal?.aborted) {
      return {
        approved: false,
        verdict: 'revoked',
        answerText: '',
        turnId: '',
        rationale: 'request aborted before permission enqueue',
        resolvedAt: this.nowIso(),
      };
    }

    const defaultScope: ConfirmationScope | undefined =
      req.spec.kind === 'confirmation'
        ? req.spec.scope ?? {
            action: 'mcp_tool_call',
            target: { kind: 'mcp_tool', mcpId: req.mcpId, toolName: req.toolName },
            exactChange: {
              questionText: req.spec.questionText,
              ...(req.spec.tokens?.length ? { confirmationTokens: req.spec.tokens } : {}),
            },
          }
        : undefined;

    const pending = await this.createPending({
      requestId,
      kind: req.spec.kind,
      purpose: req.spec.purpose,
      requiredSlots: req.spec.requiredSlots ?? [],
      ...(defaultScope ? { scope: defaultScope } : {}),
      questionText: req.spec.questionText,
      ...(req.spec.tokens ? { tokens: req.spec.tokens } : {}),
    });

    return new Promise<PermissionResolution>((resolve) => {
      const entry: QueuedPermissionEntry = {
        requestId,
        workerId: req.workerId,
        pending,
        questionText: req.spec.questionText,
        tokens: req.spec.tokens ?? [],
        ...(defaultScope ? { scope: defaultScope } : {}),
        ...(req.spec.facts ? { facts: req.spec.facts } : {}),
        resolve: (res) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(res);
        },
      };

      const onAbort = () => {
        this.removeEntry(requestId, pending.pendingId);
        entry.resolve({
          approved: false,
          verdict: 'revoked',
          answerText: '',
          turnId: '',
          rationale: 'request aborted while waiting for user permission',
          resolvedAt: this.nowIso(),
        });
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const list = this.queues.get(requestId) ?? [];
      const wasEmpty = list.length === 0;
      list.push(entry);
      this.queues.set(requestId, list);
      this.byPendingId.set(pending.pendingId, entry);

      if (wasEmpty) {
        const wake = this.waiters.get(requestId);
        if (wake) {
          this.waiters.delete(requestId);
          wake(entry);
        }
      }
    });
  }

  /**
   * 현재 턴에서 노출 가능한 대기 중 허가 요청이 하나라도 생기거나 이미 있으면 반환한다.
   */
  peekFront(requestId: string): QueuedPermissionEntry | undefined {
    return this.queues.get(requestId)?.[0];
  }

  /**
   * Swarm 전체 작업 완료와 경쟁(Promise.race)시켜, Worker가 허가를 요청하는 순간 즉시
   * `awaiting_user` 응답을 파이프라인으로 반환할 수 있게 해주는 대기자.
   */
  waitForNextPermission(requestId: string): { promise: Promise<QueuedPermissionEntry>; cancel(): void } {
    const front = this.peekFront(requestId);
    if (front) {
      return { promise: Promise.resolve(front), cancel: () => undefined };
    }
    let settled = false;
    const promise = new Promise<QueuedPermissionEntry>((resolve) => {
      this.waiters.set(requestId, (entry) => {
        if (settled) return;
        settled = true;
        resolve(entry);
      });
    });
    return {
      promise,
      cancel: () => {
        settled = true;
        this.waiters.delete(requestId);
      },
    };
  }

  hasWaitingWorker(pendingId: string): boolean {
    return this.byPendingId.has(pendingId);
  }

  getEntry(pendingId: string): QueuedPermissionEntry | undefined {
    return this.byPendingId.get(pendingId);
  }

  /** unclear 답변 등으로 질문이 재발급될 때 대기 중인 Worker의 pendingId 매핑만 새 Pending으로 교체한다 */
  rebindPending(oldPendingId: string, newPending: PendingView): boolean {
    const entry = this.byPendingId.get(oldPendingId);
    if (!entry) return false;
    this.byPendingId.delete(oldPendingId);
    const updated: QueuedPermissionEntry = { ...entry, pending: newPending };
    const list = this.queues.get(entry.requestId);
    if (list) {
      const idx = list.findIndex((e) => e.pending.pendingId === oldPendingId);
      if (idx >= 0) list[idx] = updated;
    }
    this.byPendingId.set(newPending.pendingId, updated);
    return true;
  }

  /**
   * 파이프라인에서 `resume` 응답이 도착했을 때 대기 중인 해당 Worker를 깨운다.
   * 뒤에 대기 중인 다른 Worker 허가 요청이 있으면 front로 승격하고, 필요 시 notice로도 알린다.
   */
  resolvePending(pendingId: string, resolution: PermissionResolution): boolean {
    const entry = this.byPendingId.get(pendingId);
    if (!entry) return false;
    this.removeEntry(entry.requestId, pendingId);
    entry.resolve(resolution);

    const next = this.peekFront(entry.requestId);
    if (next) {
      const wake = this.waiters.get(entry.requestId);
      if (wake) {
        this.waiters.delete(entry.requestId);
        wake(next);
      } else if (this.onFollowUp) {
        this.onFollowUp({
          noticeId: `perm-${next.pending.pendingId}`,
          source: 'recovery',
          requestId: entry.requestId,
          operationId: next.pending.pendingId,
          action: 'mcp_tool_call',
          status: 'awaiting_user',
          result: {
            requestId: entry.requestId,
            disposition: 'awaiting_user',
            actionResults: [],
            pending: next.pending,
            facts: {
              question: {
                kind: next.pending.kind,
                purpose: next.pending.purpose,
                requiredSlots: next.pending.requiredSlots,
                questionText: next.questionText,
                ...(next.scope ? { scope: next.scope } : {}),
              },
            },
            sources: [],
            processingErrors: [],
          },
          observedAt: this.nowIso(),
        });
      }
    }
    return true;
  }

  /** 요청 취소·만료 시 대기 중인 모든 Worker 허가를 안전하게 종료한다 */
  abortRequest(requestId: string, reason = 'cancelled'): void {
    const list = this.queues.get(requestId);
    if (!list) return;
    this.queues.delete(requestId);
    this.waiters.delete(requestId);
    for (const entry of list) {
      this.byPendingId.delete(entry.pending.pendingId);
      entry.resolve({
        approved: false,
        verdict: reason === 'expired' ? 'expired' : 'revoked',
        answerText: '',
        turnId: '',
        rationale: reason,
        resolvedAt: this.nowIso(),
      });
    }
  }

  private removeEntry(requestId: string, pendingId: string): void {
    this.byPendingId.delete(pendingId);
    const list = this.queues.get(requestId);
    if (!list) return;
    const filtered = list.filter((e) => e.pending.pendingId !== pendingId);
    if (filtered.length > 0) this.queues.set(requestId, filtered);
    else this.queues.delete(requestId);
  }
}
