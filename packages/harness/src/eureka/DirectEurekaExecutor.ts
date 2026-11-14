import type {
  ActionResult,
  CallConstraints,
  DirectEurekaAction,
  EurekaGatewayPort,
  GatewayResult,
  SourceRef,
  Target,
  TaskSummary,
  TriageResult,
} from '@deskpet/contracts';
import type { StoreDispatchOwner } from '../dispatch/DispatchOwner.js';
import type { Clock } from '../runtime/clock.js';
import type { OperationStore } from '../store/OperationStore.js';
import { expectedOutcomeFor } from '../policy/expectedOutcome.js';

export interface DirectEurekaExecInput {
  requestId: string;
  triage: TriageResult;
  constraints: CallConstraints;
  holderId: string;
}

export interface DirectEurekaExecOutcome {
  ok: boolean;
  actionResults: ActionResult[];
  facts: Record<string, unknown>;
  sources: SourceRef[];
  clarifyQuestion?: string;
}

/**
 * Router `unclear` → `IntentTriage`가 유레카 프로세스 조작(`direct_eureka`)으로 분류했을 때
 * Harness의 EurekaGateway 직접 조작 루트를 통해 조회·쓰기 전 기능을 실행한다.
 */
export class DirectEurekaExecutor {
  constructor(
    private readonly eureka: EurekaGatewayPort,
    private readonly store: OperationStore,
    private readonly owner: StoreDispatchOwner,
    private readonly clock: Clock,
  ) {}

  async execute(input: DirectEurekaExecInput): Promise<DirectEurekaExecOutcome> {
    const op = input.triage.eurekaOperation ?? 'list_tasks';
    const args = input.triage.eurekaArgs ?? {};
    const c = input.constraints;

    switch (op) {
      case 'list_tasks':
        return this.execListTasks(input.requestId, args, c);
      case 'list_processes':
        return this.execListProcesses(input.requestId, c);
      case 'check_session':
        return this.execCheckSession(input.requestId, c);
      case 'get_task_state':
        return this.execGetTaskState(input.requestId, args, c);
      case 'register_item':
        return this.execRegisterItem(input, args, c);
      case 'postpone_item':
        return this.execPostponeItem(input, args, c);
      case 'complete_item':
      case 'delete_item':
      case 'hold_item':
      case 'resume_item':
        return this.execItemLifecycle(input, op, args, c);
      case 'set_item_priority':
      case 'rename_item':
        return this.execItemField(input, op, args, c);
      case 'set_stage_status':
        return this.execStageStatus(input, args, c);
      case 'add_stage':
      case 'delete_stage':
      case 'move_stage_up':
      case 'move_stage_down':
        return this.execEditStages(input, op, args, c);
      case 'add_stage_note':
        return this.execAddStageNote(input, args, c);
    }
  }

  private async execListTasks(requestId: string, args: Record<string, unknown>, c: CallConstraints): Promise<DirectEurekaExecOutcome> {
    const res = await this.eureka.listTasks(
      { onlyOpen: args['onlyOpen'] !== false, limit: typeof args['limit'] === 'number' ? args['limit'] : 20 },
      c,
    );
    const items = res.data?.items ?? [];
    const ar = this.readAction(`direct-list-${requestId}`, 'list_tasks', { kind: 'eureka_workspace' }, res.ok, {
      items,
      completeness: res.data?.completeness ?? 'unknown',
    }, res.result.error);
    const summaryText = res.ok
      ? items.length > 0
        ? `현재 열려 있는 Eureka 업무가 ${items.length}건 있어요. (${items.slice(0, 3).map((i) => i.name).join(', ')})`
        : '현재 열려 있는 Eureka 업무가 없어요.'
      : 'Eureka 업무 목록을 조회하지 못했어요.';
    return {
      ok: res.ok,
      actionResults: [ar],
      facts: { directEureka: { operation: 'list_tasks', ok: res.ok, items, summaryText } },
      sources: [{ kind: 'eureka', ref: 'eureka:items/list', observedAt: ar.observedAt }],
    };
  }

