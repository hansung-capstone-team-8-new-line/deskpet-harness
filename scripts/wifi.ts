import { defaultRunner, type Runner } from './updater.js';

/**
 * Wi-Fi 설정 (D-59, 2026-11-20 사용자 결정 — 웹 설정에서 관리 토큰 없이).
 * 젯슨의 NetworkManager(nmcli)를 부른다. 인자는 배열로 넘기고 셸을 거치지 않는다.
 *
 * - 상태: Wi-Fi 장치, 연결 상태, 연결된 SSID·신호·IP
 * - 찾기: 주변 Wi-Fi 목록 (SSID 같은 것은 신호가 센 것 하나로)
 * - 연결: 개인용(WPA-PSK·개방) = nmcli device wifi connect / 학교·회사 계정(WPA2-Enterprise, PEAP+MSCHAPv2) = 연결 프로필을 만들어 올림
 * - 비밀번호는 NetworkManager에만 저장한다. 이 서버의 파일·기록·로그에는 남기지 않고, nmcli 출력에 섞여 나오면 가린다
 * - 한 번에 하나만 처리한다
 * nmcli가 없거나(Windows·macOS) DESKPET_WIFI=off면 꺼짐으로 보인다.
 * 권한: 로그인 화면 없이 서비스로 돌면 polkit이 막을 수 있다 → docs의 polkit 규칙 (메시지에 안내)
 */
export interface WifiStatus {
  available: boolean;
  /** 꺼진 이유 */
  reason?: string;
  device?: string;
  /** connected · connecting · disconnected · unavailable 등 (nmcli 장치 상태) */
  state?: string;
  ssid?: string;
  signal?: number;
  ip?: string;
  checkedAt?: string;
}

export interface WifiNetwork {
  ssid: string;
  signal: number;
  /** 빈 문자열이면 개방 */
  security: string;
  inUse: boolean;
  /** WPA2-Enterprise(802.1X): 아이디가 필요 */
  enterprise: boolean;
}

export interface WifiConnectRequest {
  ssid: string;
  password?: string;
  /** 학교·회사 계정 Wi-Fi의 아이디 (있으면 WPA2-Enterprise로 연결) */
  identity?: string;
}

export interface WifiResult {
  ok: boolean;
  message: string;
  status?: WifiStatus;
  networks?: WifiNetwork[];
}

export interface WifiOptions {
  run?: Runner;
  now?: () => number;
  enabled?: boolean;
  /** 꺼져 있을 때 보여 줄 이유 */
  disabledReason?: string;
  onChange?: (s: WifiStatus) => void;
  log?: (line: string) => void;
}

const NMCLI = 'nmcli';

/** nmcli -t 출력 한 줄을 필드로 나눈다 (\: 와 \\ 는 글자) */
export function splitTerse(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else if (c === ':') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseNetworks(stdout: string): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [inUse = '', ssid = '', signal = '0', security = ''] = splitTerse(line);
    if (!ssid) continue;
    const n: WifiNetwork = { ssid, signal: Number(signal) || 0, security: security.trim() === '--' ? '' : security.trim(), inUse: inUse.trim() === '*', enterprise: /802\.1X/i.test(security) };
    const prev = best.get(ssid);
    if (!prev || n.inUse || (!prev.inUse && n.signal > prev.signal)) best.set(ssid, { ...n, inUse: n.inUse || !!prev?.inUse });
  }
  return [...best.values()].sort((a, b) => Number(b.inUse) - Number(a.inUse) || b.signal - a.signal);
}

export class WifiManager {
  private s: WifiStatus;
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly run: Runner;

  constructor(private readonly o: WifiOptions = {}) {
    this.run = o.run ?? defaultRunner;
    this.s = o.enabled === false ? { available: false, reason: o.disabledReason ?? '꺼짐 (DESKPET_WIFI=off)' } : { available: false, reason: '확인 전' };
  }

  get status(): WifiStatus {
    return this.s;
  }

  private nm(args: string[], timeoutMs = 15_000) {
    return this.run(NMCLI, args, { cwd: process.cwd(), timeoutMs });
  }

  private set(s: WifiStatus) {
    const changed = JSON.stringify({ ...s, checkedAt: undefined }) !== JSON.stringify({ ...this.s, checkedAt: undefined });
    this.s = s;
    if (changed) this.o.onChange?.(s);
  }

