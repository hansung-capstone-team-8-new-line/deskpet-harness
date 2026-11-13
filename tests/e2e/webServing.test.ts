import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { OutputService } from '@deskpet/output';
import { DirectHarnessInbound, HarnessWsServer, isSameOriginLiteral } from '@deskpet/server';
import { createWorld } from '../support/world.js';

/** D-42: Harness 서버가 빌드한 웹 화면을 같은 주소·포트로 내보낸다 */
const TOKEN = 'test-token-0123456789abcdef';
const VIEWER = 'viewer-token-0123456789abc';
const servers: HarnessWsServer[] = [];
let tmp: string;
let dist: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'deskpet-web-'));
  dist = join(tmp, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>DeskPet</title><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(tmp, 'secret.txt'), 'SECRET');
  try {
    symlinkSync(join(tmp, 'secret.txt'), join(dist, 'link.txt'));
  } catch {
    /* 심볼릭 링크를 만들 수 없는 환경이면 그 검사만 건너뛴다 */
  }
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(500);
});

async function boot(o: { web?: string | false; allowedOrigins?: string[] } = {}) {
  const w = createWorld();
  const server = new HarnessWsServer({
    inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }),
    store: w.store,
    token: TOKEN,
    viewerToken: VIEWER,
    port: 0,
    helloTimeoutMs: 500,
    ...(o.web === false ? {} : { web: { root: o.web ?? dist } }),
    ...(o.allowedOrigins ? { allowedOrigins: o.allowedOrigins } : {}),
  });
  servers.push(server);
  const { port } = await server.start();
  return { port };
}

function get(port: number, path: string, method = 'GET', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Origin·Host를 직접 정해 WebSocket을 열고 viewer hello까지 */
function wsConnect(port: number, origin?: string, host?: string) {
  return new Promise<'welcome' | number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { ...(origin ? { origin } : {}), ...(host ? { headers: { host } } : {}) });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: VIEWER, role: 'viewer' })));
    ws.on('message', (d) => {
      const f = JSON.parse(String(d)) as { type: string };
      if (f.type === 'welcome') {
        ws.close();
        resolve('welcome');
      }
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => undefined);
  });
}

describe('웹 화면 서빙 (D-42)', () => {
  it('/ 는 index.html, 보안 헤더와 no-cache', async () => {
    const { port } = await boot();
    const r = await get(port, '/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('<div id="root">');
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('빌드 산출물(assets/)은 맞는 형식과 긴 캐시', async () => {
    const { port } = await boot();
    const r = await get(port, '/assets/index-abc123.js');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/javascript');
    expect(r.headers['cache-control']).toContain('immutable');
  });

  it('화면 경로(확장자 없음)는 index.html, 없는 파일은 404', async () => {
    const { port } = await boot();
    expect((await get(port, '/sessions/abc')).body).toContain('<div id="root">');
    expect((await get(port, '/assets/missing.js')).status).toBe(404);
  });

  it('HEAD는 본문 없이, 그 밖의 메서드는 405', async () => {
    const { port } = await boot();
    const h = await get(port, '/', 'HEAD');
    expect(h.status).toBe(200);
    expect(h.body).toBe('');
    expect((await get(port, '/', 'POST')).status).toBe(405);
  });

  it('root 밖 파일은 내보내지 않는다 (../, 인코딩한 ../, 심볼릭 링크)', async () => {
    const { port } = await boot();
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/link.txt', '/%00.txt']) {
      const r = await get(port, p);
      expect(r.body).not.toContain('SECRET');
      expect([400, 404]).toContain(r.status);
    }
  });

  it('빌드가 없으면 안내(503), 웹을 끄면 예전처럼 426', async () => {
    const empty = await boot({ web: join(tmp, 'no-build') });
    const r = await get(empty.port, '/');
    expect(r.status).toBe(503);
    expect(r.body).toContain('pnpm web:build');
    const off = await boot({ web: false });
    expect((await get(off.port, '/')).status).toBe(426);
  });

  it('이 서버가 내보낸 화면(같은 IP 주소 Origin)은 Origin 목록 없이 접속된다', async () => {
    const { port } = await boot();
    expect(await wsConnect(port, `http://127.0.0.1:${port}`)).toBe('welcome');
    expect(await wsConnect(port, `http://localhost:${port}`, `localhost:${port}`)).toBe('welcome');
    // Origin 헤더 없는 클라이언트(파이프라인·데모)는 그대로
    expect(await wsConnect(port)).toBe('welcome');
  });

  it('다른 출처·도메인 이름·포트가 다른 Origin은 거부한다', async () => {
    const { port } = await boot();
    expect(await wsConnect(port, 'http://evil.example')).toBe(403);
    // DNS rebinding: Host와 Origin이 같은 도메인 이름이어도 목록에 없으면 거부
    expect(await wsConnect(port, `http://evil.test:${port}`, `evil.test:${port}`)).toBe(403);
    expect(await wsConnect(port, 'http://127.0.0.1:5173')).toBe(403);
  });

  it('웹 서빙을 끄면 같은 주소 Origin도 목록에 있어야 한다', async () => {
    const { port } = await boot({ web: false });
    expect(await wsConnect(port, `http://127.0.0.1:${port}`)).toBe(403);
    const listed = await boot({ web: false, allowedOrigins: ['http://127.0.0.1:5173'] });
    expect(await wsConnect(listed.port, 'http://127.0.0.1:5173')).toBe('welcome');
  });

  it('같은 출처 판정 규칙', () => {
    expect(isSameOriginLiteral('http://192.168.0.20:8787', '192.168.0.20:8787', false)).toBe(true);
    expect(isSameOriginLiteral('https://192.168.0.20:8787', '192.168.0.20:8787', true)).toBe(true);
    expect(isSameOriginLiteral('http://192.168.0.20:8787', '192.168.0.20:8787', true)).toBe(false);
    expect(isSameOriginLiteral('http://[::1]:8787', '[::1]:8787', false)).toBe(true);
    expect(isSameOriginLiteral('http://jetson.local:8787', 'jetson.local:8787', false)).toBe(false);
    expect(isSameOriginLiteral('http://192.168.0.20:8787', '192.168.0.21:8787', false)).toBe(false);
    expect(isSameOriginLiteral('http://192.168.0.20:8787', undefined, false)).toBe(false);
  });
});
