import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { OutputService } from '@deskpet/output';
import { DirectHarnessInbound, HarnessWsServer } from '@deskpet/server';
import { createWorld } from '../support/world.js';

/**
 * D-45 토큰 없는 보기 전용 접속: HARNESS_WS_VIEWER_TOKEN을 비우면 viewer는 토큰 없이 접속(구독만).
 * pipeline(실행)은 여전히 토큰이 필요하고, viewer는 실행 요청을 보낼 수 없다
 */
const TOKEN = 'test-token-0123456789abcdef';
const servers: HarnessWsServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(500);
});

async function boot(o: { openViewer?: boolean; viewerToken?: string }) {
  const w = createWorld();
  const server = new HarnessWsServer({
    inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }),
    store: w.store,
    token: TOKEN,
    port: 0,
    helloTimeoutMs: 500,
    ...o,
  });
  servers.push(server);
  return (await server.start()).port;
}

/** hello 뒤 첫 응답: welcome이면 역할, 아니면 오류 코드. then이 있으면 그 프레임을 보내고 다음 응답까지 */
function hello(port: number, token: string, role: 'viewer' | 'pipeline', then?: unknown) {
  return new Promise<{ first: string; second?: string }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let first: string | undefined;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, role })));
    ws.on('message', (d) => {
      const f = JSON.parse(String(d)) as { type: string; role?: string; code?: string; ok?: boolean; error?: { code: string } };
      const v = f.type === 'welcome' ? `welcome:${f.role}` : `${f.type}:${f.code ?? f.error?.code ?? ''}`;
      if (first === undefined) {
        first = v;
        if (f.type === 'welcome' && then) return ws.send(JSON.stringify(then));
        ws.close();
        return resolve({ first });
      }
      ws.close();
      resolve({ first, second: v });
    });
    ws.on('close', () => resolve({ first: first ?? 'closed' }));
    ws.on('error', () => undefined);
  });
}

describe('토큰 없는 보기 전용 접속 (D-45)', () => {
  it('openViewer면 viewer는 토큰 없이 접속, 구독만 된다', async () => {
    const port = await boot({ openViewer: true });
    expect((await hello(port, '', 'viewer')).first).toBe('welcome:viewer');
    const r = await hello(port, '', 'viewer', { type: 'request', envelope: {} });
    expect(r.second).toContain('forbidden');
  });

  it('openViewer여도 pipeline(실행)은 토큰이 있어야 한다', async () => {
    const port = await boot({ openViewer: true });
    expect((await hello(port, '', 'pipeline')).first).toBe('error:unauthorized');
    expect((await hello(port, 'wrong-token-xxxxxxxxxxxx', 'pipeline')).first).toBe('error:unauthorized');
    expect((await hello(port, TOKEN, 'pipeline')).first).toBe('welcome:pipeline');
  });

  it('보기 전용 토큰을 설정하면 지금처럼 토큰이 필요하다', async () => {
    const port = await boot({ viewerToken: 'viewer-token-0123456789abc' });
    expect((await hello(port, '', 'viewer')).first).toBe('error:unauthorized');
    expect((await hello(port, 'viewer-token-0123456789abc', 'viewer')).first).toBe('welcome:viewer');
  });

  it('openViewer와 viewerToken은 같이 쓸 수 없다', () => {
    const w = createWorld();
    expect(() => new HarnessWsServer({ inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }), store: w.store, token: TOKEN, port: 0, openViewer: true, viewerToken: 'viewer-token-0123456789abc' })).toThrow();
  });
});
