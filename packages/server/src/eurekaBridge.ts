import {
  BRIDGE_FACT_KEYS as K,
  Target,
  type ActionName,
  type ErrorInfo,
  type GatewayResult,
  type OperationRecord,
  type PipelineActionRequest,
  type PipelineActionResult,
  type PipelineError,
  type PipelineEurekaActionRequest,
  type PipelineReminderItem,
  type PipelineRemindersResult,
  type TaskSummary,
  type LinkedPr,
  type PrLinkLookup,
  extractPrLinks,
  isRepositoryAllowed,
} from '@deskpet/contracts';
import { createHash } from 'node:crypto';
import type { EurekaGateway, StageEdit } from '@deskpet/gateways';
import { DEFAULT_POLICY, StoreDispatchOwner, expectedOutcomeFor, type Clock, type OperationStore } from '@deskpet/harness';
import { formatKoreanDateTime } from '@deskpet/output';

/**
 * 파이프라인 문서의 EurekaAdapter (class-diagrams §4): execute / reconcile / reminders / reminder(itemId).
 *
 * 문서를 따른 부분
 * - 입력은 ActionRequest {requestId, operationId, decision, deadlineAt}, 결과는 ActionResult {operationId, status, facts, error}
 * - 리마인더는 업무 설명(description)과 실제 마감 일시(dueAt, 시간대 포함). 설명이 없으면 업무명으로 대체하지 않고 뺀다 (interface-contracts §9)
 * - 쓰기 응답 유실은 unknown, reconcile로만 확인한다. 재전송하지 않는다
 *
 * 문서에 없어 현재 구현을 따른 부분 (docs/pipeline-bridge.md P-12~)
 * - 의도 값: 라우터 형식(intention=eureka + operation 라벨) 또는 eureka.<이름>. 지원: list·query·status·postpone(update_due_date)·
 *   create(register)·complete·add_note·query_processes. 그 밖의 라우터 라벨은 실행하지 않고 지원 범위를 안내한다
 * - 쓰기는 mutationApproved=true일 때만 보낸다. 아니면 고정 확인 질문(needs_clarification)을 돌려준다
 * - 쓰기는 operation 기록(owner=pipeline_eureka_module)과 DurableAck를 거친다. 같은 operationId 재요청은 기록된 결과를 돌려준다
 * - 결과 문장은 facts.resultText(고정 문구)로 준다. 파이프라인은 출력 모델의 requiredText로 쓴다
 */
/**
 * 연결된 PR → 파이프라인이 harness.run에 넣을 대상과 업무 연결 (G-01 4단계 "리마인더 문맥에서 저장소와 PR 번호를 채운다").
 * resolvedTarget은 RouteDecision에, taskRefs는 harness.run payload에 넣는다 (P-07 확장).
 */
export function harnessContextFromLink(link: LinkedPr): { resolvedTarget: { kind: 'github_pr'; repository: { owner: string; name: string }; prNumber: number }; taskRefs: { itemId: string; stageId: string; repository: { owner: string; name: string }; prNumber: number; source: { kind: 'eureka'; ref: string } }[] } {
  const repository = { owner: link.repository.owner, name: link.repository.name };
  return {
    resolvedTarget: { kind: 'github_pr', repository, prNumber: link.prNumber },
    taskRefs: [{ itemId: link.itemId, stageId: link.stageId, repository, prNumber: link.prNumber, source: { kind: 'eureka', ref: `item:${link.itemId}/stage:${link.stageId}/note:${link.noteId}` } }],
  };
}

export interface EurekaBridgeDeps {
  eureka: EurekaGateway;
  store: OperationStore;
  clock: Clock;
  holderId?: string;
  /** 업무 등록에 쓸 기본 프로세스(템플릿) ID. 없으면 task 헤드 값과 이름이 같은 프로세스를 찾는다 */
  defaultProcessId?: string;
  /** 허용 저장소 목록 `owner/name` (D-36). 목록 밖 PR 주소는 연결 후보에서 뺀다. 없거나 비면 제한 없음 */
  allowedRepositories?: string[];
  timezone?: string;
}

type DirectWrite = Extract<ActionName, 'register_item' | 'postpone_item' | 'complete_item' | 'delete_item' | 'hold_item' | 'resume_item' | 'set_stage_status' | 'set_item_priority' | 'rename_item' | 'edit_stages' | 'add_stage_note'>;
/** 단계 상태 변경 라벨 (2026-11-14): 같은 쓰기(set_stage_status)로 보낸다 */
type StageOp = 'stage:start' | 'stage:reset' | 'stage:skip' | 'stage:update';
/** 단계 목록 편집 라벨 (2026-11-14): 같은 쓰기(edit_stages, PUT /items/{id}/stages)로 보낸다 */
type StageListOp = 'stages:add' | 'stages:delete' | 'stages:up' | 'stages:down';
type Kind = 'list' | 'query' | 'status' | 'processes' | DirectWrite | StageOp | StageListOp;

/**
 * 의도 이름 → 처리. 두 형식을 받는다 (wiki small-router-model: Intention=eureka + Operation 24개 라벨)
 * - 라우터 형식: intention='eureka', operation='<라벨>'
 * - 기존 형식: intention='eureka.<이름>' (P-12)
 */
const OPS: Record<string, Kind> = {
  list: 'list',
  query: 'query',
  status: 'status',
  postpone: 'postpone_item',
  update_due_date: 'postpone_item',
  register: 'register_item',
  create: 'register_item',
  complete: 'complete_item',
  delete: 'delete_item',
  hold: 'hold_item',
  resume: 'resume_item',
  start_stage: 'stage:start',
  reset_stage: 'stage:reset',
  skip_stage: 'stage:skip',
  update_stage: 'stage:update',
  update_priority: 'set_item_priority',
  priority: 'set_item_priority',
  update_item: 'rename_item',
  add_stage: 'stages:add',
  delete_stage: 'stages:delete',
  move_stage_up: 'stages:up',
  move_stage_down: 'stages:down',
  add_note: 'add_stage_note',
  query_processes: 'processes',
};

/** 아직 지원하지 않는 라우터 Operation 라벨의 한국어 이름 (미지원 응답에 쓴다) */
const UNSUPPORTED_OPS: Record<string, string> = {
  complete_task: '체크리스트 완료',
  query_actors: '담당자 조회',
  query_workspace: '워크스페이스 조회',
  delete_task: '체크리스트 삭제',
  add_task: '체크리스트 추가',
};

/** 미지원 응답 (wiki deskpet-operation-policies §3): 실행하지 않음 → 지원 범위 → 대안 */
const SUPPORTED_SCOPE = '지금은 업무 조회·등록·기한·우선순위·이름 변경·완료·보류·재개·삭제, 단계 추가·삭제·순서 변경·시작·되돌리기·건너뛰기와 기록 추가를 할 수 있어요.';
function unsupportedSentence(what?: string): string {
  return `${what ? `${what}${topic(what)} 아직 지원하지 않아` : '그 요청은'} 실행하지 않았어요. ${SUPPORTED_SCOPE}`;
}

