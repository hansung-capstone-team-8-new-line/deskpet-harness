import type { Envelope, HarnessResult } from '@deskpet/contracts';
import type { HarnessService } from '@deskpet/harness';
import { OutputService, mapHarnessResult } from '@deskpet/output';
import type { EurekaBridge } from './eurekaBridge.js';
import type { PipelineBridge } from './pipelineBridge.js';

/**
 * 수신 변환 층: Envelope → HarnessService·OutputService 호출.
 * 지금은 현재 Harness 입력을 그대로 전달한다. 파이프라인 형식이 정해지면 여기서 변환한다 (서버·Harness는 그대로).
 * 전송(WebSocket)과 분리되어 있어 gRPC 등 다른 transport에서도 그대로 쓸 수 있다.
 */
export interface InboundReply {
  kind: string;
  payload: unknown;
}

export interface HarnessInbound {
  readonly kinds: ReadonlySet<string>;
  dispatch(env: Envelope): Promise<InboundReply>;
}

export class DirectHarnessInbound implements HarnessInbound {
  readonly kinds: ReadonlySet<string>;

  /** bridge가 있으면 파이프라인 문서 형식(harness.run / harness.reconcile / output.generate)도 받는다 */
  constructor(private readonly d: { harness: HarnessService; output: OutputService; bridge?: PipelineBridge; eurekaBridge?: EurekaBridge }) {
    const base = ['harness.request', 'harness.resume', 'pipeline.event', 'harness.cancel', 'output.from_result', 'output.request'];
    this.kinds = new Set([
      ...base,
      ...(d.bridge ? ['harness.run', 'harness.reconcile', 'output.generate'] : []),
      ...(d.eurekaBridge ? ['eureka.execute', 'eureka.reconcile', 'eureka.reminders', 'eureka.reminder', 'eureka.links'] : []),
    ]);
  }

  async dispatch(env: Envelope): Promise<InboundReply> {
    switch (env.kind) {
      case 'harness.request':
        return { kind: 'harness.result', payload: await this.d.harness.handle(env.payload as Envelope<'harness.request'>['payload']) };
      case 'harness.resume':
        return { kind: 'harness.result', payload: await this.d.harness.resume(env.payload as Envelope<'harness.resume'>['payload']) };
      case 'pipeline.event':
        return { kind: 'pipeline.event.result', payload: await this.d.harness.onPipelineEvent(env.payload as Envelope<'pipeline.event'>['payload']) };
      case 'harness.cancel':
        return { kind: 'harness.cancel.result', payload: await this.d.harness.cancel(env.payload as Envelope<'harness.cancel'>['payload']) };
      case 'output.from_result':
        return { kind: 'output.content', payload: await this.d.output.generate(mapHarnessResult(env.payload as HarnessResult)) };
      case 'output.request':
        return { kind: 'output.content', payload: await this.d.output.generate(env.payload as Envelope<'output.request'>['payload']) };
      case 'harness.run':
        if (!this.d.bridge) throw new UnsupportedKindError(env.kind);
        return { kind: 'harness.run.result', payload: await this.d.bridge.run(env.payload as Envelope<'harness.run'>['payload']) };
      case 'harness.reconcile':
        if (!this.d.bridge) throw new UnsupportedKindError(env.kind);
        return { kind: 'action.result', payload: await this.d.bridge.reconcile(env.payload as Envelope<'harness.reconcile'>['payload']) };
      case 'output.generate':
        if (!this.d.bridge) throw new UnsupportedKindError(env.kind);
        return { kind: 'output.text', payload: await this.d.bridge.generateDetailed(env.payload as Envelope<'output.generate'>['payload']) };
      case 'eureka.execute':
        if (!this.d.eurekaBridge) throw new UnsupportedKindError(env.kind);
        return { kind: 'action.result', payload: await this.d.eurekaBridge.execute(env.payload as Envelope<'eureka.execute'>['payload']) };
      case 'eureka.reconcile':
        if (!this.d.eurekaBridge) throw new UnsupportedKindError(env.kind);
        return { kind: 'action.result', payload: await this.d.eurekaBridge.reconcile(env.payload as Envelope<'eureka.reconcile'>['payload']) };
      case 'eureka.reminders':
        if (!this.d.eurekaBridge) throw new UnsupportedKindError(env.kind);
        return { kind: 'eureka.reminders.result', payload: await this.d.eurekaBridge.reminders(readDeadline(env)) };
      case 'eureka.reminder': {
        if (!this.d.eurekaBridge) throw new UnsupportedKindError(env.kind);
        const p = env.payload as Envelope<'eureka.reminder'>['payload'];
        return { kind: 'eureka.reminder.result', payload: { item: await this.d.eurekaBridge.reminder(p.itemId, readDeadline(env)) } };
      }
      case 'eureka.links': {
        if (!this.d.eurekaBridge) throw new UnsupportedKindError(env.kind);
        const p = env.payload as Envelope<'eureka.links'>['payload'];
        return { kind: 'eureka.links.result', payload: await this.d.eurekaBridge.links(p.itemId, readDeadline(env)) };
      }
      default:
        throw new UnsupportedKindError(env.kind);
    }
  }
}

export class UnsupportedKindError extends Error {
  constructor(readonly kind: string) {
    super(`kind ${kind} is not accepted by this server`);
  }
}

/** 읽기 요청 deadline: 봉투 deadline이 없으면 10초 */
function readDeadline(env: Envelope): string {
  return env.deadlineAt ?? new Date(Date.now() + 10_000).toISOString();
}
