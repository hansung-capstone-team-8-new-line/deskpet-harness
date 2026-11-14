import type {
  ActionResult,
  CallConstraints,
  EurekaGatewayPort,
  GatewayResult,
  SourceRef,
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
 * Harness의 기존 EurekaGateway 직접 조작 루트를 그대로 실행한다.
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
      case 'list_tasks': {
        const res = await this.eureka.listTasks(
          { onlyOpen: args['onlyOpen'] !== false, limit: typeof args['limit'] === 'number' ? args['limit'] : 20 },
          c,
        );
        const ar: ActionResult = {
          operationId: `direct-list-${input.requestId}`,
          action: 'list_tasks',
          target: { kind: 'eureka_workspace' },
          status: res.ok ? 'succeeded' : 'failed',
          dispatchState: 'sent',
          facts: { items: res.data?.items ?? [], completeness: res.data?.completeness ?? 'unknown' },
          externalRefs: [],
          observedAt: this.clock.nowIso(),
          ...(res.result.error ? { error: res.result.error } : {}),
        };
        const items = res.data?.items ?? [];
        const summaryText = res.ok
          ? items.length > 0
            ? `현재 열려 있는 Eureka 업무가 ${items.length}건 있어요. (${items
                .slice(0, 3)
                .map((i) => i.name)
                .join(', ')})`
            : '현재 열려 있는 Eureka 업무가 없어요.'
          : 'Eureka 업무 목록을 조회하지 못했어요.';
        return {
          ok: res.ok,
          actionResults: [ar],
          facts: { directEureka: { operation: 'list_tasks', ok: res.ok, items, summaryText } },
          sources: [{ kind: 'eureka', ref: 'eureka:items/list', observedAt: ar.observedAt }],
        };
      }

      case 'list_processes': {
        if (!this.eureka.listProcesses) {
          return {
            ok: false,
            actionResults: [],
            facts: { directEureka: { operation: 'list_processes', ok: false, unsupported: true } },
            sources: [],
          };
        }
        const res = await this.eureka.listProcesses(c);
        const ar: ActionResult = {
          operationId: `direct-proc-${input.requestId}`,
          action: 'list_processes',
          target: { kind: 'eureka_workspace' },
          status: res.ok ? 'succeeded' : 'failed',
          dispatchState: 'sent',
          facts: { processes: res.data ?? [] },
          externalRefs: [],
          observedAt: this.clock.nowIso(),
          ...(res.result.error ? { error: res.result.error } : {}),
        };
        const processes = res.data ?? [];
        return {
          ok: res.ok,
          actionResults: [ar],
          facts: {
            directEureka: {
              operation: 'list_processes',
              ok: res.ok,
              processes,
              summaryText: res.ok
                ? `Eureka 프로세스 템플릿 ${processes.length}건을 확인했어요.`
                : 'Eureka 프로세스 목록을 조회하지 못했어요.',
            },
          },
          sources: [{ kind: 'eureka', ref: 'eureka:processes/list', observedAt: ar.observedAt }],
        };
      }

      case 'get_task_state': {
        const itemId = await this.resolveItemId(args, c);
        if (!itemId) {
          return {
            ok: false,
            actionResults: [],
            facts: {},
            sources: [],
            clarifyQuestion: '상태를 확인할 Eureka 업무 이름을 정확히 알려주시겠어요?',
          };
        }
        const stageId = typeof args['stageId'] === 'string' ? args['stageId'] : undefined;
        const res = await this.eureka.getTaskState({ itemId, ...(stageId ? { stageId } : {}) }, c);
        const ar: ActionResult = {
          operationId: `direct-state-${input.requestId}`,
          action: 'get_task_state',
          target: stageId ? { kind: 'eureka_stage', itemId, stageId } : { kind: 'eureka_item', itemId },
          status: res.ok ? 'succeeded' : 'failed',
          dispatchState: 'sent',
          facts: { ...(res.data ?? {}) },
          externalRefs: [],
          observedAt: this.clock.nowIso(),
          ...(res.result.error ? { error: res.result.error } : {}),
        };
        return {
          ok: res.ok,
          actionResults: [ar],
          facts: { directEureka: { operation: 'get_task_state', state: res.data } },
          sources: [{ kind: 'eureka', ref: `eureka:item/${itemId}`, observedAt: ar.observedAt }],
        };
      }

      case 'register_item': {
        if (!this.eureka.registerItem) {
          return this.unsupportedWrite(op);
        }
        const name = stringArg(args, 'name') ?? stringArg(args, 'itemName');
        if (!name) {
          return {
            ok: false,
            actionResults: [],
            facts: {},
            sources: [],
            clarifyQuestion: '새로 등록할 Eureka 업무의 이름을 알려주시겠어요?',
          };
        }
        let processId = stringArg(args, 'processId');
        if (!processId && this.eureka.listProcesses) {
          const procs = await this.eureka.listProcesses(c);
          const procName = stringArg(args, 'processName');
          const matched = procName
            ? procs.data?.find((p) => p.name.toLowerCase().includes(procName.toLowerCase()))
            : procs.data?.[0];
          processId = matched?.id;
        }
        if (!processId) {
          return {
            ok: false,
            actionResults: [],
            facts: {},
            sources: [],
            clarifyQuestion: '어느 Eureka 프로세스 템플릿으로 업무를 생성할지 알려주시겠어요?',
          };
        }
        const dueAtMs = parseDueAtMs(args);
        const target = { kind: 'eureka_workspace' as const };
        return this.runDirectWrite(
          input,
          'register_item',
          target,
          { name, processId, ...(dueAtMs !== undefined ? { dueAtMs } : {}) },
          (handle) =>
            this.eureka.registerItem!(
              { processId, name, ...(dueAtMs !== undefined ? { dueAtMs } : {}) },
              handle,
              c,
            ),
        );
      }

      case 'postpone_item': {
        if (!this.eureka.postponeItem) return this.unsupportedWrite(op);
        const itemId = await this.resolveItemId(args, c);
        const dueAtMs = parseDueAtMs(args);
        if (!itemId || dueAtMs === undefined) {
          return {
            ok: false,
            actionResults: [],
            facts: {},
            sources: [],
            clarifyQuestion: !itemId
              ? '기한을 미룰 Eureka 업무를 알려주시겠어요?'
              : '변경할 목표 마감 일시를 알려주시겠어요?',
          };
        }
        const target = { kind: 'eureka_item' as const, itemId };
        return this.runDirectWrite(
          input,
          'postpone_item',
          target,
          { itemId, dueAtMs },
          (handle) => this.eureka.postponeItem!({ itemId, dueAtMs }, handle, c),
        );
      }

      case 'complete_item': {
        if (!this.eureka.completeItem) return this.unsupportedWrite(op);
        const itemId = await this.resolveItemId(args, c);
        if (!itemId) {
          return {
            ok: false,
            actionResults: [],
            facts: {},
            sources: [],
            clarifyQuestion: '완료 처리할 Eureka 업무 이름을 알려주시겠어요?',
          };
        }
        const target = { kind: 'eureka_item' as const, itemId };
        return this.runDirectWrite(
          input,
          'complete_item',
          target,
          { itemId },
          (handle) => this.eureka.completeItem!({ itemId }, handle, c),
        );
      }
    }
  }

  private async resolveItemId(args: Record<string, unknown>, c: CallConstraints): Promise<string | undefined> {
    const direct = stringArg(args, 'itemId');
    if (direct) return direct;
    const itemName = stringArg(args, 'itemName') ?? stringArg(args, 'name');
    if (!itemName) return undefined;
    const list = await this.eureka.listTasks({ onlyOpen: true, limit: 50 }, c);
    const hit = list.data?.items.find((i) => i.name.toLowerCase().includes(itemName.toLowerCase()));
    return hit?.itemId;
  }

  private async runDirectWrite(
    input: DirectEurekaExecInput,
    action: 'register_item' | 'postpone_item' | 'complete_item',
    target: { kind: 'eureka_workspace' } | { kind: 'eureka_item'; itemId: string },
    actualRequest: Record<string, unknown>,
    fn: (handle: ReturnType<StoreDispatchOwner['handleFor']>) => Promise<GatewayResult>,
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
        facts: { directEureka: { operation: action, error: prep.reason } },
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
    const itemName = typeof actualRequest['name'] === 'string' ? actualRequest['name'] : undefined;
    const summaryText =
      action === 'register_item'
        ? ok
          ? `Eureka에 '${itemName ?? '새 업무'}' 업무를 등록했어요.`
          : `Eureka에 '${itemName ?? '새 업무'}' 업무를 등록하지 못했어요.`
        : action === 'postpone_item'
          ? ok
            ? 'Eureka 업무의 마감 일시를 변경했어요.'
            : 'Eureka 업무의 마감 일시를 변경하지 못했어요.'
          : ok
            ? 'Eureka 업무를 완료로 처리했어요.'
            : 'Eureka 업무 완료 처리에 실패했어요.';
    return {
      ok,
      actionResults: [ar],
      facts: { directEureka: { operation: action, ok, status, response: g.response ?? {}, summaryText } },
      sources: [{ kind: 'eureka', ref: `eureka:${action}`, observedAt: ar.observedAt }],
    };
  }

  private unsupportedWrite(op: string): DirectEurekaExecOutcome {
    return {
      ok: false,
      actionResults: [],
      facts: { directEureka: { operation: op, unsupported: true } },
      sources: [],
    };
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