  private async execListProcesses(requestId: string, c: CallConstraints): Promise<DirectEurekaExecOutcome> {
    if (!this.eureka.listProcesses) return this.unsupported('list_processes');
    const res = await this.eureka.listProcesses(c);
    const processes = res.data ?? [];
    const ar = this.readAction(`direct-proc-${requestId}`, 'list_processes', { kind: 'eureka_workspace' }, res.ok, { processes }, res.result.error);
    return {
      ok: res.ok,
      actionResults: [ar],
      facts: {
        directEureka: {
          operation: 'list_processes',
          ok: res.ok,
          processes,
          summaryText: res.ok ? `Eureka 프로세스 템플릿 ${processes.length}건을 확인했어요.` : 'Eureka 프로세스 목록을 조회하지 못했어요.',
        },
      },
      sources: [{ kind: 'eureka', ref: 'eureka:processes/list', observedAt: ar.observedAt }],
    };
  }

  private async execCheckSession(requestId: string, c: CallConstraints): Promise<DirectEurekaExecOutcome> {
    if (!this.eureka.checkSession) return this.unsupported('check_session');
    const res = await this.eureka.checkSession(c);
    const ar = this.readAction(`direct-sess-${requestId}`, 'list_tasks', { kind: 'eureka_workspace' }, res.ok, { ...(res.data ?? {}) }, res.result.error);
    const summaryText = res.ok && res.data
      ? `현재 Eureka 워크스페이스 세션(${res.data.sid})을 확인했어요.`
      : 'Eureka 워크스페이스 세션을 확인하지 못했어요.';
    return {
      ok: res.ok,
      actionResults: [ar],
      facts: { directEureka: { operation: 'check_session', ok: res.ok, session: res.data, summaryText } },
      sources: [{ kind: 'eureka', ref: 'eureka:session', observedAt: ar.observedAt }],
    };
  }

  private async execGetTaskState(requestId: string, args: Record<string, unknown>, c: CallConstraints): Promise<DirectEurekaExecOutcome> {
    const item = await this.resolveItem(args, c);
    if (!item) return this.clarify('상태를 확인할 Eureka 업무 이름을 정확히 알려주시겠어요?');
    const stageId = stringArg(args, 'stageId');
    const res = await this.eureka.getTaskState({ itemId: item.itemId, ...(stageId ? { stageId } : {}) }, c);
    const target: Target = stageId ? { kind: 'eureka_stage', itemId: item.itemId, stageId } : { kind: 'eureka_item', itemId: item.itemId };
    const ar = this.readAction(`direct-state-${requestId}`, 'get_task_state', target, res.ok, { ...(res.data ?? {}) }, res.result.error);
    const state = res.data;
    const summaryText = res.ok && state
      ? `'${item.name}' 업무 상태는 ${state.itemStatus}이고 단계 ${state.totalStages}개 중 ${state.doneStages}개가 완료됐어요.`
      : 'Eureka 업무 상태를 조회하지 못했어요.';
    return {
      ok: res.ok,
      actionResults: [ar],
      facts: { directEureka: { operation: 'get_task_state', ok: res.ok, state, summaryText } },
      sources: [{ kind: 'eureka', ref: `eureka:item/${item.itemId}`, observedAt: ar.observedAt }],
    };
  }

  private async execRegisterItem(input: DirectEurekaExecInput, args: Record<string, unknown>, c: CallConstraints): Promise<DirectEurekaExecOutcome> {
    if (!this.eureka.registerItem) return this.unsupported('register_item');
    const name = stringArg(args, 'name') ?? stringArg(args, 'itemName');
    if (!name) return this.clarify('새로 등록할 Eureka 업무의 이름을 알려주시겠어요?');

    let processId = stringArg(args, 'processId');
    if (!processId && this.eureka.listProcesses) {
      const procs = await this.eureka.listProcesses(c);
      const procName = stringArg(args, 'processName');
      const matched = procName
        ? procs.data?.find((p) => p.name.toLowerCase().includes(procName.toLowerCase()))
        : procs.data?.[0];
      processId = matched?.id;
    }
    if (!processId) return this.clarify('어느 Eureka 프로세스 템플릿으로 업무를 생성할지 알려주시겠어요?');

    const dueAtMs = parseDueAtMs(args);
    const priority = parsePriority(args['priority']);
    return this.runDirectWrite(
      input,
      'register_item',
      'register_item',
      { kind: 'eureka_workspace' },
      { name, processId, ...(dueAtMs !== undefined ? { dueAtMs } : {}), ...(priority ? { priority } : {}) },
      (handle) => this.eureka.registerItem!({ processId, name, ...(dueAtMs !== undefined ? { dueAtMs } : {}), ...(priority ? { priority } : {}) }, handle, c),
      (ok) => (ok ? `Eureka에 '${name}' 업무를 등록했어요.` : `Eureka에 '${name}' 업무를 등록하지 못했어요.`),
    );
  }

