export class RecoveryWorker {
    o;
    timer;
    running;
    /** operationId → 다음 확인 가능 시각·지금까지 확인 횟수 (메모리. 재시작하면 바로 다시 확인한다) */
    backoff = new Map();
    seq = 0;
    constructor(o) {
        this.o = o;
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => void this.tick(), this.o.intervalMs ?? 30_000);
        this.timer.unref?.();
    }
    async stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        await this.running;
    }
    /** 지금 한 번 확인한다. 이미 도는 중이면 그 결과를 기다린다 */
    tick() {
        if (!this.running)
            this.running = this.runOnce().finally(() => (this.running = undefined));
        return this.running;
    }
    async runOnce() {
        const report = { checked: 0, resolved: 0, stillUnknown: 0, skippedBackoff: 0 };
        const now = this.o.clock.nowMs();
        const all = await this.o.store.listOperations();
        const due = all.filter((op) => op.owner === 'harness' && !op.currentExecutionAuthority && (op.recovery === 'needed' || op.assessment === 'pending'));
        // 오래 기다린 작업부터 (기록 순서)
        for (const op of due) {
            if (report.checked >= (this.o.maxPerTick ?? 5))
                break;
            const b = this.backoff.get(op.operationId);
            if (b && now < b.nextAtMs) {
                report.skippedBackoff += 1;
                continue;
            }
            report.checked += 1;
            const done = await this.check(op).catch((e) => {
                this.o.log?.(`복구 확인 오류 ${op.operationId}: ${e instanceof Error ? e.message : String(e)}`);
                return false;
            });
            if (done) {
                report.resolved += 1;
                this.backoff.delete(op.operationId);
            }
            else {
                report.stillUnknown += 1;
                const tries = (b?.tries ?? 0) + 1;
                const base = this.o.baseBackoffMs ?? this.o.intervalMs ?? 30_000;
                this.backoff.set(op.operationId, { tries, nextAtMs: now + Math.min(base * 2 ** (tries - 1), this.o.maxBackoffMs ?? 600_000) });
            }
        }
        // 끝났거나 사라진 작업의 기록은 지운다
        const live = new Set(due.map((x) => x.operationId));
        for (const id of this.backoff.keys())
            if (!live.has(id))
                this.backoff.delete(id);
        return report;
    }
    /** true면 확정(알림 보냄) */
    async check(op) {
        const sys = `recovery-${this.o.clock.nowMs().toString(36)}-${++this.seq}`;
        if (op.assessment === 'pending') {
            const r = await this.o.harness.reassess(op.operationId, sys);
            if (r.status !== 'assessed' || !r.actionResult)
                return false;
            if (r.actionResult.status === 'unknown')
                return false; // 판정은 됐지만 외부 결과 불명 → 다음 tick에서 reconcile
            await this.o.harness.notifyRecovered((await this.o.store.getOperation(op.operationId)) ?? op, r.actionResult);
            return true;
        }
        const deadlineAt = new Date(this.o.clock.nowMs() + (this.o.checkDeadlineMs ?? 15_000)).toISOString();
        const r = await this.o.harness.reconcile(op.operationId, sys, { deadlineAt });
        if (r.status !== 'resolved' || !r.actionResult) {
            if (r.recovery === 'blocked')
                this.o.log?.(`복구 상한 도달 ${op.operationId} (${op.action}) — recovery=blocked, 운영 조치 필요`);
            return false;
        }
        await this.o.harness.notifyRecovered((await this.o.store.getOperation(op.operationId)) ?? op, r.actionResult);
        return true;
    }
}
