import { describe, expect, it } from 'vitest';
import type { AckResult, DispatchHandle } from '@deskpet/contracts';
import { EurekaGateway, FakeEurekaServer, FetchHttpClient, HttpTransportError, createEurekaRestGateway, normalizeItem } from '@deskpet/gateways';
import { ITEM_ID, STAGE_ID, T0 } from '../../../tests/support/builders.js';

const NOW = Date.parse(T0);
const c = { deadlineAt: '2026-10-04T10:05:00.000Z' };

function setup() {
  const server = new FakeEurekaServer(() => NOW);
  server.addItem({
    id: ITEM_ID,
    name: '캡스톤 PR 검토',
    dueAt: NOW + 40 * 60_000,
    priority: 'high',
    stages: [
      { id: '1000037', name: '변경 확인', status: 'done', order: 1 },
      { id: STAGE_ID, name: 'PR 승인', status: 'doing', order: 2 },
    ],
  });
  const gw = new EurekaGateway({ http: server, now: () => NOW, allowWrites: true });
  return { server, gw };
}

function handle(ack: AckResult = { ok: true, ack: { kind: 'may_have_been_sent', operationId: 'op-1', attemptId: 'att-1', ownerRevision: 1, persistedAt: T0 } }) {
  let called = 0;
  const h: DispatchHandle = {
    operationId: 'op-1',
    attemptId: 'att-1',
    ownerRevision: 1,
    beforeDispatch: async () => {
      called += 1;
      return ack;
    },
  };
  return { h, calls: () => called };
}

const cmd = {
  operationId: 'op-1',
  confirmationId: 'c-2',
  itemId: ITEM_ID,
  stageId: STAGE_ID,
  githubSuccessEvidence: { approvalOperationId: 'op-0', reviewId: '9001', approvedSha: 'a1b2c3d', followUpObservedAt: T0 },
  expectedChange: { status: 'done' as const },
};

describe('normalizeItem / item state (PDF §3)', () => {
  it('computes state from stage$$ and treats missing status as todo', () => {
    const t = normalizeItem({ id: 1, name: ' x ', 'stage$$': [{ id: 's1', name: 'a' }, { id: 's2', name: 'b', status: 'done' }] });
    expect(t.itemId).toBe('1');
    expect(t.stages[0]!.status).toBe('todo');
    expect(t.computedState).toBe('doing');
    expect(normalizeItem({ id: 2, name: 'y', 'stage$$': [{ id: 's', status: 'skip' }] }).computedState).toBe('done');
    expect(normalizeItem({ id: 3, name: 'z', status: 'hold', 'stage$$': [] }).computedState).toBe('hold');
    expect(normalizeItem({ id: 4, name: 'w' }).computedState).toBe('todo');
  });

  it('does not substitute name for missing description (C-08)', () => {
    expect(normalizeItem({ id: 1, name: 'n' }).description).toBeUndefined();
  });
});

describe('EurekaGateway reads', () => {
  it('listTasks returns normalized items with completeness', async () => {
    const { gw } = setup();
    const r = await gw.listTasks({}, c);
    expect(r.ok).toBe(true);
    expect(r.data!.completeness).toBe('complete');
    expect(r.data!.items[0]!.stages[1]).toMatchObject({ stageId: STAGE_ID, status: 'doing' });
  });

  it('retries a transient read error once', async () => {
    const { gw, server } = setup();
    server.injectFault((r) => r.method === 'GET', { kind: 'refuse' }, 1);
    expect((await gw.listTasks({}, c)).ok).toBe(true);
  });

  it('gives up after one retry', async () => {
    const { gw, server } = setup();
    server.injectFault((r) => r.method === 'GET', { kind: 'refuse' }, 2);
    const r = await gw.listTasks({}, c);
    expect(r.ok).toBe(false);
    expect(r.result.error!.provisionalCode).toBe('EUREKA_TRANSIENT');
  });

  it('does not retry auth errors (403)', async () => {
    const { gw, server } = setup();
    server.apiKeyValid = false;
    const r = await gw.listTasks({}, c);
    expect(r.result.error!.provisionalCode).toBe('EUREKA_AUTH_ERROR');
    expect(server.calls.length).toBe(1);
  });

  it('maps 500 validation bodies to input errors (PDF §6)', async () => {
    const { gw, server } = setup();
    server.injectFault(() => true, { kind: 'status', status: 500, body: '.name (string) is required - x' });
    const r = await gw.listTasks({}, c);
    expect(r.result.error!.provisionalCode).toBe('EUREKA_INPUT_INVALID');
  });

  it('getTaskState includes stage status from list detail', async () => {
    const { gw } = setup();
    const r = await gw.getTaskState({ itemId: ITEM_ID, stageId: STAGE_ID }, c);
    expect(r.data).toMatchObject({ itemStatus: 'doing', totalStages: 2, doneStages: 1, stage: { status: 'doing' } });
  });

  it('respects deadline: no request after deadline', async () => {
    const { gw, server } = setup();
    const r = await gw.listTasks({}, { deadlineAt: '2026-10-04T09:59:00.000Z' });
    expect(r.result.error!.provisionalCode).toBe('DEADLINE_EXCEEDED');
    expect(server.calls.length).toBe(0);
  });
});