  private async execPostponeItem(input: DirectEurekaExecInput, args: Record<string, unknown>, c: CallConstraints): Promise<DirectEurekaExecOutcome> {
    if (!this.eureka.postponeItem) return this.unsupported('postpone_item');
    const item = await this.resolveItem(args, c);
    const dueAtMs = parseDueAtMs(args);
    if (!item || dueAtMs === undefined) {
      return this.clarify(!item ? '기한을 미룰 Eureka 업무를 알려주시겠어요?' : '변경할 목표 마감 일시를 알려주시겠어요?');
    }
    return this.runDirectWrite(
      input,
      'postpone_item',
      'postpone_item',
      { kind: 'eureka_item', itemId: item.itemId },
      { itemId: item.itemId, dueAtMs },
      (handle) => this.eureka.postponeItem!({ itemId: item.itemId, dueAtMs }, handle, c),
      (ok) => (ok ? `'${item.name}' 업무의 마감 일시를 변경했어요.` : `'${item.name}' 업무의 마감 일시를 변경하지 못했어요.`),
    );
  }

  private async execItemLifecycle(
    input: DirectEurekaExecInput,
    op: 'complete_item' | 'delete_item' | 'hold_item' | 'resume_item',
    args: Record<string, unknown>,
    c: CallConstraints,
  ): Promise<DirectEurekaExecOutcome> {
    const item = await this.resolveItem(args, c, op === 'resume_item' ? false : true);
    if (!item) return this.clarify('대상 Eureka 업무 이름을 알려주시겠어요?');
    const target: Target = { kind: 'eureka_item', itemId: item.itemId };
    const labels: Record<typeof op, [string, string]> = {
      complete_item: [`'${item.name}' 업무를 완료로 처리했어요.`, `'${item.name}' 업무 완료 처리에 실패했어요.`],
      delete_item: [`'${item.name}' 업무를 삭제했어요.`, `'${item.name}' 업무를 삭제하지 못했어요.`],
      hold_item: [`'${item.name}' 업무를 보류로 변경했어요.`, `'${item.name}' 업무를 보류하지 못했어요.`],
      resume_item: [`'${item.name}' 업무를 다시 진행 상태로 전환했어요.`, `'${item.name}' 업무 재개에 실패했어요.`],
    };

    if (op === 'complete_item') {
      if (!this.eureka.completeItem) return this.unsupported(op);
      const actorId = stringArg(args, 'actorId');
      return this.runDirectWrite(input, op, op, target, { itemId: item.itemId }, (h) => this.eureka.completeItem!({ itemId: item.itemId, ...(actorId ? { actorId } : {}) }, h, c), (ok) => labels[op][ok ? 0 : 1]);
    }
    if (op === 'delete_item') {
      if (!this.eureka.deleteItem) return this.unsupported(op);
      return this.runDirectWrite(input, op, op, target, { itemId: item.itemId }, (h) => this.eureka.deleteItem!({ itemId: item.itemId }, h, c), (ok) => labels[op][ok ? 0 : 1]);
    }
    if (!this.eureka.setItemStatus) return this.unsupported(op);
    const status = op === 'hold_item' ? 'hold' : 'doing';
    return this.runDirectWrite(input, op, op, target, { itemId: item.itemId, status }, (h) => this.eureka.setItemStatus!({ itemId: item.itemId, status }, h, c), (ok) => labels[op][ok ? 0 : 1]);
  }

