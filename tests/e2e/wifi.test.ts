import { afterEach, describe, expect, it } from 'vitest';
import { OutputService } from '@deskpet/output';
import { DirectHarnessInbound, HarnessWsServer } from '@deskpet/server';
import type { Runner } from '../../scripts/updater.js';
import { WifiManager, parseNetworks, splitTerse } from '../../scripts/wifi.js';
import { createWorld } from '../support/world.js';

/**
 * D-59 웹 설정에서 Wi-Fi 찾기·연결 (관리 토큰 없이, 사용자 결정 2026-11-20).
 * nmcli는 가짜: 받은 인자를 기록하고 정해 둔 출력을 돌려준다
 */
const DEV = 'wlP1p1s0:wifi:connected:hansung-GTC\neno1:ethernet:unavailable:\nlo:loopback:unmanaged:\n';
const LIST = '*:hansung-GTC:72:WPA2 802.1X\n :hansung-GTC:40:WPA2 802.1X\n :Home\\:5G:81:WPA2\n :Free:30:--\n :::\n';

function fakeNmcli(o: { connectFails?: string; noNmcli?: boolean; state?: string } = {}) {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (o.noNmcli) return { code: -1, stdout: '', stderr: 'spawn nmcli ENOENT' };
    const a = args.join(' ');
    if (a.includes('device status')) return { code: 0, stdout: o.state ? DEV.replace('connected', o.state) : DEV, stderr: '' };
    if (a.startsWith('-t -f ACTIVE,SSID,SIGNAL')) return { code: 0, stdout: 'yes:hansung-GTC:72\nno:Home:81\n', stderr: '' };
    if (a.includes('IP4.ADDRESS')) return { code: 0, stdout: '223.194.153.222/22\n', stderr: '' };
    if (a.includes('IN-USE,SSID')) return { code: 0, stdout: LIST, stderr: '' };
    if (args[0] === 'device' && args[1] === 'wifi' && args[2] === 'connect') {
      return o.connectFails ? { code: 4, stdout: '', stderr: o.connectFails } : { code: 0, stdout: "Device 'wlP1p1s0' successfully activated", stderr: '' };
    }
    if (args[0] === 'connection') return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { run, calls };
}

describe('nmcli 출력 읽기', () => {
  it('\\: 는 글자로, 같은 SSID는 연결 중이거나 신호가 센 것 하나로', () => {
    expect(splitTerse('a\\:b:c\\\\d:')).toEqual(['a:b', 'c\\d', '']);
    expect(parseNetworks(LIST)).toEqual([
      { ssid: 'hansung-GTC', signal: 72, security: 'WPA2 802.1X', inUse: true, enterprise: true },
      { ssid: 'Home:5G', signal: 81, security: 'WPA2', inUse: false, enterprise: false },
      { ssid: 'Free', signal: 30, security: '', inUse: false, enterprise: false },
    ]);
  });
});

