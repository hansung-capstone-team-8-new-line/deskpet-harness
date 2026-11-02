import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessResult, OutputContent } from '@deskpet/contracts';
import { OutputService, mapHarnessResult } from '@deskpet/output';
import { DirectHarnessInbound, HarnessWsServer } from '@deskpet/server';
import { constraints, harnessRequest, prContext, voiceTurn } from '../support/builders.js';
import { createWorld } from '../support/world.js';

/** 실제 localhost WebSocket으로 서비스 경계를 검사한다 (클라이언트: Node 내장 WebSocket — 데모·파이프라인과 같은 조건) */
const TOKEN = 'test-token-0123456789abcdef';
const DEADLINE = '2026-10-04T10:05:00.000Z';
const servers: HarnessWsServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(1_000);
});

async function boot(opts: { allowedOrigins?: string[]; maxPayloadBytes?: number; maxInFlightTotal?: number } = {}) {
  const w = createWorld();
  const server = new HarnessWsServer({ inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }), store: w.store, token: TOKEN, port: 0, helloTimeoutMs: 300, now: () => w.clock.nowMs(), ...opts });
  servers.push(server);
  const { port } = await server.start();
  return { w, server, url: `ws://127.0.0.1:${port}` };
}

type Frame = Record<string, unknown> & { type: string };
class TestClient {
  ws: WebSocket;
  frames: Frame[] = [];
  closed?: { code: number; reason: string };
  private seq = 0;
  private waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (ev) => {
      const f = JSON.parse(String(ev.data)) as Frame;
      this.frames.push(f);
      for (const w of [...this.waiters]) if (w.pred(f)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(f);
      }
    });
    this.ws.addEventListener('close', (e) => (this.closed = { code: e.code, reason: e.reason }));
  }
  open() {
    return new Promise<void>((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
    });
  }
  waitFor(pred: (f: Frame) => boolean, ms = 3_000) {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise<Frame>((resolve, reject) => {
      this.waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting for frame')), ms);
    });
  }
  waitClose(ms = 3_000) {
    return new Promise<{ code: number; reason: string }>((resolve, reject) => {
      if (this.closed) return resolve(this.closed);
      this.ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }), { once: true });
      setTimeout(() => reject(new Error('not closed')), ms);
    });
  }
  send(f: unknown) {
    this.ws.send(JSON.stringify(f));
  }
  async hello(role: 'pipeline' | 'viewer' = 'pipeline', token = TOKEN) {
    await this.open();
    this.send({ type: 'hello', token, role });
    return this.waitFor((f) => f.type === 'welcome');
  }
  envelope(kind: string, requestId: string, payload: unknown, o: { messageId?: string; deadline?: boolean; deadlineAt?: string; schemaVersion?: string } = {}) {
    return { schemaVersion: o.schemaVersion ?? '1.0', messageId: o.messageId ?? `m-${++this.seq}-${Math.random().toString(36).slice(2)}`, kind, requestId, createdAt: '2026-10-04T10:00:00.000Z', ...(o.deadline === false ? {} : { deadlineAt: o.deadlineAt ?? DEADLINE }), payload };
  }
  async request(kind: string, requestId: string, payload: unknown, o: { messageId?: string; deadline?: boolean; deadlineAt?: string; schemaVersion?: string } = {}) {
    const env = this.envelope(kind, requestId, payload, o);
    this.send({ type: 'request', envelope: env });
    return this.waitFor((f) => f.type === 'reply' && f['causationId'] === env.messageId);
  }
}

let turnN = 0;
const reviewReq = (id: string) => harnessRequest(id, voiceTurn(`t-ws-${++turnN}`, '그 PR 리뷰해줘'));
const approveReq = (id: string) => harnessRequest(id, voiceTurn(`t-ws-${++turnN}`, '좋아, 그 PR 승인해줘', { intention: 'pr.approve' }));

