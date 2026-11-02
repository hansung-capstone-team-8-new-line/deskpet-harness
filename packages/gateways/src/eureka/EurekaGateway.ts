import type {
  CallConstraints,
  ChangeOutcomeQuery,
  CompleteStageCommand,
  DispatchHandle,
  ErrorInfo,
  EurekaGatewayPort,
  GatewayResult,
  ItemState,
  ProvisionalErrorCode,
  ReadOutcome,
  StageNote,
  StageNoteList,
  StageStatus,
  TaskList,
  TaskStage,
  TaskState,
  TaskSummary,
} from '@deskpet/contracts';
import { boundedTimeout, HttpTransportError, type HttpClient, type HttpRequest, type HttpResponse } from '../http.js';
import { err, gr, parseErrorBody } from '../result.js';

/**
 * EurekaGateway — 통신과 증거 정규화만 맡는다. 업무 상태 원본을 만들지 않는다 (Liability §Ownership).
 *
 * 근거: eureka-desk-pet-guide.pdf (§1 base URL·x-api-key, §3 stage$$ 완료 판정, §4 API, §6 오류),
 *       interface-contracts I-10 (connect 2s / total 8s 제안, GET 1회 재시도, 쓰기 응답 유실 unknown).
 */
export interface EurekaGatewayOptions {
  http: HttpClient;
  now: () => number;
  totalTimeoutMs?: number;
  /**
   * 쓰기 허용. 기본 false — 사용자의 명시적 허락 전에는 실제 Eureka에 쓰지 않는다.
   * false면 쓰기 메서드는 DurableAck도 요청하지 않고 not_sent(writes_disabled)를 돌려준다.
   */
  allowWrites?: boolean;
  /**
   * 사람(운영자) 최종 확인. 있으면 DurableAck 전에 묻고, yes 뒤 대상 상태를 다시 확인한 다음에만 보낸다 (GitHub와 같은 규칙, 감사 F-03).
   * 거절은 CANCELLED, 시간 초과는 DEADLINE_EXCEEDED — 둘 다 not_sent.
   */
  operatorConfirm?: EurekaOperatorConfirm;
}

export interface EurekaOperatorConfirm {
  confirm(
    write: { action: string; target: string; method: string; path: string; body?: unknown },
    c: { deadlineAt: string; signal?: AbortSignal },
  ): Promise<'approved' | 'declined' | 'timeout'>;
}

const WRITE_STAGE = 'eureka.write';
const READ_STAGE = 'eureka.read';

export class EurekaGateway implements EurekaGatewayPort {
  private readonly totalTimeoutMs: number;

  constructor(private readonly o: EurekaGatewayOptions) {
    this.totalTimeoutMs = o.totalTimeoutMs ?? 8_000;
  }

  // ================================================================ reads
  async listTasks(query: { onlyOpen?: boolean; limit?: number }, c: CallConstraints): Promise<ReadOutcome<TaskList>> {
    const res = await this.read(
      { method: 'GET', path: '/_api_/items/0/list', query: { sites: '', detail: 'true', limit: String(query.limit ?? 100) } },
      c,
    );
    if (!res.ok) return { ok: false, result: res.result };
    const body = safeJson(res.response.bodyText) as { total?: number; list?: unknown[] } | undefined;
    if (!body || !Array.isArray(body.list)) {
      return { ok: false, result: readFailure('EUREKA_SERVER_ERROR', 'unexpected list body', 'none') };
    }
    const all = body.list.map(normalizeItem);
    const items = query.onlyOpen ? all.filter((i) => i.computedState !== 'done' && i.computedState !== 'hold') : all;
    const completeness = typeof body.total === 'number' ? (body.list.length < body.total ? 'partial' : 'complete') : 'unknown';
    const observedAt = this.iso();
    const data: TaskList = { items, completeness, observedAt, ...(typeof body.total === 'number' ? { total: body.total } : {}) };
    return {
      ok: true,
      data,
      result: gr({ mode: 'read', dispatchState: 'sent', outcome: 'response', respondedAt: observedAt, completeness, response: { count: items.length } }),
    };
  }

