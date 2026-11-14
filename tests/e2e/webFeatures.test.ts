import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { OutputService } from '@deskpet/output';
import { DirectHarnessInbound, HarnessWsServer, HistoryLog, historyEntryFrom } from '@deskpet/server';
import { groupBySession, filterHistory, type HistoryEntry } from '../../apps/web/src/lib/server-info.js';
import { harnessRequest, voiceTurn } from '../support/builders.js';
import { createWorld } from '../support/world.js';

/**
 * 웹 기능 (2026-11-14 사용자 결정)
 * - D-47 세션 기록: 실행 요청의 발화 → 결과를 남기고 viewer가 읽는다. 파일에 남겨 다시 켜도 보인다
 * - D-49 서버 정보: 접속 직후·바뀔 때 server.info
 * - D-50 관리 동작: 관리 토큰이 맞을 때만 (업데이트 버튼)
 */
const TOKEN = 'test-token-0123456789abcdef';
const ADMIN = 'admin-token-0123456789abcd';
const tmp = mkdtempSync(join(tmpdir(), 'deskpet-history-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const servers: HarnessWsServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(500);
});

type Frame = Record<string, unknown> & { type: string };
async function client(port: number, role: 'pipeline' | 'viewer', token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: Frame[] = [];
  const waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  let closed: { code: number; reason: string } | undefined;
  ws.addEventListener('message', (ev) => {
    const f = JSON.parse(String(ev.data)) as Frame;
    frames.push(f);
    for (const w of [...waiters])
      if (w.pred(f)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(f);
      }
  });
  ws.addEventListener('close', (e) => (closed = { code: e.code, reason: e.reason }));
  await new Promise<void>((r) => ws.addEventListener('open', () => r(), { once: true }));
  const waitFor = (pred: (f: Frame) => boolean, ms = 3_000) => {
    const hit = frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise<Frame>((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout')), ms);
    });
  };
  const send = (f: unknown) => ws.send(JSON.stringify(f));
  send({ type: 'hello', token, role });
  await waitFor((f) => f.type === 'welcome');
  return { ws, frames, waitFor, send, closed: () => closed };
}

let seq = 0;
function envelope(kind: string, requestId: string, payload: unknown) {
  return { schemaVersion: '1.0', messageId: `m-${++seq}`, kind, requestId, createdAt: '2026-10-04T10:00:00.000Z', deadlineAt: '2026-10-04T10:05:00.000Z', payload };
}

async function boot(o: { history?: HistoryLog; admin?: boolean; info?: () => unknown } = {}) {
  const w = createWorld();
  const calls: string[] = [];
  const server = new HarnessWsServer({
    inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }),
    store: w.store,
    token: TOKEN,
    openViewer: true,
    port: 0,
    helloTimeoutMs: 500,
    now: () => w.clock.nowMs(),
    ...(o.history ? { history: o.history } : {}),
    ...(o.info ? { info: o.info } : {}),
    ...(o.admin
      ? {
          adminToken: ADMIN,
          admin: async (action: 'update.check' | 'update.apply' | 'settings.set') => {
            calls.push(action);
            return { ok: true, message: `did ${action}` };
          },
        }
      : {}),
  });
  servers.push(server);
  const { port } = await server.start();
  return { w, server, port, calls };
}

