import { afterEach, describe, expect, it } from 'vitest';
import { ConcurrencyLimiter, LimiterBusyError, type Envelope, type LlmRequest } from '@deskpet/contracts';
import { FetchHttpClient, HttpTransportError } from '@deskpet/gateways';
import { CallWindow, GuardedLlmClient, GuardedOutputModel } from '@deskpet/llm';
import { OutputService } from '@deskpet/output';
import { HarnessWsServer, laneOf, type HarnessInbound } from '@deskpet/server';
import { createWorld } from '../support/world.js';

/** D-24 자원별 동시 호출 상한 + 입구 칸 나누기 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ConcurrencyLimiter', () => {
  it('자리가 있으면 바로, 없으면 waitMs만 기다리고 거절한다. 순서대로 자리를 넘긴다', async () => {
    const l = new ConcurrencyLimiter('x', 1);
    const order: string[] = [];
    const a = l.run(async () => { order.push('a'); await sleep(40); }, { waitMs: 0 });
    const b = l.run(async () => { order.push('b'); }, { waitMs: 200 });
    await expect(l.run(async () => undefined, { waitMs: 5 })).rejects.toBeInstanceOf(LimiterBusyError);
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
    expect(l.stats()).toMatchObject({ active: 0, queued: 0, rejected: 1 });
  });
  it('대기열이 가득 차면 기다리지 않고 거절한다', async () => {
    const l = new ConcurrencyLimiter('x', 1, 1);
    const a = l.run(() => sleep(30), { waitMs: 0 });
    const b = l.run(() => sleep(1), { waitMs: 500 });
    await expect(l.run(async () => undefined, { waitMs: 500 })).rejects.toMatchObject({ reason: 'queue_full' });
    await Promise.all([a, b]);
  });
});

describe('LLM 상한: 자리가 없으면 호출하지 않고 busy → 고정 문구', () => {
  const req = { purpose: 'output', instructions: 'i', input: 'x', maxOutputTokens: 10, deadlineAt: '2099-01-01T00:00:00.000Z' } as unknown as LlmRequest;
  it('GuardedLlmClient: 동시 1건 상한, 짧은 대기 뒤 LlmError(busy). 분당 호출 수도 쓰지 않는다', async () => {
    let calls = 0;
    const inner = { provider: 'slow', complete: async () => { calls += 1; await sleep(60); return { text: '{}' } as never; } };
    const window = new CallWindow(100);
    const c = new GuardedLlmClient(inner, window, 100, { limiter: new ConcurrencyLimiter('llm', 1), waitMs: 10 });
    const first = c.complete(req);
    await expect(c.complete(req)).rejects.toMatchObject({ code: 'busy' });
    await first;
    expect(calls).toBe(1);
  });
  it('출력 모델이 busy면 OutputService는 고정 문구를 쓴다', async () => {
    const limiter = new ConcurrencyLimiter('llm', 1);
    const slow = { generate: async () => { await sleep(80); return { text: 'x' }; } };
    const model = new GuardedOutputModel(slow, new CallWindow(100), { limiter, waitMs: 5 });
    const hold = limiter.run(() => sleep(60), { waitMs: 0 });
    const w = createWorld();
    const out = new OutputService({ model });
    const r = await w.harness.handle((await import('../support/builders.js')).harnessRequest('req-busy', (await import('../support/builders.js')).voiceTurn('t-busy', '그 PR 리뷰해줘')));
    const content = await out.generate((await import('@deskpet/output')).mapHarnessResult(r));
    expect(content.fallbackUsed).toBe(true);
    await hold;
  });
});

describe('GitHub·Eureka HTTP 상한: 자리가 끝내 안 나면 보내지 않음(not_sent)', () => {
  it('남은 시간 안에 자리가 나면 보내고, 아니면 not_sent 증거', async () => {
    let inFlight = 0;
    let max = 0;
    const fetchImpl = (async () => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await sleep(40);
      inFlight -= 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const http = new FetchHttpClient('https://example.test', () => ({}), fetchImpl, new ConcurrencyLimiter('eureka', 1));
    const a = http.request({ method: 'GET', path: '/a', timeoutMs: 1_000 });
    const b = http.request({ method: 'GET', path: '/b', timeoutMs: 1_000 });
    const c = http.request({ method: 'POST', path: '/c', timeoutMs: 10 }).catch((e: unknown) => e);
    await Promise.all([a, b]);
    const err = await c;
    expect(err).toBeInstanceOf(HttpTransportError);
    expect((err as HttpTransportError).failure).toMatchObject({ kind: 'not_sent', proof: 'limiter:eureka:wait_timeout' });
    expect(max).toBe(1);
  });
});

describe('서버 입구 칸 (D-24)', () => {
  const TOKEN = 'test-token-0123456789abcdef';
  const servers: HarnessWsServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop(1_000);
  });

  it('칸 분류', () => {
    expect(['pipeline.event', 'harness.cancel', 'harness.reconcile', 'eureka.reconcile'].map(laneOf)).toEqual(['control', 'control', 'control', 'control']);
    expect(['eureka.execute', 'eureka.links'].map(laneOf)).toEqual(['eureka', 'eureka']);
    expect(['harness.run', 'harness.request', 'output.generate'].map(laneOf)).toEqual(['work', 'work', 'work']);
  });

  it('LLM 쪽(work) 칸이 가득 차도 Eureka 요청과 질문 전달 보고는 받는다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inbound: HarnessInbound = {
      kinds: new Set(['harness.request', 'eureka.reminders', 'pipeline.event']),
      dispatch: async (env: Envelope) => {
        if (env.kind === 'harness.request') await gate;
        return { kind: `${env.kind}.result`, payload: {} };
      },
    };
    const w = createWorld();
    const server = new HarnessWsServer({ inbound, store: w.store, token: TOKEN, port: 0, now: () => w.clock.nowMs(), maxInFlightByLane: { work: 1 }, maxInFlightPerConnection: 1 });
    servers.push(server);
    const { port } = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const frames: Record<string, unknown>[] = [];
    ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>));
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    ws.send(JSON.stringify({ type: 'hello', token: TOKEN, role: 'pipeline' }));
    await sleep(50);
    let seq = 0;
    const env = (kind: string, payload: unknown, deadline = true, requestId = `R${seq + 1}`) => ({ schemaVersion: '1.0', messageId: `m${++seq}`, kind, requestId, createdAt: '2026-10-04T10:00:00.000Z', ...(deadline ? { deadlineAt: '2026-10-04T10:05:00.000Z' } : {}), payload });
    const reqPayload = (await import('../support/builders.js')).harnessRequest('R-hold', (await import('../support/builders.js')).voiceTurn('t-hold', '리뷰해줘'));
    ws.send(JSON.stringify({ type: 'request', envelope: env('harness.request', reqPayload, true, 'R-hold') })); // m1: 붙잡힘
    await sleep(30);
    ws.send(JSON.stringify({ type: 'request', envelope: env('harness.request', { ...reqPayload, requestId: 'R-2' }, true, 'R-2') })); // m2: work 칸 가득 → 거절
    ws.send(JSON.stringify({ type: 'request', envelope: env('pipeline.event', { messageId: 'e1', requestId: 'R-hold', sourceRevision: 1, occurredAt: '2026-10-04T10:00:00.000Z', kind: 'speech_started' }, false, 'R-hold') })); // m3: control
    await sleep(80);
    const reply = (id: string) => frames.find((f) => f['type'] === 'reply' && f['causationId'] === id);
    expect(reply('m2')).toMatchObject({ ok: false, error: { code: 'too_many_in_flight' } });
    expect(reply('m3')).toMatchObject({ ok: true });
    release();
    await sleep(50);
    expect(reply('m1')).toMatchObject({ ok: true });
    ws.close();
  });
});