  async getTaskState(query: { itemId: string; stageId?: string }, c: CallConstraints): Promise<ReadOutcome<TaskState>> {
    const res = await this.read({ method: 'GET', path: `/_api_/items/${enc(query.itemId)}/status` }, c);
    if (!res.ok) return { ok: false, result: res.result };
    const body = safeJson(res.response.bodyText) as { status?: string; total?: number; done?: number } | undefined;
    if (!body) return { ok: false, result: readFailure('EUREKA_SERVER_ERROR', 'unexpected status body', 'none') };
    let stage: TaskStage | undefined;
    let completeness: 'complete' | 'partial' = 'complete';
    if (query.stageId) {
      // 단건 GET은 stage 상태를 주지 않으므로 목록 + detail=true를 쓴다 (PDF §4 조회)
      const list = await this.listTasks({ limit: 100 }, c);
      if (!list.ok) return { ok: false, result: list.result };
      stage = list.data!.items.find((i) => i.itemId === query.itemId)?.stages.find((s) => s.stageId === query.stageId);
      if (!stage) completeness = list.data!.completeness === 'complete' ? 'complete' : 'partial';
    }
    const observedAt = this.iso();
    const data: TaskState = {
      itemId: query.itemId,
      itemStatus: toItemState(body.status),
      totalStages: body.total ?? 0,
      doneStages: body.done ?? 0,
      observedAt,
      ...(stage ? { stage } : {}),
    };
    return {
      ok: true,
      data,
      result: gr({
        mode: 'read',
        dispatchState: 'sent',
        outcome: 'response',
        respondedAt: observedAt,
        completeness,
        response: { itemStatus: data.itemStatus, stageFound: !!stage, ...(query.stageId && !stage ? { stageMissing: query.stageId } : {}) },
      }),
    };
  }

  /**
   * 단계 기록 목록 (본문 포함). PDF에 없는 경로로, 2026-10-24 flw-d1에서 확인:
   * GET /_api_/notes/0/list?sites&detail=true&stageId= → {total, limit, page, list:[{id, content, stageId, $:{uid}, ...}]}
   */
  async listStageNotes(query: { stageId: string; limit?: number }, c: CallConstraints): Promise<ReadOutcome<StageNoteList>> {
    const res = await this.read(
      { method: 'GET', path: '/_api_/notes/0/list', query: { sites: '', detail: 'true', stageId: query.stageId, limit: String(query.limit ?? 50) } },
      c,
    );
    if (!res.ok) return { ok: false, result: res.result };
    const body = safeJson(res.response.bodyText) as { total?: number; list?: unknown[] } | undefined;
    if (!body || !Array.isArray(body.list)) return { ok: false, result: readFailure('EUREKA_SERVER_ERROR', 'unexpected note list body', 'none') };
    const notes: StageNote[] = body.list.flatMap((raw) => {
      const r = raw as Record<string, unknown>;
      if (r['id'] === undefined || typeof r['content'] !== 'string') return [];
      if (typeof r['deletedAt'] === 'number' && r['deletedAt'] > 0) return [];
      const owner = r['$'] as { uid?: unknown } | undefined;
      return [
        {
          noteId: String(r['id']),
          stageId: String(r['stageId'] ?? query.stageId),
          content: r['content'],
          ...(owner?.uid !== undefined ? { authorUid: String(owner.uid) } : {}),
          ...(typeof r['createdAt'] === 'number' ? { createdAt: new Date(r['createdAt']).toISOString() } : {}),
          ...(typeof r['isResolved'] === 'boolean' ? { isResolved: r['isResolved'] } : {}),
        },
      ];
    });
    const completeness = typeof body.total === 'number' ? (body.list.length < body.total ? 'partial' : 'complete') : 'unknown';
    const observedAt = this.iso();
    const data: StageNoteList = { stageId: query.stageId, notes, completeness, observedAt, ...(typeof body.total === 'number' ? { total: body.total } : {}) };
    return { ok: true, data, result: gr({ mode: 'read', dispatchState: 'sent', outcome: 'response', respondedAt: observedAt, completeness, response: { count: notes.length } }) };
  }