  /** 주기 상태 확인 (연결이 바뀌면 웹에 알림) */
  start(intervalMs = 30_000) {
    if (this.o.enabled === false) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<WifiStatus> {
    if (this.o.enabled === false) return this.s;
    const dev = await this.nm(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']);
    if (dev.code !== 0) {
      this.set({ available: false, reason: dev.code === -1 ? '이 기기에는 NetworkManager(nmcli)가 없어요' : 'Wi-Fi 상태를 읽지 못했어요', checkedAt: this.iso() });
      return this.s;
    }
    const wifi = dev.stdout
      .split('\n')
      .map(splitTerse)
      .find((f) => f[1] === 'wifi');
    if (!wifi) {
      this.set({ available: false, reason: 'Wi-Fi 장치가 없어요', checkedAt: this.iso() });
      return this.s;
    }
    const [device = '', , state = ''] = wifi;
    const s: WifiStatus = { available: true, device, state: state.split(' ')[0] ?? state, checkedAt: this.iso() };
    if (s.state === 'connected') {
      const act = await this.nm(['-t', '-f', 'ACTIVE,SSID,SIGNAL', 'device', 'wifi', 'list', 'ifname', device, '--rescan', 'no']);
      const a = act.stdout.split('\n').map(splitTerse).find((f) => f[0] === 'yes');
      if (a) {
        s.ssid = a[1];
        s.signal = Number(a[2]) || undefined;
      }
      const ip = await this.nm(['-t', '-g', 'IP4.ADDRESS', 'device', 'show', device]);
      const addr = ip.stdout.split('\n')[0]?.split('|')[0]?.trim();
      if (addr) s.ip = addr.split('/')[0];
    }
    this.set(s);
    return this.s;
  }

  async scan(): Promise<WifiResult> {
    const st = await this.refresh();
    if (!st.available) return { ok: false, message: st.reason ?? 'Wi-Fi를 쓸 수 없어요', status: st };
    const args = ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', 'ifname', st.device!];
    let r = await this.nm([...args, '--rescan', 'yes'], 30_000);
    // 다시 찾기 권한이 없거나 너무 자주 누르면 마지막 결과라도
    if (r.code !== 0) r = await this.nm([...args, '--rescan', 'no']);
    if (r.code !== 0) return { ok: false, message: this.explain(r.stderr || r.stdout, '주변 Wi-Fi를 찾지 못했어요'), status: st };
    const networks = parseNetworks(r.stdout);
    return { ok: true, message: networks.length ? `${networks.length}개 찾음` : '찾은 Wi-Fi가 없어요', status: st, networks };
  }

  async connect(req: WifiConnectRequest): Promise<WifiResult> {
    const ssid = req.ssid?.trim();
    if (!ssid || ssid.length > 32 * 4) return { ok: false, message: 'Wi-Fi 이름을 확인해 주세요' };
    if (req.password && (req.password.length > 128 || /[\r\n\0]/.test(req.password))) return { ok: false, message: '비밀번호 형식을 확인해 주세요' };
    if (req.identity && (req.identity.length > 128 || /[\r\n\0]/.test(req.identity))) return { ok: false, message: '아이디 형식을 확인해 주세요' };
    if (this.busy) return { ok: false, message: '다른 Wi-Fi 연결을 처리하고 있어요. 잠시 뒤 다시 눌러 주세요' };
    const st = await this.refresh();
    if (!st.available) return { ok: false, message: st.reason ?? 'Wi-Fi를 쓸 수 없어요', status: st };
    this.busy = true;
    this.o.log?.(`Wi-Fi 연결 요청: ${ssid}${req.identity ? ' (계정 Wi-Fi)' : ''}`);
    const secret = [req.password, req.identity].filter((x): x is string => !!x);
    try {
      const dev = st.device!;
      let r;
      if (req.identity) {
        // 같은 이름의 예전 프로필은 지우고 새로 만든다 (아이디·비밀번호를 바꿀 때)
        await this.nm(['connection', 'delete', 'id', ssid]);
        const add = await this.nm([
          'connection', 'add', 'type', 'wifi', 'ifname', dev, 'con-name', ssid, 'ssid', ssid,
          'wifi-sec.key-mgmt', 'wpa-eap', '802-1x.eap', 'peap', '802-1x.phase2-auth', 'mschapv2',
          '802-1x.identity', req.identity, '802-1x.password', req.password ?? '',
        ]);
        if (add.code !== 0) return { ok: false, message: this.explain(this.hide(add.stderr || add.stdout, secret), 'Wi-Fi 설정을 만들지 못했어요'), status: await this.refresh() };
        r = await this.nm(['connection', 'up', 'id', ssid], 60_000);
      } else {
        r = await this.nm(['device', 'wifi', 'connect', ssid, ...(req.password ? ['password', req.password] : []), 'ifname', dev], 60_000);
      }
      const status = await this.refresh();
      if (r.code !== 0) {
        const msg = this.explain(this.hide(r.stderr || r.stdout, secret), '연결하지 못했어요');
        this.o.log?.(`Wi-Fi 연결 실패: ${ssid} — ${msg}`);
        return { ok: false, message: msg, status };
      }
      this.o.log?.(`Wi-Fi 연결됨: ${ssid}${status.ip ? ` (${status.ip})` : ''}`);
      return { ok: true, message: `${ssid}에 연결했어요${status.ip ? ` — 주소 ${status.ip}` : ''}`, status };
    } finally {
      this.busy = false;
    }
  }

  /** nmcli 오류를 알아듣기 쉬운 문장으로 */
  private explain(out: string, fallback: string): string {
    const t = out.trim();
    if (/not authorized|permission|권한/i.test(t)) return 'Wi-Fi를 바꿀 권한이 없어요. 젯슨에 polkit 규칙을 넣어 주세요 (docs/wifi.md)';
    if (/secrets were required|wrong password|802-1x|psk/i.test(t)) return '비밀번호(또는 아이디)가 맞지 않는 것 같아요';
    if (/no network with ssid/i.test(t)) return '그 이름의 Wi-Fi를 찾지 못했어요. 다시 찾아 주세요';
    if (/timeout|timed out/i.test(t)) return '연결 시간이 초과됐어요. 신호가 약하거나 비밀번호가 틀렸을 수 있어요';
    const line = t.split('\n').filter(Boolean).pop();
    return line ? `${fallback}: ${line.replace(/^Error:\s*/i, '').slice(0, 200)}` : fallback;
  }

  private hide(s: string, secrets: string[]): string {
    let out = s;
    for (const x of secrets) if (x.length >= 1) out = out.split(x).join('***');
    return out;
  }

  private iso() {
    return new Date((this.o.now ?? Date.now)()).toISOString();
  }
}
