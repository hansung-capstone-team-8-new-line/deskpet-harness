import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OutputService } from '@deskpet/output';
import { DirectHarnessInbound, HarnessWsServer, parseClientRules } from '@deskpet/server';
import { createWorld } from '../support/world.js';

/** D-25 다른 기기 접속: 클라이언트 IP 허용 목록 + 선택 TLS */
const TOKEN = 'remote-token-0123456789abcdef';
const servers: HarnessWsServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(500);
});
const lanIp = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

async function boot(o: { allowedClients?: string[]; tls?: { cert: string; key: string } } = {}) {
  const w = createWorld();
  const server = new HarnessWsServer({ inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }), store: w.store, token: TOKEN, host: '0.0.0.0', port: 0, ...o });
  servers.push(server);
  return (await server.start()).port;
}

/** 연결 결과: welcome이면 'ok', HTTP 거부면 'rejected' */
function tryConnect(url: string, opts?: unknown): Promise<'ok' | 'rejected'> {
  return new Promise((resolve) => {
    const ws = new (WebSocket as unknown as new (u: string, o?: unknown) => WebSocket)(url, opts);
    const t = setTimeout(() => resolve('rejected'), 2_000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN, role: 'pipeline' })));
    ws.addEventListener('message', (e) => {
      if (String(e.data).includes('welcome')) {
        clearTimeout(t);
        ws.close();
        resolve('ok');
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(t);
      resolve('rejected');
    });
  });
}

describe('클라이언트 주소 규칙', () => {
  it('IPv4 주소·CIDR·IPv6 정확히 일치', () => {
    const [a, b, c] = parseClientRules(['192.168.0.20', '10.1.0.0/16', 'fe80::1']);
    expect([a!('192.168.0.20'), a!('192.168.0.21')]).toEqual([true, false]);
    expect([b!('10.1.200.3'), b!('10.2.0.1')]).toEqual([true, false]);
    expect([c!('fe80::1'), c!('fe80::2')]).toEqual([true, false]);
    expect(() => parseClientRules(['10.0.0.0/40'])).toThrow();
  });
});

describe.skipIf(!lanIp)('다른 기기 접속 (이 기기의 LAN 주소로 붙어 loopback이 아닌 접속을 만든다)', () => {
  it('허용 목록이 비면 loopback만 받는다', async () => {
    const port = await boot();
    expect(await tryConnect(`ws://127.0.0.1:${port}`)).toBe('ok');
    expect(await tryConnect(`ws://${lanIp}:${port}`)).toBe('rejected');
  });

  it('허용한 주소·대역이면 받는다', async () => {
    const port = await boot({ allowedClients: [`${lanIp!.split('.').slice(0, 3).join('.')}.0/24`] });
    expect(await tryConnect(`ws://${lanIp}:${port}`)).toBe('ok');
  });

  it('TLS 인증서를 주면 wss로 연다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deskpet-tls-'));
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    } catch {
      return; // openssl 없음
    }
    const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
    const port = await boot({ tls: { cert, key: readFileSync(join(dir, 'k.pem'), 'utf8') } });
    expect(await tryConnect(`ws://127.0.0.1:${port}`)).toBe('rejected');
    const prev = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // 시험용 자체 서명 인증서
    try {
      expect(await tryConnect(`wss://127.0.0.1:${port}`)).toBe('ok');
    } finally {
      if (prev === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = prev;
    }
  });
});