  /** 키·workspace 확인 (PDF §1: GET /_api_/session). 읽기 전용 */
  async checkSession(c: CallConstraints): Promise<ReadOutcome<{ sid: string; roles: string[] }>> {
    const res = await this.read({ method: 'GET', path: '/_api_/session' }, c);
    if (!res.ok) return { ok: false, result: res.result };
    const b = safeJson(res.response.bodyText) as { sid?: unknown; roles?: unknown } | undefined;
    const data = { sid: String(b?.sid ?? ''), roles: Array.isArray(b?.roles) ? b!.roles.map(String) : [] };
    return { ok: true, data, result: gr({ mode: 'read', dispatchState: 'sent', outcome: 'response', respondedAt: this.iso() }) };
  }

  // =============================================================== writes
  /**
   * 단계 하나 완료. 실행 직전 외부 상태를 재검증하고, DurableAck 이후에만 전송한다. 자동 재전송 없음.
   * 상위 업무 전체로 확대하지 않는다 (completeItem을 쓰지 않음).
   */
  async completeStage(cmd: CompleteStageCommand, handle: DispatchHandle, c: CallConstraints): Promise<GatewayResult> {
    const ids = { operationId: handle.operationId, attemptId: handle.attemptId };
    const precheck = async (): Promise<{ stop: GatewayResult } | { st: TaskState }> => {
      const pre = await this.getTaskState({ itemId: cmd.itemId, stageId: cmd.stageId }, c);
      if (!pre.ok) return { stop: notSent(pre.result.error ?? err(WRITE_STAGE, 'EUREKA_SERVER_ERROR', 'pre-check failed', 'none', ids), 'precheck_read_failed') };
      const st = pre.data!;
      if (st.itemStatus === 'hold') {
        return { stop: notSent(err(WRITE_STAGE, 'EUREKA_CONFLICT', 'item is on hold; stage change would be rejected (409)', 'user_input', ids), 'precheck_hold', st) };
      }
      if (!st.stage) return { stop: notSent(err(WRITE_STAGE, 'EUREKA_NOT_FOUND', 'stage not found in item', 'none', ids), 'precheck_stage_missing', st) };
      if (st.stage.status === 'done' || st.stage.status === 'skip') {
        // 이미 존재하던 완료 상태는 이번 operation 성공이 아니다
        return { stop: notSent(err(WRITE_STAGE, 'POLICY_BLOCKED', 'stage already done before this operation', 'none', ids), 'precheck_already_done', st) };
      }
      return { st };
    };
    const first = await precheck();
    if ('stop' in first) return first.stop;
    const st = first.st;
    return this.sendWrite(
      { method: 'POST', path: `/_api_/stages/${enc(cmd.stageId)}/status`, body: { status: 'done' } },
      handle,
      c,
      (body) => {
        const b = body as { stage?: { id?: unknown; status?: unknown; completedAt?: unknown }; warnings?: unknown };
        const stage = b?.stage;
        if (!stage || typeof stage.status !== 'string') return { response: { raw: body } };
        const completedAt = typeof stage.completedAt === 'number' ? new Date(stage.completedAt).toISOString() : undefined;
        return {
          response: { stageId: String(stage.id ?? cmd.stageId), status: stage.status, completedAt, warnings: b.warnings ?? [], priorStageStatus: st.stage!.status },
          externalRefs: [
            {
              system: 'eureka' as const,
              kind: 'stage_status_change',
              id: `${String(stage.id ?? cmd.stageId)}@${completedAt ?? 'n/a'}`,
              details: { status: stage.status },
            },
          ],
        };
      },
      { action: 'complete_stage', target: `item ${cmd.itemId} / stage ${cmd.stageId}${st.stage!.name ? ` (${st.stage!.name})` : ''}` },
      // 운영자가 yes 하는 동안 바뀌었을 수 있으므로 다시 확인한다
      async () => {
        const again = await precheck();
        return 'stop' in again ? again.stop : undefined;
      },
    );
  }