async function deliver(c: TestClient, r: HarnessResult, n = 1) {
  const deliveredText = (await new OutputService().generate(mapHarnessResult(r))).text;
  const reply = await c.request('pipeline.event', r.requestId, { messageId: `ev-${r.requestId}-${n}`, requestId: r.requestId, pendingId: r.pending!.pendingId, outputId: r.pending!.outputId, sourceRevision: n, occurredAt: '2026-10-04T10:00:01.000Z', kind: 'question_delivered', channel: 'speech', deliveredText }, { deadline: false });
  expect(reply['payload']).toMatchObject({ applied: true });
}
const resumePayload = (r: HarnessResult, text: string, turnId: string) => ({
  originalRequestId: r.requestId,
  currentTurn: voiceTurn(turnId, text),
  context: prContext(),
  pendingId: r.pending!.pendingId,
  expectedPendingRevision: r.pending!.revision + 1,
  confirmationId: r.pending!.confirmationId,
  newCallConstraints: constraints(DEADLINE),
});

describe('Harness WebSocket 경계 — 인증·접근', () => {
  it('잘못된 토큰은 4001로 끊고, hello 없이 시간이 지나면 4002로 끊는다', async () => {
    const { url } = await boot();
    const a = new TestClient(url);
    await a.open();
    a.send({ type: 'hello', token: 'wrong-token-xxxxxxxxxxxx', role: 'pipeline' });
    expect((await a.waitClose()).code).toBe(4001);
    const b = new TestClient(url);
    await b.open();
    expect((await b.waitClose()).code).toBe(4002);
  });

  it('hello 전 요청은 거부하고 끊는다', async () => {
    const { url } = await boot();
    const c = new TestClient(url);
    await c.open();
    c.send({ type: 'ping', id: 'x' });
    expect(await c.waitFor((f) => f.type === 'error')).toMatchObject({ code: 'hello_required' });
    expect((await c.waitClose()).code).toBe(4001);
  });

  it('viewer는 실행할 수 없고 구독만 한다', async () => {
    const { url, w } = await boot();
    const c = new TestClient(url);
    await c.hello('viewer');
    const r = await c.request('harness.request', 'req-v', reviewReq('req-v'));
    expect(r).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(w.github.reads).toHaveLength(0);
  });

  it('허용되지 않은 브라우저 Origin은 연결 단계에서 거부한다', async () => {
    const { url } = await boot({ allowedOrigins: ['http://localhost:5173'] });
    const { WebSocket: WsClient } = await import('ws');
    const bad = new WsClient(url, { origin: 'http://evil.example' });
    const status = await new Promise<number>((res) => bad.on('unexpected-response', (_q, r) => res(r.statusCode ?? 0)));
    expect(status).toBe(403);
    const ok = new WsClient(url, { origin: 'http://localhost:5173' });
    await new Promise<void>((res, rej) => {
      ok.on('open', () => res());
      ok.on('error', rej);
    });
    ok.close();
  });
});

describe('Harness WebSocket 경계 — viewer 전용 토큰', () => {
  it('viewer 토큰으로는 viewer만 될 수 있다 (pipeline을 자칭하면 4001)', async () => {
    const w = createWorld();
    const server = new HarnessWsServer({ inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }), store: w.store, token: TOKEN, viewerToken: 'viewer-token-0123456789', port: 0, now: () => w.clock.nowMs() });
    servers.push(server);
    const url = `ws://127.0.0.1:${(await server.start()).port}`;
    const v = new TestClient(url);
    expect(await v.hello('viewer', 'viewer-token-0123456789')).toMatchObject({ role: 'viewer' });
    const p = new TestClient(url);
    await p.open();
    p.send({ type: 'hello', token: 'viewer-token-0123456789', role: 'pipeline' });
    expect((await p.waitClose()).code).toBe(4001);
    expect(() => new HarnessWsServer({ inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }), store: w.store, token: TOKEN, viewerToken: TOKEN })).toThrow();
  });
});

describe('Harness WebSocket 경계 — 검증', () => {
  it('Envelope 검증 실패·지원하지 않는 major·받지 않는 kind는 실행 전에 거부한다', async () => {
    const { url, w } = await boot();
    const c = new TestClient(url);
    await c.hello();
    const noDeadline = await c.request('harness.request', 'req-1', reviewReq('req-1'), { deadline: false });
    expect(noDeadline).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    const major = await c.request('harness.request', 'req-1', reviewReq('req-1'), { schemaVersion: '2.0' });
    expect(major).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    const badPayload = await c.request('harness.request', 'req-1', { requestId: 'req-1' });
    expect(badPayload).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    const kind = await c.request('operation.updated', 'req-1', { kind: 'operation.updated' }, { deadline: false });
    expect(kind['ok']).toBe(false);
    expect(w.github.reads).toHaveLength(0);
  });

  it('메시지 크기 상한을 넘으면 연결을 끊는다 (1009)', async () => {
    const { url } = await boot({ maxPayloadBytes: 1_024 });
    const c = new TestClient(url);
    await c.hello();
    c.send({ type: 'ping', id: 'x'.repeat(5_000) });
    expect((await c.waitClose()).code).toBe(1009);
  });
});

