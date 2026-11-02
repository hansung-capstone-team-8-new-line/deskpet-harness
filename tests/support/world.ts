import type { FollowUpNotice, HarnessResult, LlmClient, PipelineEvent } from '@deskpet/contracts';
import { EurekaGateway, FakeEurekaServer, GitHubReviewGateway, type FakePr, type OperatorConfirm } from '@deskpet/gateways';
import { DEFAULT_POLICY, FakeClock, HarnessService, InMemoryOperationStore, SequentialIdGen, type PolicyConfig, type Sensor, type WikiReader } from '@deskpet/harness';
import { OutputService, mapHarnessResult } from '@deskpet/output';
import { ITEM_ID, STAGE_ID, T0 } from './builders.js';
import { fakeGitHub, goldenPr } from './github.js';

/**
 * fake Gateway 기반 테스트 환경. 파이프라인 역할(질문 전달 이벤트)은 테스트가 흉내 낸다.
 */
export function createWorld(opts: { githubMode?: 'rest' | 'mcp'; config?: Partial<PolicyConfig>; pr?: FakePr; requiredChecksFallback?: Record<string, string[]>; sensor?: Sensor; llm?: LlmClient; durablePath?: string; operatorConfirm?: OperatorConfirm; wiki?: WikiReader; onFollowUp?: (n: FollowUpNotice) => void } = {}) {
  const clock = new FakeClock(T0);
  const ids = new SequentialIdGen();
  const config = { ...DEFAULT_POLICY, ...opts.config };
  const storeOpts = {
    clock,
    ids,
    capacityBytes: config.storeCapacityBytes,
    recoveryBudgetBytes: config.recoveryBudgetBytes,
    minRetentionMs: config.minRetentionMs,
    maxRecoveryAttempts: config.maxRecoveryAttempts,
  };
  // durablePath가 있으면 실제 SQLite 파일을 쓰고, restart()는 파일을 닫고 다시 연다 (같은 ids 객체라 ID가 겹치지 않음)
  const openStore = () => (opts.durablePath ? InMemoryOperationStore.openDurable(opts.durablePath, storeOpts) : new InMemoryOperationStore(storeOpts));
  let store = openStore();
  const github = fakeGitHub(opts.githubMode ?? 'rest', () => clock.nowMs(), opts.pr ?? goldenPr());
  const eurekaServer = new FakeEurekaServer(() => clock.nowMs());
  eurekaServer.addItem({
    id: ITEM_ID,
    name: '캡스톤 PR 검토',
    dueAt: clock.nowMs() + 40 * 60_000,
    priority: 'high',
    stages: [
      { id: '1000037', name: '변경 확인', status: 'done', order: 1 },
      { id: STAGE_ID, name: 'PR 승인', status: 'doing', order: 2 },
    ],
  });
  const githubGw = new GitHubReviewGateway({ transport: github, now: () => clock.nowMs(), ...(opts.requiredChecksFallback ? { requiredChecksFallback: opts.requiredChecksFallback } : {}), ...(opts.operatorConfirm ? { operatorConfirm: opts.operatorConfirm } : {}) });
  const eurekaGw = new EurekaGateway({ http: eurekaServer, now: () => clock.nowMs(), allowWrites: true });
  const makeHarness = () => new HarnessService({ store, github: githubGw, eureka: eurekaGw, clock, ids, config, ...(opts.sensor ? { sensor: opts.sensor } : {}), ...(opts.llm ? { llm: opts.llm } : {}), ...(opts.wiki ? { wiki: opts.wiki } : {}), ...(opts.onFollowUp ? { onFollowUp: opts.onFollowUp } : {}) });
  let harness = makeHarness();

  const seq = new Map<string, number>();
  /** 파이프라인이 질문을 실제로 전달했다고 보고한다 */
  async function deliverQuestion(result: HarnessResult, channel: 'speech' | 'display' | 'web' = 'speech', deliveredText?: string) {
    const p = result.pending!;
    // 파이프라인은 실제로 말한 문장을 함께 보고한다. 기본값은 고정 문구 출력
    const text = deliveredText ?? (await new OutputService().generate(mapHarnessResult(result))).text;
    const n = (seq.get(result.requestId) ?? 0) + 1;
    seq.set(result.requestId, n);
    const ev: PipelineEvent = {
      messageId: `ev-${result.requestId}-${n}`,
      requestId: result.requestId,
      pendingId: p.pendingId,
      outputId: p.outputId,
      sourceRevision: n,
      occurredAt: clock.nowIso(),
      kind: 'question_delivered',
      channel,
      deliveredText: text,
    };
    const r = await harness.onPipelineEvent(ev);
    if (!r.applied) throw new Error(`delivery not applied: ${r.reason}`);
    const pending = await store.getPending(p.pendingId);
    return { pendingId: p.pendingId, revision: pending!.revision, confirmationId: p.confirmationId };
  }

  async function pipelineEvent(requestId: string, kind: PipelineEvent['kind'], extra: Partial<PipelineEvent> = {}) {
    const n = (seq.get(requestId) ?? 0) + 1;
    seq.set(requestId, n);
    return harness.onPipelineEvent({ messageId: `ev-${requestId}-${n}`, requestId, sourceRevision: n, occurredAt: clock.nowIso(), kind, ...extra });
  }

  return {
    clock,
    ids,
    get store() {
      return store;
    },
    github,
    eurekaServer,
    githubGw,
    eurekaGw,
    get harness() {
      return harness;
    },
    /** 프로세스 재시작: 영속 저장소는 유지, Harness 메모리 상태는 사라짐 */
    restart() {
      if (opts.durablePath) {
        store.close();
        store = openStore();
      } else store.simulateRestart();
      harness = makeHarness();
    },
    deliverQuestion,
    pipelineEvent,
    seq,
  };
}