  /**
   * 기존 Eureka operation 결과 조회. 쓰기를 실행하지 않는다.
   * Eureka에는 멱등키·operation 식별자가 없어(README C-09) 현재 stage가 done이어도 이번 operation과의 인과 연결은
   * 후보 수준이다(inference). Sensor가 indeterminate로 판정하고 unknown을 유지한다.
   */
  async getChangeOutcome(q: ChangeOutcomeQuery, c: CallConstraints): Promise<GatewayResult> {
    const st = await this.getTaskState({ itemId: q.itemId, stageId: q.stageId }, c);
    if (!st.ok) return st.result;
    const s = st.data!.stage;
    return gr({
      mode: 'read',
      dispatchState: 'sent',
      outcome: 'response',
      respondedAt: this.iso(),
      response: {
        currentStageStatus: s?.status ?? 'unknown',
        priorStageStatus: q.priorStageStatus,
        linkage: s && (s.status === 'done' || s.status === 'skip') && q.priorStageStatus !== 'done' ? 'candidate_only' : 'none',
      },
    });
  }

  // ========================================== direct path (계약 미정, 다이어그램)
  /** 미정: 직접 경로의 사용자 확인 정책은 파이프라인 Eureka 모듈 소유. 정책이 없으면 소유자가 쓰기를 차단해야 한다. */
  registerItem(cmd: { processId: string; name: string; dueAtMs?: number; priority?: 'low' | 'normal' | 'high' | 'urgent' }, handle: DispatchHandle, c: CallConstraints) {
    // API 필드는 dueAt(밀리초 타임스탬프)이다 (eureka-desk-pet-guide §4 등록 예시). 내부 이름 dueAtMs를 그대로 보내지 않는다
    const body = { processId: cmd.processId, name: cmd.name, ...(cmd.dueAtMs !== undefined ? { dueAt: cmd.dueAtMs } : {}), ...(cmd.priority ? { priority: cmd.priority } : {}) };
    return this.sendWrite({ method: 'POST', path: '/_api_/items/0/start', body }, handle, c, (b) => {
      const item = b as { id?: unknown; stageIds?: unknown };
      return item?.id
        ? { response: { itemId: String(item.id), stageIds: item.stageIds }, externalRefs: [{ system: 'eureka' as const, kind: 'item', id: String(item.id) }] }
        : { response: { raw: b } };
    }, { action: 'register_item', target: `새 업무 '${cmd.name}'` });
  }

  /** 미정: 보낸 필드만 바뀐다 (PDF §4 연기) */
  postponeItem(cmd: { itemId: string; dueAtMs: number }, handle: DispatchHandle, c: CallConstraints) {
    return this.sendWrite({ method: 'PUT', path: `/_api_/items/${enc(cmd.itemId)}`, body: { dueAt: cmd.dueAtMs } }, handle, c, (b) => {
      const item = b as { id?: unknown; dueAt?: unknown };
      return item?.id && item.dueAt === cmd.dueAtMs
        ? { response: { itemId: String(item.id), dueAt: item.dueAt }, externalRefs: [{ system: 'eureka' as const, kind: 'item_due_change', id: `${String(item.id)}@${cmd.dueAtMs}` }] }
        : { response: { raw: b } };
    }, { action: 'postpone_item', target: `item ${cmd.itemId}` });
  }

