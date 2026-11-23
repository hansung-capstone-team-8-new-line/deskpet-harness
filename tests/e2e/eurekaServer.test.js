import { afterEach, describe, expect, it } from 'vitest';
import { EurekaGateway, FakeEurekaServer } from '@deskpet/gateways';
import { DEFAULT_POLICY, FakeClock, InMemoryOperationStore, SequentialIdGen } from '@deskpet/harness';
import { DirectHarnessInbound, EurekaBridge, EurekaInbound, HarnessWsServer } from '@deskpet/server';
import { OutputService } from '@deskpet/output';
import { T0 } from '../support/builders.js';
import { createWorld } from '../support/world.js';
/**
 * D-31 Eureka 내부 API 분리: 직접 Eureka 요청만 받는 별도 서버(EurekaInbound). 메시지 형식은 Harness 서버와 같다.
 * Harness 서버는 eurekaBridge 없이 켜면 eureka.*를 받지 않는다.
 */
const TOKEN = 'eureka-token-0123456789abcd';
const DEADLINE = '2026-10-04T10:05:00.000Z';
const servers = [];
afterEach(async () => {
    for (const s of servers.splice(0))
        await s.stop(1_000);
});
async function client(url) {
    const ws = new WebSocket(url);
    const frames = [];
    ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data))));
    await new Promise((res, rej) => {
        ws.addEventListener('open', () => res(), { once: true });
        ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
    });
    const wait = async (pred) => {
        for (let i = 0; i < 300; i++) {
            const hit = frames.find(pred);
            if (hit)
                return hit;
            await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('timeout');
    };
    ws.send(JSON.stringify({ type: 'hello', token: TOKEN, role: 'pipeline' }));
    await wait((f) => f['type'] === 'welcome');
    let seq = 0;
    return {
        async request(kind, requestId, payload) {
            const messageId = `m-${++seq}`;
            ws.send(JSON.stringify({ type: 'request', envelope: { schemaVersion: '1.0', messageId, kind, requestId, createdAt: T0, deadlineAt: DEADLINE, payload } }));
            return wait((f) => f['type'] === 'reply' && f['causationId'] === messageId);
        },
        close: () => ws.close(),
    };
}
function eurekaRequest(requestId, heads) {
    return {
        requestId,
        operationId: `op-${requestId}`,
        decision: { headOutputs: Object.fromEntries(Object.entries(heads).map(([k, v]) => [k, { value: v, confidence: 0.95 }])), overallConfidence: 0.9, missingRequiredSlots: [], route: 'eureka' },
        deadlineAt: DEADLINE,
        mutationApproved: false,
    };
}
describe('Eureka 내부 API 서버 (D-31)', () => {
    it('직접 Eureka 요청만 받고, Harness 요청은 지원하지 않는 종류로 거절한다', async () => {
        const clock = new FakeClock(T0);
        const fake = new FakeEurekaServer(() => clock.nowMs());
        fake.addItem({ id: '3001', name: '발표 준비', dueAt: clock.nowMs() + 3600_000, stages: [{ id: '30011', name: '자료', status: 'doing', order: 1 }] });
        const store = new InMemoryOperationStore({ clock, ids: new SequentialIdGen(), capacityBytes: DEFAULT_POLICY.storeCapacityBytes, recoveryBudgetBytes: DEFAULT_POLICY.recoveryBudgetBytes, minRetentionMs: DEFAULT_POLICY.minRetentionMs, maxRecoveryAttempts: 3 });
        const bridge = new EurekaBridge({ eureka: new EurekaGateway({ http: fake, now: () => clock.nowMs(), allowWrites: true }), store, clock });
        const server = new HarnessWsServer({ inbound: new EurekaInbound(bridge), store, token: TOKEN, port: 0, now: () => clock.nowMs() });
        servers.push(server);
        const { port } = await server.start();
        const c = await client(`ws://127.0.0.1:${port}`);
        const r = await c.request('eureka.execute', 'REQ-1', eurekaRequest('REQ-1', { intention: 'eureka', operation: 'query', name: '발표 준비' }));
        expect(r.ok).toBe(true);
        expect(r).toMatchObject({ kind: 'action.result', payload: { status: 'succeeded', facts: { itemId: '3001' } } });
        const h = await c.request('harness.cancel', 'REQ-2', { requestId: 'REQ-2', reason: 'test' });
        expect(h).toMatchObject({ ok: false, error: { code: 'unsupported_kind' } });
        c.close();
    });
    it('Harness 서버를 eurekaBridge 없이 켜면 eureka.*는 받지 않는다 (external 모드)', async () => {
        const w = createWorld();
        const server = new HarnessWsServer({ inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }), store: w.store, token: TOKEN, port: 0, now: () => w.clock.nowMs() });
        servers.push(server);
        const { port } = await server.start();
        const c = await client(`ws://127.0.0.1:${port}`);
        const r = await c.request('eureka.execute', 'REQ-3', eurekaRequest('REQ-3', { intention: 'eureka', operation: 'query' }));
        expect(r).toMatchObject({ ok: false, error: { code: 'unsupported_kind' } });
        c.close();
    });
});