describe('세션 기록 (D-47)', () => {
  it('실행 요청의 발화·의도·결과 문장을 남기고, viewer가 읽고 새 기록을 실시간으로 받는다', async () => {
    const history = new HistoryLog();
    const { port } = await boot({ history });
    const viewer = await client(port, 'viewer', '');
    viewer.send({ type: 'history' });
    const first = await viewer.waitFor((f) => f.type === 'history');
    expect(first['entries']).toEqual([]);
    expect(first['sessionId']).toBe(history.sessionId);

    const pipe = await client(port, 'pipeline', TOKEN);
    pipe.send({ type: 'request', envelope: envelope('harness.request', 'req-h1', harnessRequest('req-h1', voiceTurn('t-h1', '그 PR 리뷰해줘'))) });
    await pipe.waitFor((f) => f.type === 'reply');
    const pushed = await viewer.waitFor((f) => f.type === 'history.appended');
    const e = pushed['entry'] as HistoryEntry;
    expect(e).toMatchObject({ kind: 'harness.request', requestId: 'req-h1', input: '그 PR 리뷰해줘', inputChannel: 'voice', status: 'succeeded', sessionId: history.sessionId });
    expect(e.resultText).toMatch(/PR 42번/);
    expect(e.actions?.[0]?.action).toBe('get_review_context');

    // 실행 전에 거부된 요청(형식 오류)은 사용자 발화가 아니므로 남기지 않는다
    pipe.send({ type: 'request', envelope: envelope('harness.request', 'req-bad', { nope: true }) });
    await pipe.waitFor((f) => f.type === 'reply' && f['requestId'] === 'req-bad');
    expect(history.page().entries.map((x) => x.requestId)).toEqual(['req-h1']);
  });

  it('파일에 남겨 서버를 다시 켜도 지난 세션 기록이 보인다. 깨진 줄은 건너뛴다', () => {
    const path = join(tmp, 'h1', 'history.jsonl');
    const a = new HistoryLog({ path, now: () => Date.parse('2026-11-13T05:00:00Z') });
    a.append({ kind: 'harness.run', requestId: 'r1', input: '하나', status: 'succeeded', ms: 10 });
    a.append({ kind: 'harness.run', requestId: 'r2', input: '둘', status: 'question', ms: 10 });
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    // 쓰다가 꺼진 줄
    appendFileSync(path, '{"id":"broken');
    const b = new HistoryLog({ path, now: () => Date.parse('2026-11-14T01:00:00Z') });
    b.append({ kind: 'harness.run', requestId: 'r3', input: '셋', status: 'failed', ms: 10 });
    const page = b.page();
    expect(page.entries.map((x) => x.requestId)).toEqual(['r3', 'r2', 'r1']);
    expect(groupBySession(page.entries).map((s) => s.entries.length)).toEqual([1, 2]);
  });

  it('최신 순으로 나눠 읽는다 (더 보기), 상한을 넘으면 오래된 것부터 지운다', () => {
    const h = new HistoryLog({ maxEntries: 5 });
    for (let i = 1; i <= 7; i++) h.append({ kind: 'harness.run', requestId: `r${i}`, status: 'succeeded', ms: 1 });
    expect(h.size).toBe(5);
    const p1 = h.page({ limit: 2 });
    expect(p1.entries.map((e) => e.requestId)).toEqual(['r7', 'r6']);
    expect(p1.hasMore).toBe(true);
    const p2 = h.page({ beforeId: p1.entries[1]!.id, limit: 10 });
    expect(p2.entries.map((e) => e.requestId)).toEqual(['r5', 'r4', 'r3']);
    expect(p2.hasMore).toBe(false);
  });

  it('파이프라인 형식(harness.run) 결과: 질문·실패 코드', () => {
    const run = { action: { requestId: 'r', operationId: 'o', decision: { headOutputs: { intention: { value: 'approve_pr', confidence: 0.9 } }, overallConfidence: 0.9, route: 'harness' }, deadlineAt: 'x' }, transcript: { text: 'PR 15번 승인해', isFinal: true, sttConfidence: 0.84 }, context: { requestId: 'r', turnId: 't', transcript: { text: '', isFinal: true }, stamp: { conversationId: 'c1' } } };
    const q = historyEntryFrom({ kind: 'harness.run', requestId: 'r', payload: run }, { ok: true, payload: { action: { operationId: 'o', status: 'needs_clarification', facts: {} }, question: 'PR 15번을 승인할까요?', resultText: null } }, 5);
    expect(q).toMatchObject({ input: 'PR 15번 승인해', route: 'approve_pr', conversationId: 'c1', sttConfidence: 0.84, status: 'question', resultText: 'PR 15번을 승인할까요?' });
    const f = historyEntryFrom({ kind: 'harness.run', requestId: 'r', payload: run }, { ok: true, payload: { action: { operationId: 'o', status: 'failed', facts: {}, error: { code: 'POLICY_BLOCKED', message: 'm', retryable: false } }, question: null, resultText: '승인할 수 없어요.' } }, 5);
    expect(f).toMatchObject({ status: 'failed', errorCode: 'POLICY_BLOCKED', resultText: '승인할 수 없어요.' });
    expect(historyEntryFrom({ kind: 'output.generate', requestId: 'r', payload: {} }, { ok: true, payload: {} }, 1)).toBeUndefined();
  });

  it('화면 검색·필터', () => {
    const h = new HistoryLog();
    h.append({ kind: 'harness.run', requestId: 'a', input: 'PR 리뷰해', status: 'succeeded', ms: 1 });
    h.append({ kind: 'harness.run', requestId: 'b', input: '마감 미뤄', status: 'failed', errorCode: 'LOW_CONFIDENCE', ms: 1 });
    const all = h.page().entries;
    expect(filterHistory(all, '리뷰', 'all').map((e) => e.requestId)).toEqual(['a']);
    expect(filterHistory(all, '', 'failed').map((e) => e.requestId)).toEqual(['b']);
    expect(filterHistory(all, 'low_conf', 'all').map((e) => e.requestId)).toEqual(['b']);
  });
});