  /** 미정: 업무 전체 완료. Harness 경로에서 사용하지 않는다 */
  completeItem(cmd: { itemId: string; actorId?: string }, handle: DispatchHandle, c: CallConstraints) {
    return this.sendWrite(
      { method: 'POST', path: `/_api_/items/${enc(cmd.itemId)}/complete`, body: cmd.actorId ? { actorId: cmd.actorId } : {} },
      handle,
      c,
      (b) => {
        const item = b as { id?: unknown };
        return item?.id ? { response: { item: b }, externalRefs: [{ system: 'eureka' as const, kind: 'item_complete', id: String(item.id) }] } : { response: { raw: b } };
      },
      { action: 'complete_item', target: `item ${cmd.itemId}` },
    );
  }

  /** 미정: 템플릿 목록 */
  async listProcesses(c: CallConstraints): Promise<ReadOutcome<{ id: string; name: string }[]>> {
    const res = await this.read({ method: 'GET', path: '/_api_/processes/0/list', query: { sites: '', detail: 'true', limit: '50' } }, c);
    if (!res.ok) return { ok: false, result: res.result };
    const body = safeJson(res.response.bodyText) as { list?: { id: unknown; name: unknown }[] } | undefined;
    const data = (body?.list ?? []).map((p) => ({ id: String(p.id), name: String(p.name) }));
    return { ok: true, data, result: gr({ mode: 'read', dispatchState: 'sent', outcome: 'response', respondedAt: this.iso() }) };
  }

  // ============================================================== helpers
  private iso() {
    return new Date(this.o.now()).toISOString();
  }