describe('EurekaGateway.completeStage', () => {
  it('sends only after durable ack and returns external evidence', async () => {
    const { gw, server } = setup();
    const { h, calls } = handle();
    const r = await gw.completeStage(cmd, h, c);
    expect(calls()).toBe(1);
    expect(r).toMatchObject({ mode: 'write', dispatchState: 'sent', outcome: 'response' });
    expect(r.externalRefs[0]!.kind).toBe('stage_status_change');
    expect(server.writeCount('/_api_/stages/')).toBe(1);
  });

  it('writes are disabled by default: no ack requested, nothing sent', async () => {
    const { server } = setup();
    const ro = new EurekaGateway({ http: server, now: () => NOW });
    const { h, calls } = handle();
    const r = await ro.completeStage(cmd, h, c);
    expect(r).toMatchObject({ dispatchState: 'not_sent', notSentProof: 'writes_disabled' });
    expect(calls()).toBe(0);
    expect(server.writeCount('/')).toBe(0);
  });

  it('does not send without ack', async () => {
    const { gw, server } = setup();
    const { h } = handle({ ok: false, reason: 'storage_error', detail: 'x' });
    const r = await gw.completeStage(cmd, h, c);
    expect(r).toMatchObject({ dispatchState: 'not_sent', notSentProof: 'no_ack:storage_error' });
    expect(server.writeCount('/_api_/stages/')).toBe(0);
  });

  it('response loss after apply → may_have_been_sent, no resend', async () => {
    const { gw, server } = setup();
    server.injectFault((r) => r.method === 'POST', { kind: 'drop_after_apply' });
    const r = await gw.completeStage(cmd, handle().h, c);
    expect(r).toMatchObject({ dispatchState: 'may_have_been_sent', outcome: 'no_response' });
    expect(r.error!.nextAction).toBe('reconcile');
    expect(server.writeCount('/_api_/stages/')).toBe(1);
  });

  it('connection refused → not_sent with proof', async () => {
    const { gw, server } = setup();
    server.injectFault((r) => r.method === 'POST', { kind: 'refuse' });
    const r = await gw.completeStage(cmd, handle().h, c);
    expect(r).toMatchObject({ dispatchState: 'not_sent', notSentProof: 'transport:ECONNREFUSED' });
  });

  it('pre-check blocks hold items and already-done stages without sending', async () => {
    const { gw, server } = setup();
    server.items.get(ITEM_ID)!.status = 'hold';
    const a = await gw.completeStage(cmd, handle().h, c);
    expect(a.error!.provisionalCode).toBe('EUREKA_CONFLICT');
    server.items.get(ITEM_ID)!.status = undefined;
    server.items.get(ITEM_ID)!.stages[1]!.status = 'done';
    const b = await gw.completeStage(cmd, handle().h, c);
    expect(b).toMatchObject({ dispatchState: 'not_sent', notSentProof: 'precheck_already_done' });
    expect(server.writeCount('/_api_/stages/')).toBe(0);
  });

  it('explicit 403 write failure is not retried', async () => {
    const { gw, server } = setup();
    server.injectFault((r) => r.method === 'POST', { kind: 'status', status: 403, body: '{"message":"Forbidden"}' });
    const r = await gw.completeStage(cmd, handle().h, c);
    expect(r).toMatchObject({ dispatchState: 'sent', outcome: 'error' });
    expect(r.error).toMatchObject({ provisionalCode: 'EUREKA_AUTH_ERROR', nextAction: 'none' });
    expect(server.writeCount('/_api_/stages/')).toBe(1);
  });

  it('getChangeOutcome reports candidate linkage only (no idempotency, C-09)', async () => {
    const { gw, server } = setup();
    server.items.get(ITEM_ID)!.stages[1]!.status = 'done';
    const r = await gw.getChangeOutcome({ operationId: 'op-1', itemId: ITEM_ID, stageId: STAGE_ID, priorStageStatus: 'doing' }, c);
    expect(r.response).toMatchObject({ currentStageStatus: 'done', linkage: 'candidate_only' });
    expect(server.writeCount('/')).toBe(0);
  });
});

