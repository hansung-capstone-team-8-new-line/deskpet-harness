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
} from '@deskpet/contracts';
import type { EurekaGateway } from '@deskpet/gateways';
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
 * - 의도 값: eureka.list / eureka.status / eureka.postpone / eureka.register / eureka.complete
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
  timezone?: string;
}

type DirectWrite = Extract<ActionName, 'register_item' | 'postpone_item' | 'complete_item'>;
const INTENTS: Record<string, 'list' | 'status' | DirectWrite> = {
  'eureka.list': 'list',
  'eureka.query': 'list',
  'eureka.status': 'status',
  'eureka.postpone': 'postpone_item',
  'eureka.update_due_date': 'postpone_item',
  'eureka.register': 'register_item',
  'eureka.create': 'register_item',
  'eureka.complete': 'complete_item',
};

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
    const intent = String(a.decision.headOutputs['intention']?.value ?? '');
    const kind = INTENTS[intent];
    if (!kind) return fail(a.operationId, 'POLICY_BLOCKED', `unsupported eureka intention: ${intent || '(none)'}`, '그 요청은 아직 처리할 수 없어요.');
    if (a.decision.missingRequiredSlots.length) {
      return clarify(a.operationId, { missing: a.decision.missingRequiredSlots.join(',') }, '필요한 정보가 빠졌어요. 어떤 업무인지 조금 더 말해 주시겠어요?');
    }

    // 같은 operationId 재요청: 다시 보내지 않고 기록된 결과를 돌려준다
    const prior = await this.findByPipelineOp(a.requestId, a.operationId);
    if (prior) return this.fromOperation(prior, a.operationId);

    const c = { deadlineAt: a.deadlineAt };
    if (kind === 'list') return this.list(a, c);

    const name = headString(a, 'name');
    if (kind === 'register_item') return this.register(a, name, c);

    const item = await this.resolveItem(a, name, c);
    if ('result' in item) return item.result;
    if (kind === 'status') return this.status(a, item.task, c);
    return this.itemWrite(a, kind, item.task, c);
  }

  // ============================================================ reconcile
  /** 결과를 모르는 직접 경로 쓰기를 조회로만 확인한다. 멱등키가 없어 일치해도 후보 수준이면 unknown을 유지한다 */
  async reconcile(a: PipelineActionRequest): Promise<PipelineActionResult> {
    const ops = (await this.d.store.listOperations(a.requestId)).filter((o) => o.owner === 'pipeline_eureka_module');
    const op = ops.find((o) => o.actualRequest['pipelineOperationId'] === a.operationId) ?? ops.find((o) => o.recovery === 'needed') ?? ops[ops.length - 1];
    if (!op) return { operationId: a.operationId, status: 'unknown', facts: {}, error: perr('RECONCILIATION_UNAVAILABLE', 'no eureka operation recorded for this request', a.operationId) };
    if (op.recovery !== 'needed' || !op.actionResult || op.actionResult.status !== 'unknown') return this.fromOperation(op, a.operationId);

    const itemId = op.target.kind === 'eureka_item' ? op.target.itemId : undefined;
    const observation: Record<string, string> = {};
    if (itemId) {
      const list = await this.d.eureka.listTasks({ limit: 100 }, { deadlineAt: a.deadlineAt });
      const t = list.ok ? list.data!.items.find((x) => x.itemId === itemId) : undefined;
      if (t) {
        observation['currentState'] = t.computedState;
        if (t.dueAtMs !== undefined) observation['currentDueAt'] = this.offsetIso(t.dueAtMs);
        const want = op.actualRequest['dueAtMs'];
        const matches = op.action === 'postpone_item' ? t.dueAtMs === want : op.action === 'complete_item' ? t.computedState === 'done' : false;
        observation['linkage'] = matches ? 'candidate_only' : 'none';
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
   * - 허용 저장소 목록·작성자 제한은 아직 없다 (사용자 결정 2026-10-24: 나중에 추가)
   */
  async links(itemId: string, deadlineAt: string): Promise<PrLinkLookup> {
    const c = { deadlineAt };
    const list = await this.d.eureka.listTasks({ limit: 100 }, c);
    if (!list.ok) return { itemId, status: 'failed', links: [], observedAt: this.d.clock.nowIso() };
    const item = list.data!.items.find((x) => x.itemId === itemId);
    if (!item) return { itemId, status: list.data!.completeness === 'complete' ? 'not_found' : 'partial', links: [], observedAt: list.data!.observedAt };
    const found = new Map<string, LinkedPr>();
    let incomplete = false;
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
          const key = `${l.owner.toLowerCase()}/${l.name.toLowerCase()}#${l.prNumber}@${st.stageId}`;
          if (!found.has(key))
            found.set(key, { repository: { owner: l.owner, name: l.name }, prNumber: l.prNumber, url: l.url, itemId, stageId: st.stageId, stageName: st.name, stageStatus: st.status, noteId: n.noteId });
        }
    }
    const links = [...found.values()];
    const status = links.length > 1 ? 'ambiguous' : incomplete ? 'partial' : links.length === 1 ? 'linked' : 'none';
    return { itemId, itemName: item.name, status, links, observedAt: this.d.clock.nowIso() };
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
    const due = t.dueAtMs !== undefined ? ` 마감은 ${formatKoreanDateTime(new Date(t.dueAtMs).toISOString(), this.tz)}이에요.` : '';
    return {
      operationId: a.operationId,
      status: 'succeeded',
      facts: {
        resultText: `'${t.name}' 업무는 ${STATE_KO[s.itemStatus]}이고, 단계 ${s.totalStages}개 중 ${s.doneStages}개가 끝났어요.${due}`,
        itemId: t.itemId,
        itemStatus: s.itemStatus,
        doneStages: String(s.doneStages),
        totalStages: String(s.totalStages),
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
    const task = headString(a, 'task');
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

  private async itemWrite(a: PipelineEurekaActionRequest, kind: 'postpone_item' | 'complete_item', t: TaskSummary, c: { deadlineAt: string }): Promise<PipelineActionResult> {
    const target = { kind: 'eureka_item' as const, itemId: t.itemId };
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
      actualRequest: { ...request, pipelineOperationId: a.operationId, deadlineAt: a.deadlineAt, mutationApproved: true },
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
function ro(word: string): string {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  if (c < 0 || c > 11171) return `${word}로`;
  const jong = c % 28;
  return `${word}${jong === 0 || jong === 8 ? '로' : '으로'}`;
}

const STATE_KO: Record<string, string> = { todo: '시작 전', doing: '진행 중', done: '완료', hold: '보류' };

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