  /** 읽기: 일시 오류는 deadline 안에서 최대 1회 재시도. 인증·권한·입력·미지원 오류는 재시도 없음. */
  private async read(
    req: Omit<HttpRequest, 'timeoutMs'>,
    c: CallConstraints,
  ): Promise<{ ok: true; response: HttpResponse } | { ok: false; result: GatewayResult }> {
    let lastFailure: GatewayResult | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const timeoutMs = boundedTimeout(this.totalTimeoutMs, c.deadlineAt, this.o.now());
      if (timeoutMs <= 0 || c.signal?.aborted) {
        return { ok: false, result: lastFailure ?? readFailure('DEADLINE_EXCEEDED', 'deadline exceeded before read', 'none') };
      }
      try {
        const response = await this.o.http.request({ ...req, timeoutMs, ...(c.signal ? { signal: c.signal } : {}) });
        if (response.status >= 200 && response.status < 300) return { ok: true, response };
        const mapped = mapHttpError(response, READ_STAGE);
        lastFailure = gr({ mode: 'read', dispatchState: 'sent', outcome: 'error', error: mapped.error });
        if (!mapped.transient) break;
      } catch (e) {
        if (!(e instanceof HttpTransportError)) throw e;
        lastFailure = readFailure('EUREKA_TRANSIENT', e.message, 'bounded_read_retry');
      }
    }
    return { ok: false, result: lastFailure! };
  }

  private async sendWrite(
    req: Omit<HttpRequest, 'timeoutMs'>,
    handle: DispatchHandle,
    c: CallConstraints,
    interpret: (body: unknown) => { response: Record<string, unknown>; externalRefs?: GatewayResult['externalRefs'] },
    describe: { action: string; target: string },
    /** 운영자 yes 뒤 대상 상태 재확인. 실패(전송 중단)면 GatewayResult를 돌려준다 */
    recheck?: () => Promise<GatewayResult | undefined>,
  ): Promise<GatewayResult> {
    const ids = { operationId: handle.operationId, attemptId: handle.attemptId };
    if (!this.o.allowWrites) {
      return notSent(err(WRITE_STAGE, 'POLICY_BLOCKED', 'writes disabled (allowWrites=false)', 'none', ids), 'writes_disabled');
    }
    const timeoutMs = boundedTimeout(this.totalTimeoutMs, c.deadlineAt, this.o.now());
    if (timeoutMs <= 0 || c.signal?.aborted) {
      return notSent(err(WRITE_STAGE, 'DEADLINE_EXCEEDED', 'deadline exceeded before dispatch', 'none', ids), 'deadline_before_dispatch');
    }
    let timeoutMs2 = timeoutMs;
    if (this.o.operatorConfirm) {
      const verdict = await this.o.operatorConfirm.confirm({ ...describe, method: req.method, path: req.path, ...(req.body !== undefined ? { body: req.body } : {}) }, { deadlineAt: c.deadlineAt, ...(c.signal ? { signal: c.signal } : {}) });
      if (verdict === 'declined') return notSent(err(WRITE_STAGE, 'CANCELLED', 'operator declined before sending', 'none', ids), 'operator_declined');
      if (verdict === 'timeout') return notSent(err(WRITE_STAGE, 'DEADLINE_EXCEEDED', 'operator confirmation timed out', 'none', ids), 'operator_timeout');
      if (recheck) {
        const stop = await recheck();
        if (stop) return stop;
      }
      timeoutMs2 = boundedTimeout(this.totalTimeoutMs, c.deadlineAt, this.o.now());
      if (timeoutMs2 <= 0 || c.signal?.aborted) return notSent(err(WRITE_STAGE, 'DEADLINE_EXCEEDED', 'deadline exceeded before dispatch', 'none', ids), 'deadline_before_dispatch');
    }
    const ack = await handle.beforeDispatch();
    if (!ack.ok) {
      const code: ProvisionalErrorCode = ack.reason === 'storage_error' ? 'STORAGE_RESERVATION_FAILED' : 'POLICY_BLOCKED';
      return notSent(err(WRITE_STAGE, code, `no durable ack: ${ack.reason} ${ack.detail}`, 'none', ids), `no_ack:${ack.reason}`);
    }
    let response: HttpResponse;
    try {
      response = await this.o.http.request({ ...req, timeoutMs: timeoutMs2, ...(c.signal ? { signal: c.signal } : {}) });
    } catch (e) {
      if (!(e instanceof HttpTransportError)) throw e;
      if (e.failure.kind === 'not_sent') {
        return notSent(err(WRITE_STAGE, 'EUREKA_TRANSIENT', e.message, 'none', ids), e.failure.proof);
      }
      // 전송 후 응답 유실: unknown, 재전송 금지, 기존 결과 조회
      return gr({
        mode: 'write',
        dispatchState: 'may_have_been_sent',
        outcome: 'no_response',
        error: err(WRITE_STAGE, 'EUREKA_TIMEOUT_RESULT_UNKNOWN', e.message, 'reconcile', ids),
      });
    }
    const respondedAt = this.iso();
    if (response.status >= 200 && response.status < 300) {
      const body = safeJson(response.bodyText);
      const r = interpret(body);
      return gr({ mode: 'write', dispatchState: 'sent', outcome: 'response', respondedAt, response: r.response, externalRefs: r.externalRefs ?? [] });
    }
    // 명시적인 쓰기 실패: 초기에는 자동 재시도 없음
    const mapped = mapHttpError(response, WRITE_STAGE, ids);
    return gr({ mode: 'write', dispatchState: 'sent', outcome: 'error', respondedAt, error: { ...mapped.error, nextAction: 'none' } });
  }
}

