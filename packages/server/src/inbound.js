import { mapHarnessResult } from '@deskpet/output';
export class DirectHarnessInbound {
    d;
    kinds;
    /** bridge가 있으면 파이프라인 문서 형식(harness.run / harness.reconcile / output.generate)도 받는다 */
    constructor(d) {
        this.d = d;
        const base = ['harness.request', 'harness.resume', 'pipeline.event', 'harness.cancel', 'output.from_result', 'output.request'];
        this.kinds = new Set([
            ...base,
            ...(d.bridge ? ['harness.run', 'harness.reconcile', 'output.generate'] : []),
            ...(d.eurekaBridge ? EUREKA_KINDS : []),
        ]);
    }
    async dispatch(env) {
        switch (env.kind) {
            case 'harness.request':
                return { kind: 'harness.result', payload: await this.d.harness.handle(env.payload) };
            case 'harness.resume':
                return { kind: 'harness.result', payload: await this.d.harness.resume(env.payload) };
            case 'pipeline.event':
                return { kind: 'pipeline.event.result', payload: await this.d.harness.onPipelineEvent(env.payload) };
            case 'harness.cancel':
                return { kind: 'harness.cancel.result', payload: await this.d.harness.cancel(env.payload) };
            case 'output.from_result':
                return { kind: 'output.content', payload: await this.d.output.generate(mapHarnessResult(env.payload)) };
            case 'output.request':
                return { kind: 'output.content', payload: await this.d.output.generate(env.payload) };
            case 'harness.run':
                if (!this.d.bridge)
                    throw new UnsupportedKindError(env.kind);
                return { kind: 'harness.run.result', payload: await this.d.bridge.run(env.payload) };
            case 'harness.reconcile':
                if (!this.d.bridge)
                    throw new UnsupportedKindError(env.kind);
                return { kind: 'action.result', payload: await this.d.bridge.reconcile(env.payload) };
            case 'output.generate':
                if (!this.d.bridge)
                    throw new UnsupportedKindError(env.kind);
                return { kind: 'output.text', payload: await this.d.bridge.generateDetailed(env.payload) };
            case 'eureka.execute':
            case 'eureka.reconcile':
            case 'eureka.reminders':
            case 'eureka.reminder':
            case 'eureka.links':
                if (!this.d.eurekaBridge)
                    throw new UnsupportedKindError(env.kind);
                return dispatchEureka(this.d.eurekaBridge, env);
            default:
                throw new UnsupportedKindError(env.kind);
        }
    }
}
export const EUREKA_KINDS = ['eureka.execute', 'eureka.reconcile', 'eureka.reminders', 'eureka.reminder', 'eureka.links'];
/**
 * Eureka 전용 입구 (wiki deskpet-pipeline §4 "Eureka 내부 API 분리"). Harness와 다른 프로세스에서 직접 Eureka 요청만 받는다.
 * 같은 deskpet.harness.v1 봉투·메시지 형식을 그대로 쓰므로 파이프라인은 주소(포트)만 바꾸면 된다.
 */
export class EurekaInbound {
    bridge;
    kinds = new Set(EUREKA_KINDS);
    constructor(bridge) {
        this.bridge = bridge;
    }
    dispatch(env) {
        if (!this.kinds.has(env.kind))
            throw new UnsupportedKindError(env.kind);
        return dispatchEureka(this.bridge, env);
    }
}
async function dispatchEureka(bridge, env) {
    switch (env.kind) {
        case 'eureka.execute':
            return { kind: 'action.result', payload: await bridge.execute(env.payload) };
        case 'eureka.reconcile':
            return { kind: 'action.result', payload: await bridge.reconcile(env.payload) };
        case 'eureka.reminders':
            return { kind: 'eureka.reminders.result', payload: await bridge.reminders(readDeadline(env)) };
        case 'eureka.reminder': {
            const p = env.payload;
            return { kind: 'eureka.reminder.result', payload: { item: await bridge.reminder(p.itemId, readDeadline(env)) } };
        }
        case 'eureka.links': {
            const p = env.payload;
            return { kind: 'eureka.links.result', payload: await bridge.links(p.itemId, readDeadline(env)) };
        }
        default:
            throw new UnsupportedKindError(env.kind);
    }
}
export class UnsupportedKindError extends Error {
    kind;
    constructor(kind) {
        super(`kind ${kind} is not accepted by this server`);
        this.kind = kind;
    }
}
/** 읽기 요청 deadline: 봉투 deadline이 없으면 10초 */
function readDeadline(env) {
    return env.deadlineAt ?? new Date(Date.now() + 10_000).toISOString();
}