/** 은/는: 마지막 글자에 받침이 있으면 '은' */
function topic(word: string): '은' | '는' {
  const c = word.charCodeAt(word.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0 ? '은' : '는';
}

function operationOf(a: PipelineActionRequest): string {
  const intention = String(a.decision.headOutputs['intention']?.value ?? '').trim();
  if (intention === 'eureka') return String(a.decision.headOutputs['operation']?.value ?? '').trim();
  return intention.startsWith('eureka.') ? intention.slice('eureka.'.length) : '';
}

export class EurekaBridge {
  private readonly owner: StoreDispatchOwner;
  private readonly tz: string;

  constructor(private readonly d: EurekaBridgeDeps) {
    this.tz = d.timezone ?? 'Asia/Seoul';
    // 직접 경로의 실행 직전 재검사: deadline만 본다 (사용자 확인은 파이프라인 Eureka 모듈 소유)
    this.owner = new StoreDispatchOwner(d.store, d.clock, d.holderId ?? 'pipeline-eureka-bridge', async (op) => {
      const dl = op.actualRequest['deadlineAt'];
      return typeof dl === 'string' && d.clock.nowMs() > Date.parse(dl) ? 'deadline_exceeded' : null;
    });
  }

  // ============================================================== execute
  async execute(a: PipelineEurekaActionRequest): Promise<PipelineActionResult> {
    const op = operationOf(a);
    const kind = OPS[op];
    if (!kind) {
      // 라우터 24개 라벨 중 아직 실행하지 않는 동작은 EUREKA_OPERATION_NOT_IMPLEMENTED (wiki interface-contracts 2026-11-01), 그 밖의 값은 정책 차단
      const known = op in UNSUPPORTED_OPS;
      return fail(a.operationId, known ? 'EUREKA_OPERATION_NOT_IMPLEMENTED' : 'POLICY_BLOCKED', `${known ? 'not implemented' : 'unsupported'} eureka operation: ${op || '(none)'}`, unsupportedSentence(UNSUPPORTED_OPS[op]));
    }
    if (a.decision.missingRequiredSlots.length) {
      return clarify(a.operationId, { missing: a.decision.missingRequiredSlots.join(',') }, '필요한 정보가 빠졌어요. 어떤 업무인지 조금 더 말해 주시겠어요?');
    }

    // 같은 operationId 재요청: 다시 보내지 않고 기록된 결과를 돌려준다
    const prior = await this.findByPipelineOp(a.requestId, a.operationId);
    if (prior) {
      // 같은 operationId인데 다른 작업·대상이면 이전 결과를 돌려주지 않는다 (업무 섞임 방지, 2026-11-08)
      const fp = prior.actualRequest['requestFingerprint'];
      if (typeof fp === 'string' && fp !== fingerprintOf(a)) {
        return fail(a.operationId, 'OPERATION_ID_REUSED', 'operationId already used for a different eureka request', '이전 요청과 같은 작업 번호로 다른 요청이 와서 실행하지 않았어요. 새 요청으로 다시 말씀해 주세요.');
      }
      return this.fromOperation(prior, a.operationId);
    }

    const c = { deadlineAt: a.deadlineAt };
    const name = itemNameOf(a);
    // 조회(query): 대상이 있으면 그 업무 상태, 없으면 목록
    const hasTarget = Target.safeParse(a.decision.resolvedTarget).success || !!name;
    if (kind === 'list' || (kind === 'query' && !hasTarget)) return this.list(a, c);
    if (kind === 'processes') return this.processes(a, c);
    if (kind === 'register_item') return this.register(a, newItemNameOf(a), c);

    const item = await this.resolveItem(a, name, c);
    if ('result' in item) return item.result;
    if (kind === 'status' || kind === 'query') return this.status(a, item.task, c);
    if (kind === 'add_stage_note') return this.addNote(a, item.task, c);
    if (kind === 'stage:start' || kind === 'stage:reset' || kind === 'stage:skip' || kind === 'stage:update') return this.stageStatus(a, kind, item.task, c);
    if (kind === 'set_item_priority' || kind === 'rename_item') return this.itemField(a, kind, item.task, c);
    if (kind === 'stages:add' || kind === 'stages:delete' || kind === 'stages:up' || kind === 'stages:down') return this.stageList(a, kind, item.task, c);
    // 마감 변경에 실제 단계 이름이 있으면 그 단계의 마감을 바꾼다 (단계별 마감, 2026-11-14). 단계 이름이 아니면 지금처럼 업무 마감
    if (kind === 'postpone_item' && item.task.stages.some((st) => st.name === stageNameOf(a))) return this.stageList(a, 'stages:due', item.task, c);
    if (kind === 'edit_stages') return fail(a.operationId, 'POLICY_BLOCKED', 'internal action', unsupportedSentence());
    if (kind === 'set_stage_status') return fail(a.operationId, 'POLICY_BLOCKED', 'internal action', unsupportedSentence());
    return this.itemWrite(a, kind, item.task, c);
  }

  // ============================================================ reconcile
  /** 결과를 모르는 직접 경로 쓰기를 조회로만 확인한다. 멱등키가 없어 일치해도 후보 수준이면 unknown을 유지한다 */
  async reconcile(a: PipelineActionRequest): Promise<PipelineActionResult> {
    const ops = (await this.d.store.listOperations(a.requestId)).filter((o) => o.owner === 'pipeline_eureka_module');
    // operationId가 정확히 맞는 기록만 본다. 다른 작업의 결과로 대신하지 않는다 (2026-11-08)
    const op = ops.find((o) => o.actualRequest['pipelineOperationId'] === a.operationId);
    if (!op) return { operationId: a.operationId, status: 'unknown', facts: {}, error: perr('RECONCILIATION_UNAVAILABLE', 'no eureka operation recorded with this operationId', a.operationId) };
    if (op.recovery !== 'needed' || !op.actionResult || op.actionResult.status !== 'unknown') return this.fromOperation(op, a.operationId);

    const itemId = op.target.kind === 'eureka_item' ? op.target.itemId : undefined;
    const observation: Record<string, string> = {};
    if (itemId) {
      const list = await this.d.eureka.listTasks({ limit: 100 }, { deadlineAt: a.deadlineAt });
      const t = list.ok ? list.data!.items.find((x) => x.itemId === itemId) : undefined;
      // 삭제: 목록에서 사라졌으면 삭제됐을 가능성이 높다 (인과는 후보 수준)
      if (op.action === 'delete_item' && list.ok && list.data!.completeness === 'complete') observation['linkage'] = t ? 'none' : 'candidate_only';
      if (t) {
        observation['currentState'] = t.computedState;
        if (t.dueAtMs !== undefined) observation['currentDueAt'] = this.offsetIso(t.dueAtMs);
        const want = op.actualRequest['dueAtMs'];
        const names = op.actualRequest['stageNames'];
        const matches = op.action === 'edit_stages' ? Array.isArray(names) && JSON.stringify([...t.stages].sort((x, y) => (x.order ?? 0) - (y.order ?? 0)).map((s) => s.name)) === JSON.stringify(names) : op.action === 'postpone_item' ? t.dueAtMs === want : op.action === 'complete_item' ? t.computedState === 'done' : op.action === 'hold_item' ? t.computedState === 'hold' : op.action === 'resume_item' ? t.computedState !== 'hold' : false;
        observation['linkage'] = matches ? 'candidate_only' : 'none';
      }
    }
    // 단계 기록 추가: 같은 내용의 기록이 생겼는지 조회만 한다 (인과는 후보 수준, 다시 보내지 않음)
    if (op.action === 'add_stage_note' && op.target.kind === 'eureka_stage') {
      const notes = await this.d.eureka.listStageNotes({ stageId: op.target.stageId, limit: 100 }, { deadlineAt: a.deadlineAt });
      if (notes.ok) {
        const want = op.actualRequest['contentDigest'];
        const hit = notes.data!.notes.find((n) => digest(n.content) === want);
        observation['linkage'] = hit ? 'candidate_only' : 'none';
        if (hit) observation['candidateNoteId'] = hit.noteId;
      }
    }
    const base = await this.fromOperation(op, a.operationId);
    return { ...base, facts: { ...base.facts, ...observation, recovery: 'still_unknown' } };
  }

  // ============================================================ reminders
  async reminders(deadlineAt: string): Promise<PipelineRemindersResult> {
    const list = await this.d.eureka.listTasks({ onlyOpen: true, limit: 100 }, { deadlineAt });
    if (!list.ok) return { items: [], skipped: 0, completeness: 'unknown', observedAt: this.d.clock.nowIso() };
    const items: PipelineReminderItem[] = [];
    let skipped = 0;
    for (const t of list.data!.items) {
      const r = this.toReminder(t);
      if (r) items.push(r);
      else skipped += 1;
    }
    return { items, skipped, completeness: list.data!.completeness, observedAt: list.data!.observedAt };
  }

  /** 안내 직전 최신 상태 재확인용. 완료·보류·설명 없음이면 null */
  async reminder(itemId: string, deadlineAt: string): Promise<PipelineReminderItem | null> {
    const list = await this.d.eureka.listTasks({ onlyOpen: true, limit: 100 }, { deadlineAt });
    if (!list.ok) return null;
    const t = list.data!.items.find((x) => x.itemId === itemId);
    return t ? this.toReminder(t) : null;
  }

  // ============================================================ PR links
  /**
   * 업무 단계 기록(note)에 적힌 GitHub PR 주소로 연결된 PR을 찾는다 (G-01 시작부, P-19).
   * - 기록 본문은 PR 주소만 뽑고 버린다. 결과에 원문을 넣지 않는다
   * - 서로 다른 (PR, 단계)가 둘 이상이면 ambiguous: 추측하지 않는다. 일부 기록을 못 읽으면 partial
   * - 허용 저장소 목록(D-36)에 없는 PR 주소는 후보에서 빼고 excludedCount로만 알린다. 작성자 제한은 아직 없다
   */
  async links(itemId: string, deadlineAt: string): Promise<PrLinkLookup> {
    const c = { deadlineAt };
    const list = await this.d.eureka.listTasks({ limit: 100 }, c);
    if (!list.ok) return { itemId, status: 'failed', links: [], observedAt: this.d.clock.nowIso() };
    const item = list.data!.items.find((x) => x.itemId === itemId);
    if (!item) return { itemId, status: list.data!.completeness === 'complete' ? 'not_found' : 'partial', links: [], observedAt: list.data!.observedAt };
    const found = new Map<string, LinkedPr>();
    let incomplete = false;
    let excluded = 0;
    for (const st of item.stages) {
      if (!st.noteIds?.length) continue;
      const notes = await this.d.eureka.listStageNotes({ stageId: st.stageId }, c);
      if (!notes.ok) {
        incomplete = true;
        continue;
      }
      if (notes.data!.completeness !== 'complete') incomplete = true;
      for (const n of notes.data!.notes)
        for (const l of extractPrLinks(n.content)) {
          if (!isRepositoryAllowed(this.d.allowedRepositories, l.owner, l.name)) {
            excluded++;
            continue;
          }
          const key = `${l.owner.toLowerCase()}/${l.name.toLowerCase()}#${l.prNumber}@${st.stageId}`;
          if (!found.has(key))
            found.set(key, { repository: { owner: l.owner, name: l.name }, prNumber: l.prNumber, url: l.url, itemId, stageId: st.stageId, stageName: st.name, stageStatus: st.status, noteId: n.noteId });
        }
    }
    const links = [...found.values()];
    const status = links.length > 1 ? 'ambiguous' : incomplete ? 'partial' : links.length === 1 ? 'linked' : 'none';
    return { itemId, itemName: item.name, status, links, ...(excluded > 0 ? { excludedCount: excluded } : {}), observedAt: this.d.clock.nowIso() };
  }

  // ============================================================== reads
  private async list(a: PipelineActionRequest, c: { deadlineAt: string }): Promise<PipelineActionResult> {
    const res = await this.d.eureka.listTasks({ onlyOpen: true, limit: 100 }, c);
    if (!res.ok) return fromError(a.operationId, res.result.error, '업무 목록을 가져오지 못했어요.');
    const items = [...res.data!.items].sort((x, y) => (x.dueAtMs ?? Infinity) - (y.dueAtMs ?? Infinity));
    const next = items.find((x) => x.dueAtMs !== undefined);
    const text =
      items.length === 0
        ? '진행 중인 업무가 없어요.'
        : `진행 중인 업무가 ${items.length}개 있어요.${next ? ` 마감이 가장 가까운 건 '${next.name}'이고 ${formatKoreanDateTime(new Date(next.dueAtMs!).toISOString(), this.tz)}까지예요.` : ''}`;
    return {
      operationId: a.operationId,
      status: 'succeeded',
      facts: {
        resultText: text,
        count: String(items.length),
        completeness: res.data!.completeness,
        items: JSON.stringify(items.slice(0, 20).map((x) => ({ itemId: x.itemId, name: x.name, state: x.computedState, ...(x.dueAtMs !== undefined ? { dueAt: this.offsetIso(x.dueAtMs) } : {}) }))),
      },
      error: null,
    };
  }

  private async status(a: PipelineActionRequest, t: TaskSummary, c: { deadlineAt: string }): Promise<PipelineActionResult> {
    const st = await this.d.eureka.getTaskState({ itemId: t.itemId }, c);
    if (!st.ok) return fromError(a.operationId, st.result.error, `'${t.name}' 업무 상태를 확인하지 못했어요.`);
    const s = st.data!;
    const due = t.dueAtMs !== undefined ? ` 마감은 ${copula(formatKoreanDateTime(new Date(t.dueAtMs).toISOString(), this.tz))}.` : '';
    return {
      operationId: a.operationId,
      status: 'succeeded',
      facts: {
        resultText: `'${t.name}' 업무는 ${STATE_KO[s.itemStatus]}이고, 단계 ${s.totalStages}개 중 ${s.doneStages}개가 끝났어요.${due}`,
        itemId: t.itemId,
        ...(t.updatedAt ? { updatedAt: t.updatedAt } : {}),
        itemStatus: s.itemStatus,
        doneStages: String(s.doneStages),
        totalStages: String(s.totalStages),
        // 단계 이름·상태·마감 (단계 편집·후속 질문용, 2026-11-14)
        stages: JSON.stringify([...t.stages].sort((x, y) => (x.order ?? 0) - (y.order ?? 0)).map((x) => ({ stageId: x.stageId, name: x.name, status: x.status, ...(x.dueAtMs ? { dueAt: this.offsetIso(x.dueAtMs) } : {}) }))),
      },
      error: null,
    };
  }

  private async resolveItem(a: PipelineActionRequest, name: string | undefined, c: { deadlineAt: string }): Promise<{ task: TaskSummary } | { result: PipelineActionResult }> {
    const target = Target.safeParse(a.decision.resolvedTarget);
    const list = await this.d.eureka.listTasks({ limit: 100 }, c);
    if (!list.ok) return { result: fromError(a.operationId, list.result.error, '업무 목록을 가져오지 못했어요.') };
    const all = list.data!.items;
    if (target.success && target.data.kind === 'eureka_item') {
      const id = target.data.itemId;
      const t = all.find((x) => x.itemId === id);
      return t ? { task: t } : { result: fail(a.operationId, 'EUREKA_NOT_FOUND', `item ${id} not found`, '그 업무를 찾지 못했어요.') };
    }
    if (!name) return { result: clarify(a.operationId, { missing: 'name' }, '어떤 업무를 말씀하시는지 알려 주세요.') };
    const hits = all.filter((x) => x.name === name);
    if (hits.length === 1) return { task: hits[0]! };
    if (hits.length > 1) {
      return { result: clarify(a.operationId, { candidates: JSON.stringify(hits.map((x) => ({ itemId: x.itemId, name: x.name }))) }, `'${name}' 업무가 ${hits.length}개 있어요. 어느 것인지 알려 주세요.`) };
    }
    return { result: fail(a.operationId, 'EUREKA_NOT_FOUND', `no item named ${name}`, `'${name}' 업무를 찾지 못했어요.`) };
  }

  // ============================================================== writes
  private async register(a: PipelineEurekaActionRequest, name: string | undefined, c: { deadlineAt: string }): Promise<PipelineActionResult> {
    if (!name) return clarify(a.operationId, { missing: 'name' }, '어떤 업무를 등록할지 알려 주세요.');
    const due = parseDue(a);
    if (due === 'invalid') return clarify(a.operationId, { missing: 'dueAt' }, '마감 날짜와 시간을 다시 알려 주세요.');
    let processId = this.d.defaultProcessId;
    // 구형 형식만 task 헤드를 업무 유형 이름으로 본다. 새 형식에서 task는 업무 이름·요약이다
    const task = legacyHeads(a) ? headString(a, 'task') : undefined;
    if (task) {
      const ps = await this.d.eureka.listProcesses(c);
      const hit = ps.ok ? ps.data!.find((p) => p.name === task) : undefined;
      if (hit) processId = hit.id;
    }
    if (!processId) return fail(a.operationId, 'EUREKA_INPUT_INVALID', 'no process to register the item with (set defaultProcessId)', '어떤 업무 유형으로 등록할지 정해지지 않아 등록하지 않았어요.');
    const when = due !== undefined ? formatKoreanDateTime(new Date(due).toISOString(), this.tz) : undefined;
    if (!a.mutationApproved) return confirm(a.operationId, when ? `'${name}' 업무를 마감 ${ro(when)} 새로 등록할까요?` : `'${name}' 업무를 새로 등록할까요?`);
    return this.write(a, 'register_item', { kind: 'eureka_workspace' }, { processId, name, ...(due !== undefined ? { dueAtMs: due } : {}) }, (h) =>
      this.d.eureka.registerItem({ processId: processId!, name, ...(due !== undefined ? { dueAtMs: due } : {}) }, h, c),
      { ok: `'${name}' 업무를 등록했어요.`, what: `'${name}' 업무 등록` },
    );
  }

  private async processes(a: PipelineActionRequest, c: { deadlineAt: string }): Promise<PipelineActionResult> {
    const ps = await this.d.eureka.listProcesses(c);
    if (!ps.ok) return fromError(a.operationId, ps.result.error, '업무 유형 목록을 가져오지 못했어요.');
    const names = ps.data!.map((p) => p.name).filter(Boolean);
    const text = names.length ? `등록할 수 있는 업무 유형은 ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` 외 ${names.length - 5}개` : ''}예요.` : '등록할 수 있는 업무 유형이 없어요.';
    return { operationId: a.operationId, status: 'succeeded', facts: { resultText: text, count: String(names.length), processes: JSON.stringify(ps.data!.slice(0, 20)) }, error: null };
  }

  /**
   * 단계 기록 추가 (라우터 add_note). 기록 내용은 note 헤드. 단계는 name 헤드(구형은 stage·checkpoint) 이름과 같은 단계,
   * 없으면 진행 중인 단계 → 첫 미완료 단계 → 마지막 단계 순으로 고른다. 쓰기라 확인을 거친다 (mutationApproved)
   */
  private async addNote(a: PipelineEurekaActionRequest, t: TaskSummary, c: { deadlineAt: string }): Promise<PipelineActionResult> {
    const content = headString(a, 'note');
    if (!content) return clarify(a.operationId, { missing: 'note', itemId: t.itemId }, `'${t.name}' 업무에 어떤 내용을 기록할까요?`);
    if (content.length > 2_000) return clarify(a.operationId, { missing: 'note', itemId: t.itemId }, '기록 내용이 너무 길어요. 조금 줄여서 말씀해 주세요.');
    const wanted = stageNameOf(a);
    const stages = [...t.stages].sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
    const stage = wanted
      ? stages.find((s) => s.name === wanted)
      : (stages.find((s) => s.status === 'doing') ?? stages.find((s) => s.status === 'todo') ?? stages[stages.length - 1]);
    if (!stage) {
      return wanted
        ? clarify(a.operationId, { missing: 'stage', itemId: t.itemId }, `'${t.name}' 업무에서 '${wanted}' 단계를 찾지 못했어요. 어느 단계에 남길까요?`)
        : fail(a.operationId, 'EUREKA_NOT_FOUND', 'item has no stages', `'${t.name}' 업무에는 기록을 남길 단계가 없어요.`);
    }
    if (!a.mutationApproved) return confirm(a.operationId, `'${t.name}' 업무의 '${stage.name}' 단계에 "${content}"라고 기록을 남길까요?`, { itemId: t.itemId, stageId: stage.stageId });
    const target = { kind: 'eureka_stage' as const, itemId: t.itemId, stageId: stage.stageId };
    return this.write(a, 'add_stage_note', target, { itemId: t.itemId, stageId: stage.stageId, stageName: stage.name, contentLength: content.length, contentDigest: digest(content) }, (h) => this.d.eureka.addStageNote({ operationId: a.operationId, stageId: stage.stageId, content }, h, c), {
      ok: `'${stage.name}' 단계에 기록을 남겼어요.`,
      what: `'${stage.name}' 단계 기록 추가`,
    });
  }

  /**
   * 단계 상태 변경 (2026-11-14): 시작 → doing, 되돌리기 → todo, 건너뛰기 → skip, update_stage는 말한 상태(task·note 헤드의 낱말)로.
   * 단계 이름(name 헤드)이 없으면 시작은 첫 대기 단계, 되돌리기는 진행 중 단계, 건너뛰기는 진행 중 → 첫 대기 단계
   */
  private async stageStatus(a: PipelineEurekaActionRequest, kind: StageOp, t: TaskSummary, c: { deadlineAt: string }): Promise<PipelineActionResult> {
    if (t.computedState === 'hold') return fail(a.operationId, 'POLICY_BLOCKED', 'item on hold', `'${t.name}' 업무가 보류 중이라 단계를 바꾸지 않았어요. 먼저 다시 진행해 주세요.`);
    const status: 'todo' | 'doing' | 'done' | 'skip' | undefined = kind === 'stage:start' ? 'doing' : kind === 'stage:reset' ? 'todo' : kind === 'stage:skip' ? 'skip' : statusWordOf(a);
    if (!status) return clarify(a.operationId, { missing: 'status', itemId: t.itemId }, `'${t.name}' 업무의 단계를 어떤 상태로 바꿀까요? (시작·완료·건너뛰기·대기)`);
    const stages = [...t.stages].sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
    const wanted = stageNameOf(a);
    const stage = wanted
      ? stages.find((s) => s.name === wanted)
      : status === 'doing'
        ? stages.find((s) => s.status === 'todo')
        : status === 'todo'
          ? stages.find((s) => s.status === 'doing')
          : (stages.find((s) => s.status === 'doing') ?? stages.find((s) => s.status === 'todo'));
    if (!stage) {
      return wanted
        ? clarify(a.operationId, { missing: 'stage', itemId: t.itemId }, `'${t.name}' 업무에서 '${wanted}' 단계를 찾지 못했어요. 어느 단계인가요?`)
        : clarify(a.operationId, { missing: 'stage', itemId: t.itemId }, `'${t.name}' 업무의 어느 단계를 바꿀까요?`);
    }
    if (stage.status === status) return fail(a.operationId, 'POLICY_BLOCKED', 'stage already in that status', `'${stage.name}' 단계는 이미 ${STAGE_WORD[status]} 상태예요. 바꾸지 않았어요.`);
    const verb = status === 'doing' ? '시작할까요?' : status === 'todo' ? '대기로 되돌릴까요?' : status === 'skip' ? '건너뛸까요?' : '완료로 처리할까요?';
    if (!a.mutationApproved) return confirm(a.operationId, `'${t.name}' 업무의 '${stage.name}' 단계를 ${verb}`, { itemId: t.itemId, stageId: stage.stageId });
    const target = { kind: 'eureka_stage' as const, itemId: t.itemId, stageId: stage.stageId };
    const done = status === 'doing' ? '시작했어요' : status === 'todo' ? '대기로 되돌렸어요' : status === 'skip' ? '건너뛰었어요' : '완료로 처리했어요';
    return this.write(a, 'set_stage_status', target, { itemId: t.itemId, stageId: stage.stageId, stageName: stage.name, from: stage.status, status }, (h) => this.d.eureka.setStageStatus({ stageId: stage.stageId, status }, h, c), {
      ok: `'${stage.name}' 단계를 ${done}.`,
      what: `'${stage.name}' 단계 상태 변경`,
    });
  }

  /**
   * 단계 목록 편집 (2026-11-14): 추가(name·task 헤드 = 새 단계 이름, dueAt 헤드 = 단계 마감, 끝에 붙임)·삭제·순서 위/아래·단계 마감.
   * Eureka API는 단계 목록 전체를 받으므로, 지금 목록을 그대로 두고 바꿀 곳만 고쳐 보낸다. 단계 값을 다 읽지 못했으면 보내지 않는다
   */
  private async stageList(a: PipelineEurekaActionRequest, kind: StageListOp | 'stages:due', t: TaskSummary, c: { deadlineAt: string }): Promise<PipelineActionResult> {
    const stages = [...t.stages].sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
    if (stages.some((s) => !s.edit)) return fail(a.operationId, 'POLICY_BLOCKED', 'stage fields incomplete', `'${t.name}' 업무의 단계 정보를 다 읽지 못해서 바꾸지 않았어요.`);
    const list: StageEdit[] = stages.map((s) => ({ id: s.stageId, name: s.name, actorId: s.edit!.actorId, toolId: s.edit!.toolId, dueAt: s.dueAtMs ?? 0, guideText: s.edit!.guideText, isRequired: s.edit!.isRequired }));
    const wanted = stageNameOf(a);
    const idx = wanted ? stages.findIndex((s) => s.name === wanted) : -1;
    const due = parseDue(a);
    if (due === 'invalid') return clarify(a.operationId, { missing: 'dueAt', itemId: t.itemId }, '마감 날짜와 시간을 다시 알려 주세요.');
    let question: string;
    let ok: string;
    let what: string;

    if (kind === 'stages:add') {
      const name = wanted ?? headString(a, 'task');
      if (!name) return clarify(a.operationId, { missing: 'stage', itemId: t.itemId }, `'${t.name}' 업무에 어떤 단계를 추가할까요?`);
      if (stages.some((s) => s.name === name)) return fail(a.operationId, 'POLICY_BLOCKED', 'stage exists', `'${t.name}' 업무에는 이미 '${name}' 단계가 있어요. 추가하지 않았어요.`);
      list.push({ name, actorId: '', toolId: '', dueAt: due ?? 0, guideText: '', isRequired: true });
      const when = due !== undefined ? ` 마감은 ${copula(formatKoreanDateTime(new Date(due).toISOString(), this.tz))}.` : '';
      question = `'${t.name}' 업무 끝에 '${name}' 단계를 추가할까요?${when}`;
      ok = `'${name}' 단계를 추가했어요.`;
      what = `'${name}' 단계 추가`;
    } else {
      if (!wanted) return clarify(a.operationId, { missing: 'stage', itemId: t.itemId }, `'${t.name}' 업무의 어느 단계인가요?`);
      if (idx < 0) return clarify(a.operationId, { missing: 'stage', itemId: t.itemId }, `'${t.name}' 업무에서 '${wanted}' 단계를 찾지 못했어요. 어느 단계인가요?`);
      if (kind === 'stages:delete') {
        if (stages.length === 1) return fail(a.operationId, 'POLICY_BLOCKED', 'last stage', `'${wanted}'는 '${t.name}' 업무의 마지막 하나 남은 단계라 지우지 않았어요.`);
        list.splice(idx, 1);
        question = `'${t.name}' 업무의 '${wanted}' 단계를 삭제할까요? 단계 기록도 함께 사라질 수 있고 되돌릴 수 없어요.`;
        ok = `'${wanted}' 단계를 삭제했어요.`;
        what = `'${wanted}' 단계 삭제`;
      } else if (kind === 'stages:up' || kind === 'stages:down') {
        const to = kind === 'stages:up' ? idx - 1 : idx + 1;
        if (to < 0 || to >= list.length) return fail(a.operationId, 'POLICY_BLOCKED', 'no room to move', `'${wanted}' 단계는 이미 맨 ${kind === 'stages:up' ? '처음' : '끝'}이에요. 바꾸지 않았어요.`);
        [list[idx], list[to]] = [list[to]!, list[idx]!];
        question = `'${wanted}' 단계를 '${list[idx]!.name}' 단계 ${kind === 'stages:up' ? '앞으로' : '뒤로'} 옮길까요?`;
        ok = `'${wanted}' 단계를 ${to + 1}번째로 옮겼어요.`;
        what = `'${wanted}' 단계 순서 변경`;
      } else {
        if (due === undefined) return clarify(a.operationId, { missing: 'dueAt', itemId: t.itemId }, `'${wanted}' 단계 마감을 언제로 바꿀까요?`);
        list[idx] = { ...list[idx]!, dueAt: due };
        const when = formatKoreanDateTime(new Date(due).toISOString(), this.tz);
        question = `'${t.name}' 업무의 '${wanted}' 단계 마감을 ${ro(when)} 바꿀까요?`;
        ok = `'${wanted}' 단계 마감을 ${ro(when)} 바꿨어요.`;
        what = `'${wanted}' 단계 마감 변경`;
      }
    }
    if (!a.mutationApproved) return confirm(a.operationId, question, { itemId: t.itemId });
    const target = { kind: 'eureka_item' as const, itemId: t.itemId };
    return this.write(a, 'edit_stages', target, { itemId: t.itemId, stageNames: list.map((s) => s.name), stageDue: list.map((s) => s.dueAt) }, (h) => this.d.eureka.replaceStages({ itemId: t.itemId, stages: list }, h, c), { ok, what });
  }

  /** 우선순위·이름 변경 (2026-11-14). 우선순위는 priority 헤드(낮음·보통·높음·긴급 또는 low~urgent), 새 이름은 task 헤드 */
  private async itemField(a: PipelineEurekaActionRequest, kind: 'set_item_priority' | 'rename_item', t: TaskSummary, c: { deadlineAt: string }): Promise<PipelineActionResult> {
    const target = { kind: 'eureka_item' as const, itemId: t.itemId };
    if (kind === 'set_item_priority') {
      const p = priorityOf(headString(a, 'priority'));
      if (!p) return clarify(a.operationId, { missing: 'priority', itemId: t.itemId }, `'${t.name}' 업무 우선순위를 무엇으로 바꿀까요? (낮음·보통·높음·긴급)`);
      if (t.priority === p) return fail(a.operationId, 'POLICY_BLOCKED', 'same priority', `'${t.name}' 업무는 이미 우선순위 ${PRIORITY_WORD[p]}이에요. 바꾸지 않았어요.`);
      if (!a.mutationApproved) return confirm(a.operationId, `'${t.name}' 업무 우선순위를 ${ro(PRIORITY_WORD[p])} 바꿀까요?`, { itemId: t.itemId, priority: p });
      return this.write(a, kind, target, { itemId: t.itemId, priority: p }, (h) => this.d.eureka.updateItemField({ itemId: t.itemId, field: 'priority', value: p }, h, c), {
        ok: `'${t.name}' 업무 우선순위를 ${ro(PRIORITY_WORD[p])} 바꿨어요.`,
        what: `'${t.name}' 업무 우선순위 변경`,
      });
    }
    const name = headString(a, 'task');
    if (!name || name === t.name) return clarify(a.operationId, { missing: 'task', itemId: t.itemId }, `'${t.name}' 업무 이름을 무엇으로 바꿀까요?`);
    if (name.length > 200) return clarify(a.operationId, { missing: 'task', itemId: t.itemId }, '새 이름이 너무 길어요. 조금 줄여서 말씀해 주세요.');
    if (!a.mutationApproved) return confirm(a.operationId, `'${t.name}' 업무 이름을 ${ro(`'${name}'`)} 바꿀까요?`, { itemId: t.itemId, name });
    return this.write(a, kind, target, { itemId: t.itemId, name }, (h) => this.d.eureka.updateItemField({ itemId: t.itemId, field: 'name', value: name }, h, c), {
      ok: `업무 이름을 ${ro(`'${name}'`)} 바꿨어요.`,
      what: `'${t.name}' 업무 이름 변경`,
    });
  }

  private async itemWrite(a: PipelineEurekaActionRequest, kind: 'postpone_item' | 'complete_item' | 'delete_item' | 'hold_item' | 'resume_item', t: TaskSummary, c: { deadlineAt: string }): Promise<PipelineActionResult> {
    const target = { kind: 'eureka_item' as const, itemId: t.itemId };
    if (kind === 'hold_item' || kind === 'resume_item') {
      const hold = kind === 'hold_item';
      if (t.computedState === 'done') return fail(a.operationId, 'POLICY_BLOCKED', 'item already done', `'${t.name}' 업무는 이미 완료돼 있어서 ${hold ? '보류' : '재개'}하지 않았어요.`);
      if (hold && t.computedState === 'hold') return fail(a.operationId, 'POLICY_BLOCKED', 'item already on hold', `'${t.name}' 업무는 이미 보류 중이에요. 바꾸지 않았어요.`);
      if (!hold && t.computedState !== 'hold') return fail(a.operationId, 'POLICY_BLOCKED', 'item not on hold', `'${t.name}' 업무는 보류 중이 아니에요. 바꾸지 않았어요.`);
      // 재개: 시작한 단계가 있으면 진행 중, 아니면 시작 전으로 되돌린다
      const status = hold ? 'hold' : t.stages.some((s) => s.status === 'doing' || s.status === 'done') ? 'doing' : 'todo';
      if (!a.mutationApproved) return confirm(a.operationId, hold ? `'${t.name}' 업무를 보류할까요?` : `'${t.name}' 업무를 다시 진행할까요?`, { itemId: t.itemId });
      return this.write(a, kind, target, { itemId: t.itemId, status }, (h) => this.d.eureka.setItemStatus({ itemId: t.itemId, status }, h, c), {
        ok: hold ? `'${t.name}' 업무를 보류했어요.` : `'${t.name}' 업무를 다시 진행 중으로 바꿨어요.`,
        what: `'${t.name}' 업무 ${hold ? '보류' : '재개'}`,
      });
    }
    if (kind === 'delete_item') {
      // 되돌릴 수 없으므로 질문에 그렇게 말한다. 완료된 업무도 지울 수 있다 (시연 업무 정리 등)
      if (!a.mutationApproved) return confirm(a.operationId, `'${t.name}' 업무를 삭제할까요? 삭제하면 되돌릴 수 없어요.`, { itemId: t.itemId });
      return this.write(a, kind, target, { itemId: t.itemId, itemName: t.name }, (h) => this.d.eureka.deleteItem({ itemId: t.itemId }, h, c), {
        ok: `'${t.name}' 업무를 삭제했어요.`,
        what: `'${t.name}' 업무 삭제`,
      });
    }
    if (kind === 'postpone_item') {
      const due = parseDue(a);
      if (due === undefined || due === 'invalid') return clarify(a.operationId, { missing: 'dueAt', itemId: t.itemId }, `'${t.name}' 업무 마감을 언제로 바꿀까요?`);
      const when = formatKoreanDateTime(new Date(due).toISOString(), this.tz);
      if (!a.mutationApproved) return confirm(a.operationId, `'${t.name}' 업무 마감을 ${ro(when)} 바꿀까요?`, { itemId: t.itemId, dueAt: this.offsetIso(due) });
      return this.write(a, kind, target, { itemId: t.itemId, dueAtMs: due }, (h) => this.d.eureka.postponeItem({ itemId: t.itemId, dueAtMs: due }, h, c), {
        ok: `'${t.name}' 업무 마감을 ${ro(when)} 바꿨어요.`,
        what: `'${t.name}' 업무 마감 변경`,
      });
    }
    if (t.computedState === 'done') return fail(a.operationId, 'POLICY_BLOCKED', 'item already done', `'${t.name}' 업무는 이미 완료돼 있어요. 바꾸지 않았어요.`);
    if (!a.mutationApproved) return confirm(a.operationId, `'${t.name}' 업무 전체를 완료로 처리할까요?`, { itemId: t.itemId });
    return this.write(a, kind, target, { itemId: t.itemId }, (h) => this.d.eureka.completeItem({ itemId: t.itemId }, h, c), {
      ok: `'${t.name}' 업무를 완료로 처리했어요.`,
      what: `'${t.name}' 업무 완료 처리`,
    });
  }

  /** operation 기록 → DurableAck → 전송 → 증거 기록. 응답 유실이면 unknown + recovery=needed (재전송 없음) */
  private async write(
    a: PipelineEurekaActionRequest,
    action: DirectWrite,
    target: Target,
    request: Record<string, unknown>,
    call: (h: ReturnType<StoreDispatchOwner['handleFor']>) => Promise<GatewayResult>,
    text: { ok: string; what: string },
  ): Promise<PipelineActionResult> {
    const prepared = await this.owner.prepareOperation({
      owner: 'pipeline_eureka_module',
      requestId: a.requestId,
      action,
      target,
      isWrite: true,
      expectedOutcome: expectedOutcomeFor(action, target),
      checkRuleVersion: DEFAULT_POLICY.checkRuleVersion,
      actualRequest: { ...request, pipelineOperationId: a.operationId, requestFingerprint: fingerprintOf(a), deadlineAt: a.deadlineAt, mutationApproved: true },
      priorEvidence: {},
      holderId: '',
    });
    if (!prepared.ok) return fail(a.operationId, 'STORAGE_RESERVATION_FAILED', prepared.reason, '기록 공간 문제로 실행하지 않았어요.');
    const op = prepared.operation;
    const g = await call(this.owner.handleFor(prepared.authority, op.operationId));
    const linked = g.outcome === 'response' && g.dispatchState === 'sent' && !g.error && g.externalRefs.length > 0;
    const status: 'succeeded' | 'failed' | 'unknown' = g.dispatchState === 'not_sent' ? 'failed' : g.outcome === 'no_response' ? 'unknown' : g.error ? 'failed' : linked ? 'succeeded' : 'unknown';
    const ar = {
      operationId: op.operationId,
      action,
      target,
      status,
      dispatchState: g.dispatchState,
      facts: { ...(g.response ?? {}) },
      externalRefs: g.externalRefs,
      observedAt: this.d.clock.nowIso(),
      ...(g.error ? { error: g.error } : {}),
    } as const;
    await this.d.store.appendEvidence(op.operationId, {
      attemptId: prepared.authority.attemptId,
      ...(g.dispatchState === 'not_sent' ? { attemptDispatchState: 'not_sent' as const, notSentProof: g.notSentProof ?? 'gateway_not_sent' } : { attemptDispatchState: g.dispatchState }),
      responseEvidence: { ...(g.response ?? {}), outcome: g.outcome },
      phase: g.outcome === 'response' ? 'response_received' : 'stopped',
      assessment: 'assessed',
      recovery: status === 'unknown' ? 'needed' : 'none',
      actionResult: ar,
      releaseAuthority: true,
    });
    const stored = (await this.d.store.getOperation(op.operationId))!;
    const out = await this.fromOperation(stored, a.operationId);
    const sentence =
      status === 'succeeded'
        ? text.ok
        : status === 'unknown'
          ? `${text.what} 결과를 아직 확인하지 못했어요. 다시 보내지 않고 상태를 확인할게요.`
          : /writes disabled/.test(g.error?.message ?? '')
            ? `쓰기가 꺼져 있어서 ${text.what} 요청은 보내지 않았어요.`
            : `${text.what}을 하지 못했어요.`;
    return { ...out, facts: { ...out.facts, resultText: sentence } };
  }

  // ============================================================== mapping
  private async findByPipelineOp(requestId: string, pipelineOperationId: string): Promise<OperationRecord | undefined> {
    return (await this.d.store.listOperations(requestId)).find((o) => o.owner === 'pipeline_eureka_module' && o.actualRequest['pipelineOperationId'] === pipelineOperationId);
  }

  private async fromOperation(op: OperationRecord, operationId: string): Promise<PipelineActionResult> {
    const ar = op.actionResult;
    const facts: Record<string, string> = { [K.harnessOperationId]: op.operationId, [K.action]: op.action };
    if (!ar) return { operationId, status: 'unknown', facts: { ...facts, phase: op.executionPhase }, error: perr('IN_PROGRESS', 'operation has no result yet', operationId) };
    facts[K.dispatchState] = ar.dispatchState;
    if (op.target.kind === 'eureka_item') facts['itemId'] = op.target.itemId;
    if (op.target.kind === 'eureka_stage') Object.assign(facts, { itemId: op.target.itemId, stageId: op.target.stageId });
    // 업무 등록: 새 업무 ID를 항상 facts.itemId로 준다 (응답에 ID가 없으면 결과 미확인으로 남아 있다)
    const newItem = ar.externalRefs.find((r) => r.kind === 'item')?.id;
    if (newItem) facts['itemId'] = newItem;
    const noteId = ar.externalRefs.find((r) => r.kind === 'stage_note')?.id;
    if (noteId) facts['noteId'] = noteId;
    const due = op.actualRequest['dueAtMs'];
    if (typeof due === 'number') facts['dueAt'] = this.offsetIso(due);
    return { operationId, status: ar.status, facts, error: ar.error ? toError(ar.error, operationId) : null };
  }

  private toReminder(t: TaskSummary): PipelineReminderItem | null {
    if (!t.description || t.dueAtMs === undefined) return null;
    const dueAt = this.offsetIso(t.dueAtMs);
    return { itemId: t.itemId, reminderKey: `${t.itemId}:${dueAt}`, name: t.name, description: t.description, dueAt, timezone: this.tz, state: t.computedState };
  }

  /** 밀리초 epoch → 시간대 오프셋을 붙인 ISO (예: 2026-09-28T23:59:00+09:00) */
  offsetIso(ms: number): string {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: this.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'longOffset' }).formatToParts(new Date(ms));
    const g = (k: string) => parts.find((p) => p.type === k)?.value ?? '';
    const off = g('timeZoneName').replace('GMT', '') || '+00:00';
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}:${g('second')}${off}`;
  }
}

/** 받침에 맞춰 '로'/'으로'를 붙인다 (ㄹ 받침은 '로') */
/** 이에요/예요: 받침이 있으면 '이에요' (예: 9시예요, 30분이에요) */
function copula(word: string): string {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  return `${word}${c >= 0 && c <= 11171 && c % 28 !== 0 ? '이에요' : '예요'}`;
}

function ro(word: string): string {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  if (c < 0 || c > 11171) return `${word}로`;
  const jong = c % 28;
  return `${word}${jong === 0 || jong === 8 ? '로' : '으로'}`;
}

const STATE_KO: Record<string, string> = { todo: '시작 전', doing: '진행 중', done: '완료', hold: '보류' };

/** 요청 지문: 작업 종류·대상·값. 같은 operationId 재요청이 같은 요청인지 본다 (mutationApproved·deadline은 제외) */
function fingerprintOf(a: PipelineActionRequest): string {
  const keys = ['target', 'name', 'checkpoint', 'dueAt', 'task', 'note', 'stage', 'priority'];
  const heads = Object.fromEntries(keys.map((k) => [k, a.decision.headOutputs[k]?.value ?? null]));
  return digest(JSON.stringify({ op: operationOf(a), heads, target: a.decision.resolvedTarget ?? null }));
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * 헤드 의미 (wiki interface-contracts 2026-11-01): target = 업무 원문, name = 단계 원문, checkpoint = 체크포인트 원문,
 * task = 이름·요약(생성), note = 설명(생성). 구형 형식(modelIntention 헤드 없음)은 name을 업무 이름으로 본다.
 */
function legacyHeads(a: PipelineActionRequest): boolean {
  return a.decision.headOutputs['modelIntention'] === undefined;
}
function itemNameOf(a: PipelineActionRequest): string | undefined {
  return headString(a, 'target') ?? (legacyHeads(a) ? headString(a, 'name') : undefined);
}
/** 새 업무 이름: task(이름·요약) → target. 구형은 name */
function newItemNameOf(a: PipelineActionRequest): string | undefined {
  return legacyHeads(a) ? (headString(a, 'name') ?? headString(a, 'target')) : (headString(a, 'task') ?? headString(a, 'target'));
}
/** 단계 이름: 새 형식은 name, 구형은 stage·checkpoint */
function stageNameOf(a: PipelineActionRequest): string | undefined {
  return legacyHeads(a) ? (headString(a, 'stage') ?? headString(a, 'checkpoint')) : headString(a, 'name');
}

const STAGE_WORD: Record<string, string> = { todo: '대기', doing: '진행 중', done: '완료', skip: '건너뜀' };
/** update_stage: task·note 헤드에 상태 낱말이 있으면 그 상태 */
function statusWordOf(a: PipelineActionRequest): 'todo' | 'doing' | 'done' | 'skip' | undefined {
  const t = `${headString(a, 'task') ?? ''} ${headString(a, 'note') ?? ''} ${headString(a, 'status') ?? ''}`;
  if (/건너|스킵|skip/i.test(t)) return 'skip';
  if (/완료|끝|done/i.test(t)) return 'done';
  if (/대기|되돌|취소|todo/i.test(t)) return 'todo';
  if (/시작|진행|doing/i.test(t)) return 'doing';
  return undefined;
}

const PRIORITY_WORD: Record<'low' | 'normal' | 'high' | 'urgent', string> = { low: '낮음', normal: '보통', high: '높음', urgent: '긴급' };
function priorityOf(v: string | undefined): 'low' | 'normal' | 'high' | 'urgent' | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase();
  if (['low', '낮음', '낮게', '낮은'].includes(s) || s.startsWith('낮')) return 'low';
  if (['normal', 'medium', '보통', '중간'].includes(s) || s.startsWith('보통')) return 'normal';
  if (['urgent', '긴급', '급함', '매우 높음'].includes(s) || s.startsWith('긴급')) return 'urgent';
  if (['high', '높음', '높게', '높은'].includes(s) || s.startsWith('높')) return 'high';
  return undefined;
}

function headString(a: PipelineActionRequest, key: string): string | undefined {
  const v = a.decision.headOutputs[key]?.value;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** dueAt 헤드: 시간대가 있는 ISO만 받는다. 없으면 undefined, 형식 오류는 'invalid' */
function parseDue(a: PipelineActionRequest): number | undefined | 'invalid' {
  const v = headString(a, 'dueAt');
  if (!v) return undefined;
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(v)) return 'invalid';
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? 'invalid' : ms;
}

function perr(code: string, message: string, operationId: string, retryable = false): PipelineError {
  return { code, message, retryable, operationId, stage: 'eureka' };
}

function toError(e: ErrorInfo, operationId: string): PipelineError {
  return { code: e.provisionalCode, message: e.message, retryable: e.nextAction === 'bounded_read_retry', operationId, stage: e.stage };
}

function fail(operationId: string, code: string, message: string, resultText: string): PipelineActionResult {
  return { operationId, status: 'failed', facts: { resultText }, error: perr(code, message, operationId) };
}

function fromError(operationId: string, e: ErrorInfo | undefined, resultText: string): PipelineActionResult {
  return { operationId, status: 'failed', facts: { resultText }, error: e ? toError(e, operationId) : perr('EUREKA_SERVER_ERROR', 'read failed', operationId) };
}

function clarify(operationId: string, facts: Record<string, string>, question: string): PipelineActionResult {
  return { operationId, status: 'needs_clarification', facts: { ...facts, [K.questionKind]: 'clarification', question }, error: null };
}

/** 쓰기 전 사용자 확인 질문. 파이프라인이 묻고, 승인이면 같은 내용으로 mutationApproved=true를 보낸다 */
function confirm(operationId: string, question: string, facts: Record<string, string> = {}): PipelineActionResult {
  return { operationId, status: 'needs_clarification', facts: { ...facts, [K.questionKind]: 'confirmation', question }, error: null };
}