// ================================================================ mapping
function mapHttpError(res: HttpResponse, stage: string, ids: { operationId?: string; attemptId?: string } = {}): { error: ErrorInfo; transient: boolean } {
  const msg = parseErrorBody(res.bodyText).slice(0, 300);
  switch (res.status) {
    case 403:
      return { error: err(stage, 'EUREKA_AUTH_ERROR', `403 ${msg}`, 'none', ids), transient: false };
    case 404:
      return { error: err(stage, 'EUREKA_NOT_FOUND', `404 ${msg}`, 'none', ids), transient: false };
    case 409:
      return { error: err(stage, 'EUREKA_CONFLICT', `409 ${msg}`, 'user_input', ids), transient: false };
    case 502:
    case 503:
    case 504:
      return { error: err(stage, 'EUREKA_TRANSIENT', `${res.status} ${msg}`, 'bounded_read_retry', ids), transient: true };
    default:
      // 검증 실패가 500으로 오는 경우가 많다: 본문을 보고 입력 오류를 구분한다 (PDF §6)
      if (res.status === 400 || /is (invalid|required)/.test(msg)) {
        return { error: err(stage, 'EUREKA_INPUT_INVALID', `${res.status} ${msg}`, 'none', ids), transient: false };
      }
      return { error: err(stage, 'EUREKA_SERVER_ERROR', `${res.status} ${msg}`, 'none', ids), transient: false };
  }
}

function readFailure(code: ProvisionalErrorCode, message: string, next: ErrorInfo['nextAction']): GatewayResult {
  return gr({ mode: 'read', dispatchState: 'not_sent', outcome: 'error', error: err(READ_STAGE, code, message, next) });
}

function notSent(error: ErrorInfo, proof: string, facts?: unknown): GatewayResult {
  return gr({ mode: 'write', dispatchState: 'not_sent', outcome: 'error', notSentProof: proof, error, ...(facts ? { response: { precheck: facts } } : {}) });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const enc = encodeURIComponent;

const STAGE_STATUSES: readonly StageStatus[] = ['todo', 'doing', 'done', 'skip'];

export function normalizeItem(raw: unknown): TaskSummary {
  const r = raw as Record<string, unknown>;
  const stagesRaw = Array.isArray(r['stage$$']) ? (r['stage$$'] as Record<string, unknown>[]) : [];
  const stages: TaskStage[] = stagesRaw.map((s) => {
    // detail=true 목록에서 status 누락은 todo로 본다 (PDF §3-(2) item_state)
    const st = s['status'] === undefined || s['status'] === null ? 'todo' : String(s['status']);
    return {
      stageId: String(s['id']),
      name: String(s['name'] ?? '').trim(),
      status: (STAGE_STATUSES as readonly string[]).includes(st) ? (st as StageStatus) : 'unknown',
      ...(typeof s['order'] === 'number' ? { order: s['order'] } : {}),
      ...(typeof s['completedAt'] === 'number' ? { completedAt: new Date(s['completedAt']).toISOString() } : {}),
      ...(Array.isArray(s['noteIds']) && s['noteIds'].length ? { noteIds: (s['noteIds'] as unknown[]).map(String) } : {}),
    };
  });
  const dueAtMs = typeof r['dueAt'] === 'number' ? r['dueAt'] : undefined;
  return {
    itemId: String(r['id']),
    name: String(r['name'] ?? '').trim(),
    ...(typeof r['description'] === 'string' ? { description: r['description'] } : {}),
    ...(dueAtMs !== undefined ? { dueAtMs, dueAt: new Date(dueAtMs).toISOString() } : {}),
    ...(typeof r['priority'] === 'string' ? { priority: r['priority'] } : {}),
    computedState: computeItemState(r['status'], stages),
    stages,
  };
}

/** PDF §3-(2) item_state 로직 */
export function computeItemState(itemStatus: unknown, stages: TaskStage[]): ItemState {
  if (itemStatus === 'hold') return 'hold';
  if (stages.length === 0) return 'todo';
  if (stages.every((s) => s.status === 'done' || s.status === 'skip')) return 'done';
  if (stages.some((s) => s.status === 'doing' || s.status === 'done')) return 'doing';
  return 'todo';
}

function toItemState(s: unknown): ItemState {
  return s === 'done' || s === 'doing' || s === 'hold' ? s : 'todo';
}