  private async execItemField(
    input: DirectEurekaExecInput,
    op: 'set_item_priority' | 'rename_item',
    args: Record<string, unknown>,
    c: CallConstraints,
  ): Promise<DirectEurekaExecOutcome> {
    if (!this.eureka.updateItemField) return this.unsupported(op);
    const item = await this.resolveItem(args, c);
    if (!item) return this.clarify('수정할 Eureka 업무 이름을 알려주시겠어요?');
    const field = op === 'set_item_priority' ? 'priority' : 'name';
    const rawValue = op === 'set_item_priority' ? parsePriority(args['priority']) : (stringArg(args, 'newName') ?? stringArg(args, 'value') ?? stringArg(args, 'title'));
    if (!rawValue) {
      return this.clarify(op === 'set_item_priority' ? '어떤 우선순위(긴급·높음·보통·낮음)로 바꿀까요?' : '새 업무 이름을 알려주시겠어요?');
    }
    return this.runDirectWrite(
      input,
      op,
      op,
      { kind: 'eureka_item', itemId: item.itemId },
      { itemId: item.itemId, field, value: rawValue },
      (h) => this.eureka.updateItemField!({ itemId: item.itemId, field, value: rawValue }, h, c),
      (ok) => (ok ? `'${item.name}' 업무 정보를 변경했어요.` : `'${item.name}' 업무 정보를 변경하지 못했어요.`),
    );
  }

  private async execStageStatus(input: DirectEurekaExecInput, args: Record<string, unknown>, c: CallConstraints): Promise<DirectEurekaExecOutcome> {
    if (!this.eureka.setStageStatus) return this.unsupported('set_stage_status');
    const resolved = await this.resolveStage(args, c);
    if ('clarify' in resolved) return this.clarify(resolved.clarify);
    const status = parseStageStatus(args['status']) ?? 'done';
    return this.runDirectWrite(
      input,
      'set_stage_status',
      'set_stage_status',
      { kind: 'eureka_stage', itemId: resolved.item.itemId, stageId: resolved.stageId },
      { itemId: resolved.item.itemId, stageId: resolved.stageId, status },
      (h) => this.eureka.setStageStatus!({ stageId: resolved.stageId, status }, h, c),
      (ok) => (ok ? `'${resolved.stageName}' 단계 상태를 변경했어요.` : `'${resolved.stageName}' 단계 상태를 변경하지 못했어요.`),
    );
  }