describe('서버 정보 (D-49)', () => {
  it('접속 직후 보내고 publishInfo로 다시 보낸다', async () => {
    let n = 0;
    const { server, port } = await boot({ info: () => ({ version: { commit: `c${++n}` } }) });
    const v = await client(port, 'viewer', '');
    expect(((await v.waitFor((f) => f.type === 'server.info'))['info'] as { version: { commit: string } }).version.commit).toBe('c1');
    server.publishInfo();
    await v.waitFor((f) => f.type === 'server.info' && (f['info'] as { version: { commit: string } }).version.commit === 'c2');
  });
});

describe('관리 동작 (D-50)', () => {
  it('관리 토큰이 맞을 때만 처리한다. 틀리면 거부하고 5번 틀리면 연결을 닫는다', async () => {
    const { port, calls } = await boot({ admin: true });
    const v = await client(port, 'viewer', '');
    v.send({ type: 'admin', token: ADMIN, action: 'update.check', id: 'x1' });
    expect(await v.waitFor((f) => f.type === 'admin.result' && f['id'] === 'x1')).toMatchObject({ ok: true, message: 'did update.check' });
    expect(calls).toEqual(['update.check']);
    for (let i = 0; i < 5; i++) {
      v.send({ type: 'admin', token: TOKEN, action: 'update.apply', id: `bad${i}` });
      expect(await v.waitFor((f) => f.type === 'admin.result' && f['id'] === `bad${i}`)).toMatchObject({ ok: false, message: 'admin_unauthorized' });
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(v.closed()?.code).toBe(4001);
    expect(calls).toEqual(['update.check']);
  });

  it('관리 토큰이 없는 서버는 관리 동작을 받지 않는다', async () => {
    const { port } = await boot();
    const v = await client(port, 'viewer', '');
    v.send({ type: 'admin', token: ADMIN, action: 'update.apply', id: 'y' });
    expect(await v.waitFor((f) => f.type === 'admin.result')).toMatchObject({ ok: false, message: 'admin_disabled' });
  });

  it('관리 토큰은 16자 이상, 다른 토큰과 달라야 한다', () => {
    const w = createWorld();
    const base = { inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }), store: w.store, token: TOKEN, port: 0 };
    expect(() => new HarnessWsServer({ ...base, adminToken: 'short' })).toThrow();
    expect(() => new HarnessWsServer({ ...base, adminToken: TOKEN })).toThrow();
  });
});