describe('Harness WebSocket 경계 — G-01 흐름', () => {
  it('리뷰 → 승인 질문 → 질문 전달 이벤트 → 답변 → 승인 성공, 출력 문장까지 경계 너머로', async () => {
    const { url, w } = await boot();
    const c = new TestClient(url);
    await c.hello();
    const rv = await c.request('harness.request', 'req-r', reviewReq('req-r'));
    expect(rv).toMatchObject({ ok: true, kind: 'harness.result' });
    const q = (await c.request('harness.request', 'req-a', approveReq('req-a')))['payload'] as HarnessResult;
    expect(q.disposition).toBe('awaiting_user');
    const said = (await c.request('output.from_result', 'req-a', q, { deadline: false }))['payload'] as OutputContent;
    expect(said.text).toContain('승인할까요?');
    await deliver(c, q);
    const done = (await c.request('harness.resume', 'req-a', resumePayload(q, '응, 승인해', 't-ws-answer-1')))['payload'] as HarnessResult;
    expect(done.actionResults.find((a) => a.action === 'submit_approval')).toMatchObject({ status: 'succeeded' });
    expect(w.github.submitCount).toBe(1);
  });
});

describe('Harness WebSocket 경계 — 끊김·재전송', () => {
  it('답변을 보낸 직후 연결이 끊겨도 승인은 끝까지 처리되고(취소 아님), 같은 turnId로 다시 보내면 저장된 결과를 받는다', async () => {
    const { url, w, server } = await boot();
    const a = new TestClient(url);
    await a.hello();
    await a.request('harness.request', 'req-r', reviewReq('req-r'));
    const q = (await a.request('harness.request', 'req-a', approveReq('req-a')))['payload'] as HarnessResult;
    await deliver(a, q);
    a.send({ type: 'request', envelope: a.envelope('harness.resume', 'req-a', resumePayload(q, '응, 승인해', 't-ws-answer-2')) });
    a.ws.close();
    await a.waitClose();
    // 연결이 닫힌 뒤에도 서버는 받은 요청을 끝까지 처리한다
    for (let i = 0; i < 100 && w.github.submitCount === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await server.inFlightIdle();
    expect(w.github.submitCount).toBe(1);
    for (let i = 0; i < 100 && server.connectionCount > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(server.connectionCount).toBe(0); // 요청을 보낸 연결은 이미 없다

    const b = new TestClient(url);
    await b.hello();
    const again = (await b.request('harness.resume', 'req-a', resumePayload(q, '응, 승인해', 't-ws-answer-2')))['payload'] as HarnessResult;
    expect(again.actionResults.find((x) => x.action === 'submit_approval')).toMatchObject({ status: 'succeeded' });
    expect(w.github.submitCount).toBe(1);
  });

  it('같은 messageId 재전송은 한 번만 실행하고 같은 응답을 준다. 내용이 다르면 거부', async () => {
    const { url, w } = await boot();
    const c = new TestClient(url);
    await c.hello();
    const req = reviewReq('req-dup');
    const first = await c.request('harness.request', 'req-dup', req, { messageId: 'same-1' });
    const readsAfterFirst = w.github.reads.length;
    c.frames = [];
    const second = await c.request('harness.request', 'req-dup', req, { messageId: 'same-1' });
    expect(second['payload']).toEqual(first['payload']);
    expect(w.github.reads.length).toBe(readsAfterFirst);
    c.frames = [];
    const changed = await c.request('harness.request', 'req-dup', reviewReq('req-dup'), { messageId: 'same-1' });
    expect(changed).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
  });

  it('명시적 취소만 취소다: harness.cancel은 기다리는 질문을 철회한다', async () => {
    const { url } = await boot();
    const c = new TestClient(url);
    await c.hello();
    await c.request('harness.request', 'req-r', reviewReq('req-r'));
    const q = (await c.request('harness.request', 'req-c', approveReq('req-c')))['payload'] as HarnessResult;
    const cancel = await c.request('harness.cancel', 'req-c', { requestId: 'req-c', reason: 'user_cancel' }, { deadline: false });
    expect(cancel).toMatchObject({ ok: true, kind: 'harness.cancel.result' });
    expect((cancel['payload'] as { revokedPendings: string[] }).revokedPendings).toContain(q.pending!.pendingId);
  });
});

describe('Harness WebSocket 경계 — 상태 구독', () => {
  it('구독하면 snapshot(source 전체, epoch)을 먼저 받고 이후 변경 이벤트를 받는다', async () => {
    const { url } = await boot();
    const exec = new TestClient(url);
    await exec.hello();
    await exec.request('harness.request', 'req-r', reviewReq('req-r'));

    const viewer = new TestClient(url);
    const welcome = await viewer.hello('viewer');
    viewer.send({ type: 'subscribe', source: 'harness' });
    const snap = (await viewer.waitFor((f) => f.type === 'snapshot'))['snapshot'] as { scope: string; epoch: number; objectsWithRevisions: { entityType: string }[] };
    expect(snap.scope).toBe('all');
    expect(snap.epoch).toBe(welcome['epoch']);
    expect(snap.objectsWithRevisions.some((o) => o.entityType === 'operation')).toBe(true);

    await exec.request('harness.request', 'req-a', approveReq('req-a'));
    const ev = await viewer.waitFor((f) => f.type === 'event' && (f['event'] as { entityType?: string }).entityType === 'pending');
    expect(ev['event']).toMatchObject({ kind: 'operation.updated', epoch: welcome['epoch'] });
    expect(viewer.frames.findIndex((f) => f.type === 'snapshot')).toBeLessThan(viewer.frames.findIndex((f) => f.type === 'event'));
  });
});

describe('Harness WebSocket 경계 — 봉투 검사 (감사 F-05)', () => {
  it('봉투 requestId와 payload 요청이 다르면 실행 전에 거부한다', async () => {
    const { url } = await boot();
    const c = new TestClient(url);
    await c.hello();
    const reply = await c.request('harness.request', 'req-outer', approveReq('req-inner'));
    expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(JSON.stringify(reply['error'])).toContain('does not match payload');
  });

  it('기한이 지난 봉투는 실행하지 않는다 (승인 답변이어도 쓰기 0회)', async () => {
    const { w, url } = await boot();
    const c = new TestClient(url);
    await c.hello();
    const q = (await c.request('harness.request', 'req-exp', approveReq('req-exp')))['payload'] as HarnessResult;
    await deliver(c, q);
    const reply = await c.request('harness.resume', 'req-exp', resumePayload(q, '응, 승인해', 't-ws-exp'), { deadlineAt: '2026-10-04T09:59:00.000Z' });
    expect(reply).toMatchObject({ ok: false, error: { code: 'deadline_exceeded' } });
    expect(w.github.submitCount).toBe(0);
  });
});

describe('Harness WebSocket 경계 — 서버 전체 상한 (감사 F-07)', () => {
  it('서버 전체 동시 처리 상한에 걸리면 실행하지 않고 거부한다', async () => {
    const { url } = await boot({ maxInFlightTotal: 0 });
    const c = new TestClient(url);
    await c.hello();
    const reply = await c.request('harness.request', 'req-cap', reviewReq('req-cap'));
    expect(reply).toMatchObject({ ok: false, error: { code: 'too_many_in_flight' } });
  });
});

describe('notice (D-23): 요청이 끝난 뒤 확정된 결과는 pipeline 연결에만 보낸다', () => {
  it('pipeline은 받고 viewer는 받지 않는다', async () => {
    const { server, url } = await boot();
    const p = new TestClient(url);
    await p.hello('pipeline');
    const v = new TestClient(url);
    await v.hello('viewer').catch(() => undefined);
    expect(server.notify({ noticeId: 'n-1', source: 'recovery' }, 'Eureka 반영을 확인했어요.')).toBe(1);
    const f = await p.waitFor((x) => x.type === 'notice');
    expect(f).toMatchObject({ notice: { noticeId: 'n-1' }, resultText: 'Eureka 반영을 확인했어요.' });
    await new Promise((r) => setTimeout(r, 50));
    expect(v.frames.some((x) => x.type === 'notice')).toBe(false);
  });
});