describe('WifiManager', () => {
  it('상태: 장치·SSID·신호·주소', async () => {
    const { run } = fakeNmcli();
    const changes: unknown[] = [];
    const w = new WifiManager({ run, onChange: (s) => changes.push(s) });
    const s = await w.refresh();
    expect(s).toMatchObject({ available: true, device: 'wlP1p1s0', state: 'connected', ssid: 'hansung-GTC', signal: 72, ip: '223.194.153.222' });
    await w.refresh();
    expect(changes).toHaveLength(1);
  });

  it('nmcli가 없거나 꺼 두면 쓸 수 없음', async () => {
    expect((await new WifiManager({ run: fakeNmcli({ noNmcli: true }).run }).refresh()).available).toBe(false);
    const off = new WifiManager({ enabled: false, run: fakeNmcli().run });
    expect(await off.refresh()).toMatchObject({ available: false, reason: expect.stringContaining('DESKPET_WIFI=off') });
    const win = new WifiManager({ enabled: false, disabledReason: '리눅스가 아니라', run: fakeNmcli().run });
    expect(win.status.reason).toBe('리눅스가 아니라');
  });

  it('개인 Wi-Fi 연결: 인자 배열로 넘기고, 실패 출력에 섞인 비밀번호는 가린다', async () => {
    const ok = fakeNmcli();
    const r = await new WifiManager({ run: ok.run }).connect({ ssid: 'Home:5G', password: 'pa ss;$(rm -rf)' });
    expect(r).toMatchObject({ ok: true });
    expect(ok.calls).toContainEqual(['nmcli', 'device', 'wifi', 'connect', 'Home:5G', 'password', 'pa ss;$(rm -rf)', 'ifname', 'wlP1p1s0']);

    const bad = fakeNmcli({ connectFails: 'Error: Connection activation failed: Secrets were required, but not provided (pw secret123)' });
    const logs: string[] = [];
    const f = await new WifiManager({ run: bad.run, log: (l) => logs.push(l) }).connect({ ssid: 'Home', password: 'secret123' });
    expect(f.ok).toBe(false);
    expect(f.message).toBe('비밀번호(또는 아이디) 불일치');
    expect(JSON.stringify(logs)).not.toContain('secret123');
  });

  it('계정 Wi-Fi(아이디 있음): 802.1X 프로필을 만들어 올린다', async () => {
    const { run, calls } = fakeNmcli();
    const r = await new WifiManager({ run }).connect({ ssid: 'hansung-GTC', identity: '2091000', password: 'pw' });
    expect(r.ok).toBe(true);
    const add = calls.find((c) => c[1] === 'connection' && c[2] === 'add')!;
    expect(add).toEqual(expect.arrayContaining(['ssid', 'hansung-GTC', 'wifi-sec.key-mgmt', 'wpa-eap', '802-1x.identity', '2091000', '802-1x.password', 'pw']));
    expect(calls).toContainEqual(['nmcli', 'connection', 'up', 'id', 'hansung-GTC']);
  });

  it('권한 오류는 polkit 안내로, 줄바꿈 든 비밀번호는 거절', async () => {
    const { run } = fakeNmcli({ connectFails: 'Error: Not authorized to control networking.' });
    expect((await new WifiManager({ run }).connect({ ssid: 'Home', password: 'x' })).message).toContain('polkit');
    expect((await new WifiManager({ run }).connect({ ssid: 'Home', password: 'a\nb' })).ok).toBe(false);
    expect((await new WifiManager({ run }).connect({ ssid: ' ' })).ok).toBe(false);
  });

  it('찾기: 목록과 현재 상태', async () => {
    const r = await new WifiManager({ run: fakeNmcli().run }).scan();
    expect(r.ok).toBe(true);
    expect(r.networks?.map((n) => n.ssid)).toEqual(['hansung-GTC', 'Home:5G', 'Free']);
    expect(r.status?.ssid).toBe('hansung-GTC');
  });
});

const servers: HarnessWsServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

describe('wifi 프레임', () => {
  it('관리 토큰 없이 보기 전용 연결도 연결할 수 있고, 서버 로그에 비밀번호가 남지 않는다', async () => {
    const w = createWorld();
    const got: unknown[] = [];
    const logs: string[] = [];
    const server = new HarnessWsServer({
      inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }),
      store: w.store,
      token: 'test-token-0123456789abcdef',
      openViewer: true,
      port: 0,
      log: (l) => logs.push(l),
      wifi: async (r) => {
        got.push(r);
        return { ok: true, message: '연결했어요', data: { status: { available: true, ssid: r.ssid } } };
      },
    });
    servers.push(server);
    const { port } = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token: '', role: 'viewer' })));
      ws.addEventListener('message', (e) => {
        const f = JSON.parse(String(e.data)) as Record<string, unknown>;
        if (f['type'] === 'welcome') ws.send(JSON.stringify({ type: 'wifi', id: 'w1', action: 'connect', ssid: 'Home', password: 'topsecret-pw' }));
        if (f['type'] === 'wifi.result') resolve(f);
      });
    });
    ws.close();
    expect(reply).toMatchObject({ id: 'w1', action: 'connect', ok: true, message: '연결했어요', data: { status: { ssid: 'Home' } } });
    expect(got).toEqual([{ action: 'connect', ssid: 'Home', password: 'topsecret-pw' }]);
    expect(logs.join('\n')).not.toContain('topsecret-pw');
  });
});