  private async execEditStages(
    input: DirectEurekaExecInput,
    op: 'add_stage' | 'delete_stage' | 'move_stage_up' | 'move_stage_down',
    args: Record<string, unknown>,
    c: CallConstraints,
  ): Promise<DirectEurekaExecOutcome> {
    if (!this.eureka.replaceStages || !this.eureka.getItem) return this.unsupported(op);
    const item = await this.resolveItem(args, c);
    if (!item) return this.clarify('단계를 편집할 Eureka 업무를 알려주시겠어요?');
    const fresh = await this.eureka.getItem(item.itemId, c);
    if (!fresh.ok || !fresh.data) return this.unsupported(op);
    const stages = [...fresh.data.stages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const list: { id?: string; name: string; actorId: string; toolId: string; dueAt: number; guideText: string; isRequired: boolean }[] = stages.map((s) => ({
      id: s.stageId,
      name: s.name,
      actorId: s.edit?.actorId ?? '',
      toolId: s.edit?.toolId ?? '',
      dueAt: s.dueAtMs ?? 0,
      guideText: s.edit?.guideText ?? '',
      isRequired: s.edit?.isRequired ?? true,
    }));
    const target: Target = { kind: 'eureka_item', itemId: item.itemId };
    const stageName = stringArg(args, 'stageName') ?? stringArg(args, 'newStageName');

    if (op === 'add_stage') {
      if (!stageName) return this.clarify('추가할 단계 이름을 알려주시겠어요?');
      list.push({ name: stageName, actorId: '', toolId: '', dueAt: parseDueAtMs(args) ?? 0, guideText: '', isRequired: true });
      return this.runDirectWrite(input, op, 'edit_stages', target, { itemId: item.itemId, stageName }, (h) => this.eureka.replaceStages!({ itemId: item.itemId, stages: list }, h, c), (ok) => (ok ? `'${stageName}' 단계를 추가했어요.` : `'${stageName}' 단계를 추가하지 못했어요.`));
    }

    const idx = stageName ? stages.findIndex((s) => s.name.toLowerCase().includes(stageName.toLowerCase())) : (stringArg(args, 'stageId') ? stages.findIndex((s) => s.stageId === stringArg(args, 'stageId')) : -1);
    if (idx < 0) return this.clarify('대상 단계 이름을 정확히 알려주시겠어요?');
    const chosen = stages[idx]!;

    if (op === 'delete_stage') {
      if (!this.eureka.deleteStage) return this.unsupported(op);
      return this.runDirectWrite(input, op, 'edit_stages', target, { itemId: item.itemId, stageId: chosen.stageId }, (h) => this.eureka.deleteStage!({ itemId: item.itemId, stageId: chosen.stageId }, h, c), (ok) => (ok ? `'${chosen.name}' 단계를 삭제했어요.` : `'${chosen.name}' 단계를 삭제하지 못했어요.`));
    }

    const to = op === 'move_stage_up' ? idx - 1 : idx + 1;
    if (to < 0 || to >= list.length) {
      return { ok: false, actionResults: [], facts: { directEureka: { operation: op, ok: false, summaryText: `'${chosen.name}' 단계를 더 옮길 수 없어요.` } }, sources: [] };
    }
    [list[idx], list[to]] = [list[to]!, list[idx]!];
    return this.runDirectWrite(input, op, 'edit_stages', target, { itemId: item.itemId, stageId: chosen.stageId }, (h) => this.eureka.replaceStages!({ itemId: item.itemId, stages: list }, h, c), (ok) => (ok ? `'${chosen.name}' 단계 순서를 변경했어요.` : `'${chosen.name}' 단계 순서를 변경하지 못했어요.`));
  }

  private async execAddStageNote(input: DirectEurekaExecInput, args: Record<string, unknown>, c: CallConstraints): Promise<DirectEurekaExecOutcome> {
    if (!this.eureka.addStageNote) return this.unsupported('add_stage_note');
    const resolved = await this.resolveStage(args, c);
    if ('clarify' in resolved) return this.clarify(resolved.clarify);
    const content = stringArg(args, 'content') ?? stringArg(args, 'note');
    if (!content) return this.clarify('단계에 남길 기록 내용을 알려주시겠어요?');
    return this.runDirectWrite(
      input,
      'add_stage_note',
      'add_stage_note',
      { kind: 'eureka_stage', itemId: resolved.item.itemId, stageId: resolved.stageId },
      { itemId: resolved.item.itemId, stageId: resolved.stageId, content },
      (h) => this.eureka.addStageNote!({ operationId: h.operationId, stageId: resolved.stageId, content }, h, c),
      (ok) => (ok ? `'${resolved.stageName}' 단계에 기록을 추가했어요.` : `'${resolved.stageName}' 단계 기록 추가에 실패했어요.`),
    );
  }

  private async resolveItem(args: Record<string, unknown>, c: CallConstraints, onlyOpen = true): Promise<TaskSummary | undefined> {
    const direct = stringArg(args, 'itemId');
    const list = await this.eureka.listTasks({ onlyOpen, limit: 50 }, c);
    const items = list.data?.items ?? [];
    if (direct) return items.find((i) => i.itemId === direct) ?? { itemId: direct, name: stringArg(args, 'itemName') ?? stringArg(args, 'name') ?? direct, computedState: 'doing', stages: [] };
    const itemName = stringArg(args, 'itemName') ?? stringArg(args, 'name');
    if (!itemName) return undefined;
    return items.find((i) => i.name.toLowerCase().includes(itemName.toLowerCase()));
  }

  private async resolveStage(args: Record<string, unknown>, c: CallConstraints): Promise<{ item: TaskSummary; stageId: string; stageName: string } | { clarify: string }> {
    const item = await this.resolveItem(args, c);
    if (!item) return { clarify: '대상 Eureka 업무를 먼저 알려주시겠어요?' };
    const directStageId = stringArg(args, 'stageId');
    const stageName = stringArg(args, 'stageName') ?? stringArg(args, 'stage');
    const st = directStageId
      ? item.stages.find((s) => s.stageId === directStageId)
      : stageName
        ? item.stages.find((s) => s.name.toLowerCase().includes(stageName.toLowerCase()))
        : item.stages.find((s) => s.status === 'doing') ?? item.stages[0];
    if (!st) return { clarify: `'${item.name}' 업무의 어느 단계를 대상으로 할지 알려주시겠어요?` };
    return { item, stageId: st.stageId, stageName: st.name };
  }

  private async runDirectWrite(
    input: DirectEurekaExecInput,
    operationLabel: string,
    action: DirectEurekaAction,
    target: Target,
    actualRequest: Record<string, unknown>,
    fn: (handle: ReturnType<StoreDispatchOwner['handleFor']>) => Promise<GatewayResult>,
    formatSummary: (ok: boolean) => string,
  ): Promise<DirectEurekaExecOutcome> {
    const prep = await this.store.reserveAndPrepare({
      owner: 'harness',
      requestId: input.requestId,
      action,
      target,
      isWrite: true,
      expectedOutcome: expectedOutcomeFor(action, target),
      checkRuleVersion: 'rules-0.1',
      actualRequest: { ...actualRequest, directEureka: true },
      priorEvidence: {},
      holderId: input.holderId,
    });
    if (!prep.ok) {
      return {
        ok: false,
        actionResults: [],
        facts: { directEureka: { operation: operationLabel, error: prep.reason } },
        sources: [],
      };
    }
    const g = await fn(this.owner.handleFor(prep.authority, prep.operation.operationId));
    const status = g.outcome === 'response' ? 'succeeded' : g.outcome === 'error' ? 'failed' : 'unknown';
    const ar: ActionResult = {
      operationId: prep.operation.operationId,
      action,
      target,
      status,
      dispatchState: status === 'unknown' && g.dispatchState === 'not_sent' ? 'may_have_been_sent' : g.dispatchState,
      facts: g.response ?? {},
      externalRefs: g.externalRefs,
      observedAt: this.clock.nowIso(),
      ...(g.error ? { error: g.error } : {}),
    };
    await this.store.appendEvidence(prep.operation.operationId, {
      attemptId: prep.authority.attemptId,
      ...(g.dispatchState === 'not_sent'
        ? { attemptDispatchState: 'not_sent' as const, notSentProof: g.notSentProof ?? 'gateway_not_sent' }
        : { attemptDispatchState: g.dispatchState }),
      responseEvidence: g.response ?? {},
      phase: g.outcome === 'response' ? 'response_received' : 'stopped',
      assessment: 'assessed',
      recovery: status === 'unknown' ? 'needed' : 'none',
      actionResult: ar,
      releaseAuthority: true,
    });
    const ok = status === 'succeeded';
    return {
      ok,
      actionResults: [ar],
      facts: { directEureka: { operation: operationLabel, ok, status, response: g.response ?? {}, summaryText: formatSummary(ok) } },
      sources: [{ kind: 'eureka', ref: `eureka:${operationLabel}`, observedAt: ar.observedAt }],
    };
  }

  private readAction(operationId: string, action: ActionResult['action'], target: Target, ok: boolean, facts: Record<string, unknown>, error?: GatewayResult['error']): ActionResult {
    return {
      operationId,
      action,
      target,
      status: ok ? 'succeeded' : 'failed',
      dispatchState: 'sent',
      facts,
      externalRefs: [],
      observedAt: this.clock.nowIso(),
      ...(error ? { error } : {}),
    };
  }

  private clarify(clarifyQuestion: string): DirectEurekaExecOutcome {
    return { ok: false, actionResults: [], facts: {}, sources: [], clarifyQuestion };
  }

  private unsupported(op: string): DirectEurekaExecOutcome {
    return { ok: false, actionResults: [], facts: { directEureka: { operation: op, unsupported: true } }, sources: [] };
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function parseDueAtMs(args: Record<string, unknown>): number | undefined {
  if (typeof args['dueAtMs'] === 'number' && Number.isFinite(args['dueAtMs'])) return args['dueAtMs'];
  if (typeof args['dueAtIso'] === 'string') {
    const ms = Date.parse(args['dueAtIso']);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

function parsePriority(v: unknown): 'low' | 'normal' | 'high' | 'urgent' | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'low' || s === '낮음') return 'low';
  if (s === 'normal' || s === '보통') return 'normal';
  if (s === 'high' || s === '높음') return 'high';
  if (s === 'urgent' || s === '긴급') return 'urgent';
  return undefined;
}

function parseStageStatus(v: unknown): 'todo' | 'doing' | 'done' | 'skip' | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'todo' || s === 'doing' || s === 'done' || s === 'skip') return s;
  if (s === '시작' || s === '진행') return 'doing';
  if (s === '완료') return 'done';
  if (s === '건너뛰기' || s === '스킵') return 'skip';
  if (s === '되돌리기' || s === '초기화') return 'todo';
  return undefined;
}
