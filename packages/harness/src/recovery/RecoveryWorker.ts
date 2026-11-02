import type { OperationRecord } from '@deskpet/contracts';
import type { HarnessService } from '../HarnessService.js';
import type { Clock } from '../runtime/clock.js';
import type { OperationStore } from '../store/OperationStore.js';

/**
 * 주기 복구 (D-23). 요청이 끝난 뒤 남은 작업을 서버 안에서 확인한다. 외부 쓰기를 다시 보내지 않는다.
 *
 * - 결과 불명(recovery=needed): HarnessService.reconcile — 기존 결과 조회만 (S-07, S-09)
 * - 판정 대기(assessment=pending): HarnessService.reassess — 저장된 응답 증거로 센서 재검사
 * - 작업마다 다음 확인 시각을 늘려 간다 (기본 30초 → 60초 → 120초 …, 최대 10분). 확인 횟수 상한은 저장소가 관리하고
 *   상한에 닿으면 recovery=blocked로 남아 운영 조치를 기다린다 (message-contracts §Operation Record)
 * - 확정되면 HarnessService.notifyRecovered로 알린다 (파이프라인이 사용자에게 말할 수 있게). GitHub 승인이 성공으로 확정되면
 *   연결된 Eureka 단계 상태·기록을 다시 보고 반영 가능할 때만 후속 확인 질문을 함께 보낸다 (D-24)
 * - 한 번에 하나의 tick만 돈다. tick 하나에서 확인하는 작업 수에 상한이 있다
 *
 * 직접 Eureka 경로(owner=pipeline_eureka_module) 작업은 그 모듈 소유라 여기서 다루지 않는다 (Liability §Ownership).
 */
export interface RecoveryWorkerOptions {
  harness: HarnessService;
  store: OperationStore;
  clock: Clock;
  /** tick 간격(ms). 기본 30초 */
  intervalMs?: number;
  /** 작업별 첫 재확인까지 기다리는 시간(ms). 기본 intervalMs */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** tick 하나에서 확인할 작업 수 상한. 기본 5 */
  maxPerTick?: number;
  /** 작업 하나를 확인하는 시간 상한(ms). 기본 15초 */
  checkDeadlineMs?: number;
  log?: (msg: string) => void;
}

export interface RecoveryTickReport {
  checked: number;
  resolved: number;
  stillUnknown: number;
  skippedBackoff: number;
}

export class RecoveryWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<RecoveryTickReport> | undefined;
  /** operationId → 다음 확인 가능 시각·지금까지 확인 횟수 (메모리. 재시작하면 바로 다시 확인한다) */
  private readonly backoff = new Map<string, { nextAtMs: number; tries: number }>();
  private seq = 0;

  constructor(private readonly o: RecoveryWorkerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.o.intervalMs ?? 30_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** 지금 한 번 확인한다. 이미 도는 중이면 그 결과를 기다린다 */
  tick(): Promise<RecoveryTickReport> {
    if (!this.running) this.running = this.runOnce().finally(() => (this.running = undefined));
    return this.running;
  }

  private async runOnce(): Promise<RecoveryTickReport> {
    const report: RecoveryTickReport = { checked: 0, resolved: 0, stillUnknown: 0, skippedBackoff: 0 };
    const now = this.o.clock.nowMs();
    const all = await this.o.store.listOperations();
    const due = all.filter((op) => op.owner === 'harness' && !op.currentExecutionAuthority && (op.recovery === 'needed' || op.assessment === 'pending'));
    // 오래 기다린 작업부터 (기록 순서)
    for (const op of due) {
      if (report.checked >= (this.o.maxPerTick ?? 5)) break;
      const b = this.backoff.get(op.operationId);
      if (b && now < b.nextAtMs) {
        report.skippedBackoff += 1;
        continue;
      }
      report.checked += 1;
      const done = await this.check(op).catch((e: unknown) => {
        this.o.log?.(`복구 확인 오류 ${op.operationId}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      });
      if (done) {
        report.resolved += 1;
        this.backoff.delete(op.operationId);
      } else {
        report.stillUnknown += 1;
        const tries = (b?.tries ?? 0) + 1;
        const base = this.o.baseBackoffMs ?? this.o.intervalMs ?? 30_000;
        this.backoff.set(op.operationId, { tries, nextAtMs: now + Math.min(base * 2 ** (tries - 1), this.o.maxBackoffMs ?? 600_000) });
      }
    }
    // 끝났거나 사라진 작업의 기록은 지운다
    const live = new Set(due.map((x) => x.operationId));
    for (const id of this.backoff.keys()) if (!live.has(id)) this.backoff.delete(id);
    return report;
  }

  /** true면 확정(알림 보냄) */
  private async check(op: OperationRecord): Promise<boolean> {
    const sys = `recovery-${this.o.clock.nowMs().toString(36)}-${++this.seq}`;
    if (op.assessment === 'pending') {
      const r = await this.o.harness.reassess(op.operationId, sys);
      if (r.status !== 'assessed' || !r.actionResult) return false;
      if (r.actionResult.status === 'unknown') return false; // 판정은 됐지만 외부 결과 불명 → 다음 tick에서 reconcile
      await this.o.harness.notifyRecovered((await this.o.store.getOperation(op.operationId)) ?? op, r.actionResult);
      return true;
    }
    const deadlineAt = new Date(this.o.clock.nowMs() + (this.o.checkDeadlineMs ?? 15_000)).toISOString();
    const r = await this.o.harness.reconcile(op.operationId, sys, { deadlineAt });
    if (r.status !== 'resolved' || !r.actionResult) {
      if (r.recovery === 'blocked') this.o.log?.(`복구 상한 도달 ${op.operationId} (${op.action}) — recovery=blocked, 운영 조치 필요`);
      return false;
    }
    await this.o.harness.notifyRecovered((await this.o.store.getOperation(op.operationId)) ?? op, r.actionResult);
    return true;
  }
}