describe('FetchHttpClient', () => {
  it('sends x-api-key header and never leaks it in errors', async () => {
    let seen: Headers | undefined;
    const fakeFetch = (async (_u: URL, init: RequestInit) => {
      seen = new Headers(init.headers);
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch;
    const http = new FetchHttpClient('https://api.eureka.codes/flw-d1', () => ({ 'x-api-key': 'SECRET-KEY' }), fakeFetch);
    const e = await http.request({ method: 'GET', path: '/_api_/session', timeoutMs: 1000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpTransportError);
    expect((e as HttpTransportError).failure).toEqual({ kind: 'not_sent', proof: 'transport:ECONNREFUSED' });
    expect(String((e as Error).message)).not.toContain('SECRET');
    expect(seen!.get('x-api-key')).toBe('SECRET-KEY');
  });

  it('maps other failures to no_response', async () => {
    const fakeFetch = (async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const http = new FetchHttpClient('https://x', () => ({}), fakeFetch);
    const e = (await http.request({ method: 'POST', path: '/p', body: {}, timeoutMs: 10 }).catch((x: unknown) => x)) as HttpTransportError;
    expect(e.failure.kind).toBe('no_response');
  });

  it('createEurekaRestGateway requires a key and defaults to flw-d1', async () => {
    expect(() => createEurekaRestGateway({})).toThrow(/EUREKA_API_KEY/);
    let url = '';
    const fakeFetch = (async (u: URL) => {
      url = String(u);
      return new Response(JSON.stringify({ total: 0, list: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const gw = createEurekaRestGateway({ EUREKA_API_KEY: 'k' }, fakeFetch);
    await gw.listTasks({}, { deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    expect(url).toMatch(/^https:\/\/api\.eureka\.codes\/flw-d1\/_api_\/items\/0\/list\?sites=&detail=true&limit=100$/);
  });
});

describe('EurekaGateway direct path — registerItem body', () => {
  it('maps internal dueAtMs to the API field dueAt (same as postponeItem)', async () => {
    const sent: unknown[] = [];
    const http = { request: async (r: { body?: unknown }) => (sent.push(r.body), { status: 200, bodyText: JSON.stringify({ id: '1000099', stageIds: ['s1'] }) }) };
    const gw = new EurekaGateway({ http, now: () => NOW, allowWrites: true });
    const r = await gw.registerItem({ processId: 'general-work-v1@10204', name: '보고서 초안', dueAtMs: 1789900000000, priority: 'high' }, handle().h, c);
    expect(sent[0]).toEqual({ processId: 'general-work-v1@10204', name: '보고서 초안', dueAt: 1789900000000, priority: 'high' });
    expect(sent[0]).not.toHaveProperty('dueAtMs');
    expect(r.externalRefs[0]).toMatchObject({ kind: 'item', id: '1000099' });
  });
});

describe('EurekaGateway — 운영자 확인 (--allow-eureka-writes)', () => {
  const withGate = (verdict: (server: FakeEurekaServer) => Promise<'approved' | 'declined' | 'timeout'>) => {
    const s = setup();
    const seen: string[] = [];
    const gw = new EurekaGateway({
      http: s.server,
      now: () => NOW,
      allowWrites: true,
      operatorConfirm: {
        confirm: async (w) => {
          seen.push(`${w.action} ${w.method} ${w.path}`);
          return verdict(s.server);
        },
      },
    });
    return { ...s, gw, seen };
  };

  it('yes면 ack 뒤 한 번 보낸다. 확인 화면에 행위·요청을 보여 준다', async () => {
    const { gw, server, seen } = withGate(async () => 'approved');
    const { h, calls } = handle();
    const r = await gw.completeStage(cmd, h, c);
    expect(r).toMatchObject({ dispatchState: 'sent', outcome: 'response' });
    expect(seen).toEqual([`complete_stage POST /_api_/stages/${STAGE_ID}/status`]);
    expect(calls()).toBe(1);
    expect(server.writeCount('/')).toBe(1);
  });

  it('거절·시간 초과면 ack도 받지 않고 보내지 않는다', async () => {
    for (const [v, code] of [['declined', 'CANCELLED'], ['timeout', 'DEADLINE_EXCEEDED']] as const) {
      const { gw, server } = withGate(async () => v);
      const { h, calls } = handle();
      const r = await gw.completeStage(cmd, h, c);
      expect(r).toMatchObject({ dispatchState: 'not_sent', error: { provisionalCode: code } });
      expect(calls()).toBe(0);
      expect(server.writeCount('/')).toBe(0);
    }
  });

  it('yes 하는 사이 단계가 이미 완료되면 다시 확인해서 보내지 않는다', async () => {
    const { gw, server } = withGate(async (srv) => {
      srv.items.get(ITEM_ID)!.stages[1]!.status = 'done';
      return 'approved';
    });
    const { h, calls } = handle();
    const r = await gw.completeStage(cmd, h, c);
    expect(r).toMatchObject({ dispatchState: 'not_sent', notSentProof: 'precheck_already_done' });
    expect(calls()).toBe(0);
    expect(server.writeCount('/')).toBe(0);
  });
});
