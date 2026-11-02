import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { clampPayloadDeadline, parseEnvelope, SUPPORTED_MAJOR, type Envelope } from '@deskpet/contracts';
import type { OperationStore, StoreChange } from '@deskpet/harness';
import { fromStoreChange, snapshotFromHarness } from '@deskpet/projector';
import type { HarnessInbound } from './inbound.js';
import { UnsupportedKindError } from './inbound.js';
import { CLOSE, ClientFrame, PROTOCOL, type ErrorCode, type Role, type ServerFrame } from './protocol.js';

/**
 * Harness 서비스 경계 (WebSocket). 근거: message-contracts §Envelope, §Output and Projection, Liability §Ownership.
 *
 * 규칙
 * - 기본 바인딩은 127.0.0.1. 첫 프레임 hello의 토큰으로 인증한다 (프로세스 간 호출은 인증된 경계).
 * - 브라우저(Origin 헤더 있음)는 allowedOrigins에 있는 Origin만 받는다.
 * - 역할: pipeline = 실행·구독, viewer = 구독만.
 * - 연결 끊김은 취소가 아니다. 진행 중인 요청은 끝까지 처리하고 결과는 Harness 기록에 남는다.
 *   같은 messageId 재전송 → 같은 응답, 같은 turnId 재전송 → Harness가 저장된 결과를 돌려준다.
 * - Envelope 검증 실패·지원하지 않는 kind·major는 실행 전에 거부한다.
 * - 상한: 메시지 크기, 연결당 동시 요청 수, 송신 버퍼(느린 구독자는 끊는다 — Harness를 막지 않음).
 * - 구독: snapshot(scope=source 전체, epoch) 1회 → 이후 변경 이벤트. 클라이언트는 더 높은 revision만 적용한다.
 */
export interface HarnessWsServerOptions {
  inbound: HarnessInbound;
  /** 상태 이벤트·snapshot 원본 */
  store: Pick<OperationStore, 'subscribe' | 'readProjectionSnapshot'>;
  /** pipeline 토큰: 실행 + 구독 */
  token: string;
  /** viewer 전용 토큰(선택): 구독만. 브라우저 화면에는 이 토큰만 넣는다 */
  viewerToken?: string;
  host?: string;
  port?: number;
  allowedOrigins?: string[];
  /**
   * 접속을 받을 클라이언트 IP (D-25). IPv4 주소 또는 CIDR(예: 192.168.0.0/24). 이 기기 자신(loopback)은 항상 허용.
   * 비우면 loopback만 받는다. 다른 기기(Jetson·파이프라인 보드)에서 붙으려면 그 주소를 넣는다
   */
  allowedClients?: string[];
  /** wss(TLS) 인증서·키 (PEM 문자열). 주면 wss://로 연다 (D-25) */
  tls?: { cert: string; key: string };
  maxPayloadBytes?: number;
  maxInFlightPerConnection?: number;
  maxBufferedBytes?: number;
  helloTimeoutMs?: number;
  /** 같은 messageId 응답을 기억하는 개수 */
  replayCacheSize?: number;
  /** 서버 전체 동시 처리 상한 (연결 수와 무관, control 칸 제외). 기본 32 */
  maxInFlightTotal?: number;
  /**
   * 칸별 동시 처리 상한 (D-24). 입구 상한은 폭주 방지용이고, 실제 자원 상한은 LLM·GitHub·Eureka 호출마다 따로 둔다.
   * - work: harness.*·output.* (LLM을 쓸 수 있음). 기본 16
   * - eureka: eureka.execute/reminders/reminder/links. 기본 16
   * - control: pipeline.event·harness.cancel·*.reconcile — 승인 흐름이 입구에서 막히지 않도록 다른 칸·연결 상한과 별도. 기본 64
   */
  maxInFlightByLane?: Partial<Record<Lane, number>>;
  /** snapshot 전송 전에 모아 둘 이벤트 상한. 넘으면 그 연결을 닫아 다시 구독하게 한다. 기본 1000 */
  maxPendingEvents?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** 요청 하나를 끝낼 때마다 (처리 시간 기록용, NFR-01) */
  onCompleted?: (info: { kind: string; requestId: string; ms: number; ok: boolean; payload?: unknown }) => void;
}

export type Lane = 'work' | 'eureka' | 'control';
const CONTROL_KINDS = new Set(['pipeline.event', 'harness.cancel', 'harness.reconcile', 'eureka.reconcile']);
export function laneOf(kind: string): Lane {
  if (CONTROL_KINDS.has(kind)) return 'control';
  if (kind.startsWith('eureka.')) return 'eureka';
  return 'work';
}
const LANE_DEFAULTS: Record<Lane, number> = { work: 16, eureka: 16, control: 64 };

interface Conn {
  id: number;
  ws: WebSocket;
  role?: Role;
  inFlight: number;
  subscribed: boolean;
  /** snapshot 전송 전에 들어온 이벤트 */
  pendingEvents: unknown[] | null;
}

interface CachedReply {
  fingerprint: string;
  reply: Promise<ServerFrame>;
}

export class HarnessWsServer {
  private wss?: WebSocketServer;
  private https?: HttpsServer;
  private readonly conns = new Set<Conn>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly laneInFlight: Record<Lane, number> = { work: 0, eureka: 0, control: 0 };
  private readonly replies = new Map<string, CachedReply>();
  private readonly tokenDigest: Buffer;
  private readonly viewerDigest?: Buffer;
  private readonly epoch = Date.now();
  private unsubscribe?: () => void;
  private stopping = false;
  private nextId = 0;
  private readonly log: (line: string) => void;

  constructor(private readonly o: HarnessWsServerOptions) {
    if (!o.token || o.token.length < 16) throw new Error('server token must be at least 16 characters');
    this.tokenDigest = digest(o.token);
    if (o.viewerToken !== undefined) {
      if (o.viewerToken.length < 16) throw new Error('viewer token must be at least 16 characters');
      if (o.viewerToken === o.token) throw new Error('viewer token must differ from the pipeline token');
      this.viewerDigest = digest(o.viewerToken);
    }
    this.log = o.log ?? (() => {});
  }

  async start(): Promise<{ host: string; port: number }> {
    const host = this.o.host ?? '127.0.0.1';
    const allowed = new Set(this.o.allowedOrigins ?? []);
    const clients = parseClientRules(this.o.allowedClients ?? []);
    const verifyClient = (info: { origin: string; req: IncomingMessage }, done: (ok: boolean, code?: number, msg?: string) => void) => {
      const ip = normalizeIp(info.req.socket.remoteAddress ?? '');
      if (!isLoopback(ip) && !clients.some((r) => r(ip))) {
        this.log(`거부: 허용되지 않은 클라이언트 주소 ${ip || '(알 수 없음)'}`);
        return done(false, 403, 'client address not allowed');
      }
      const origin = info.origin;
      if (origin && !allowed.has(origin)) {
        this.log(`거부: 허용되지 않은 Origin ${origin}`);
        return done(false, 403, 'origin not allowed');
      }
      done(true);
    };
    const common = { maxPayload: this.o.maxPayloadBytes ?? 256 * 1024, verifyClient };
    if (this.o.tls) {
      this.https = createHttpsServer({ cert: this.o.tls.cert, key: this.o.tls.key });
      this.wss = new WebSocketServer({ ...common, server: this.https });
      await new Promise<void>((resolve, reject) => {
        this.https!.once('error', reject);
        this.https!.listen(this.o.port ?? 8787, host, () => resolve());
      });
    } else {
      this.wss = new WebSocketServer({ ...common, host, port: this.o.port ?? 8787 });
      await new Promise<void>((resolve, reject) => {
        this.wss!.once('listening', resolve);
        this.wss!.once('error', reject);
      });
    }
    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.unsubscribe = this.o.store.subscribe((c) => this.broadcast(c));
    const addr = (this.https ? this.https.address() : this.wss.address()) as AddressInfo;
    this.log(`Harness WebSocket 서버 ${this.o.tls ? 'wss' : 'ws'}://${host}:${addr.port} (protocol ${PROTOCOL}, epoch ${this.epoch})`);
    return { host, port: addr.port };
  }

  /** 새 연결을 받지 않고, 진행 중 요청이 끝나길 기다린 뒤(최대 drainMs) 연결을 닫는다 */
  async stop(drainMs = 30_000): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    const wss = this.wss;
    if (!wss) return;
    const drained = Promise.allSettled([...this.inFlight]);
    await Promise.race([drained, new Promise((r) => setTimeout(r, drainMs))]);
    for (const c of this.conns) c.ws.close(CLOSE.shuttingDown, 'server shutting down');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (this.https) await new Promise<void>((resolve) => this.https!.close(() => resolve()));
    this.log('Harness WebSocket 서버 종료');
  }

  /** 테스트·진단용 */
  get connectionCount(): number {
    return this.conns.size;
  }
  inFlightIdle(): Promise<void> {
    return Promise.allSettled([...this.inFlight]).then(() => undefined);
  }

  // ---------------------------------------------------------------- connection
  private onConnection(ws: WebSocket) {
    const conn: Conn = { id: ++this.nextId, ws, inFlight: 0, subscribed: false, pendingEvents: null };
    this.conns.add(conn);
    const helloTimer = setTimeout(() => {
      if (!conn.role) ws.close(CLOSE.helloTimeout, 'hello timeout');
    }, this.o.helloTimeoutMs ?? 5_000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.protocolError(conn, 'invalid_frame', 'binary frames are not supported');
      void this.onMessage(conn, data);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.conns.delete(conn);
      // 끊김은 취소가 아니다: 진행 중 요청은 계속 처리된다
      if (conn.role) this.log(`연결 종료 #${conn.id} (${conn.role})${conn.inFlight ? `, 처리 중 요청 ${conn.inFlight}건은 계속 진행` : ''}`);
    });
    ws.on('error', () => ws.terminate());
  }

  private async onMessage(conn: Conn, data: RawData) {
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      return this.protocolError(conn, 'invalid_frame', 'not JSON');
    }
    const f = ClientFrame.safeParse(raw);
    if (!f.success) return this.protocolError(conn, 'invalid_frame', f.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const frame = f.data;

    if (!conn.role) {
      if (frame.type !== 'hello') {
        this.send(conn, { type: 'error', code: 'hello_required', message: 'first frame must be hello' });
        return conn.ws.close(CLOSE.unauthorized, 'hello required');
      }
      // pipeline 토큰은 두 역할 모두, viewer 토큰은 viewer 역할만 허용한다 (역할은 토큰이 정한다)
      const d = digest(frame.token);
      const isPipeline = timingSafeEqual(d, this.tokenDigest);
      const isViewer = !!this.viewerDigest && timingSafeEqual(d, this.viewerDigest);
      if (!isPipeline && !(isViewer && frame.role === 'viewer')) {
        this.log(`거부: 토큰 불일치 (#${conn.id})`);
        this.send(conn, { type: 'error', code: 'unauthorized', message: 'invalid token' });
        return conn.ws.close(CLOSE.unauthorized, 'unauthorized');
      }
      conn.role = frame.role;
      this.log(`연결 #${conn.id} 인증됨 (${frame.role}${frame.client ? `, ${frame.client}` : ''})`);
      return this.send(conn, { type: 'welcome', protocol: PROTOCOL, schemaVersion: `${SUPPORTED_MAJOR}.0`, role: frame.role, epoch: this.epoch, serverTime: new Date().toISOString() });
    }

    switch (frame.type) {
      case 'hello':
        return this.protocolError(conn, 'invalid_frame', 'already authenticated');
      case 'ping':
        return this.send(conn, { type: 'pong', id: frame.id });
      case 'subscribe':
        return this.subscribe(conn);
      case 'request':
        return this.onRequest(conn, frame.envelope);
    }
  }

  // ------------------------------------------------------------------- requests
  private async onRequest(conn: Conn, rawEnvelope: unknown) {
    const ids = peekIds(rawEnvelope);
    const fail = (code: ErrorCode, message: string, issues?: string[]): ServerFrame => ({
      type: 'reply',
      causationId: ids.messageId,
      requestId: ids.requestId,
      ok: false,
      error: { code, message, ...(issues ? { issues } : {}) },
    });
    if (conn.role !== 'pipeline') return this.send(conn, fail('forbidden', 'viewer connections cannot execute requests'));
    if (this.stopping) return this.send(conn, fail('shutting_down', 'server is shutting down'));

    const parsed = parseEnvelope(rawEnvelope);
    if (!parsed.ok) return this.send(conn, fail('invalid_message', 'envelope rejected before execution', parsed.issues));
    const env = parsed.value;
    if (!this.o.inbound.kinds.has(env.kind)) return this.send(conn, fail('unsupported_kind', `kind ${env.kind} is not accepted`));

    // 같은 messageId 재전달 → 같은 응답 (실행은 한 번). 내용이 다르면 거부
    const fingerprint = fingerprintOf(env);
    const cached = this.replies.get(env.messageId);
    if (cached) {
      if (cached.fingerprint !== fingerprint) return this.send(conn, fail('invalid_message', 'messageId reused with different content'));
      return this.send(conn, await cached.reply);
    }
    // 이미 기한이 지난 요청은 실행하지 않는다. 위의 재전달 응답은 실행 결과이므로 그대로 돌려준다 (감사 F-05)
    if (env.deadlineAt && Date.parse(env.deadlineAt) <= (this.o.now ?? Date.now)()) return this.send(conn, fail('deadline_exceeded', 'envelope deadline already passed; not executed'));
    const lane = laneOf(env.kind);
    const laneCap = this.o.maxInFlightByLane?.[lane] ?? LANE_DEFAULTS[lane];
    if (this.laneInFlight[lane] >= laneCap) return this.send(conn, fail('too_many_in_flight', `server is at its concurrent limit for ${lane} requests`));
    if (lane !== 'control') {
      if (this.laneInFlight.work + this.laneInFlight.eureka >= (this.o.maxInFlightTotal ?? 32)) return this.send(conn, fail('too_many_in_flight', 'server is at its concurrent request limit'));
      if (conn.inFlight >= (this.o.maxInFlightPerConnection ?? 8)) return this.send(conn, fail('too_many_in_flight', 'too many concurrent requests on this connection'));
    }

    if (lane !== 'control') conn.inFlight += 1;
    this.laneInFlight[lane] += 1;
    const started = Date.now();
    const reply = this.execute(clampPayloadDeadline(env));
    void reply.then((f) => {
      try {
        this.o.onCompleted?.({ kind: env.kind, requestId: env.requestId, ms: Date.now() - started, ok: f.type === 'reply' && f.ok, ...(f.type === 'reply' && f.ok ? { payload: f.payload } : {}) });
      } catch {
        // 기록 실패는 응답에 영향을 주지 않는다
      }
    });
    this.remember(env.messageId, { fingerprint, reply });
    this.inFlight.add(reply);
    try {
      const frame = await reply;
      this.send(conn, frame); // 연결이 끊겼으면 보내지 않는다. 결과는 Harness 기록·같은 turnId 재전송으로 얻는다
    } finally {
      if (lane !== 'control') conn.inFlight -= 1;
      this.laneInFlight[lane] -= 1;
      this.inFlight.delete(reply);
    }
  }

  private async execute(env: Envelope): Promise<ServerFrame> {
    try {
      const r = await this.o.inbound.dispatch(env);
      return { type: 'reply', causationId: env.messageId, requestId: env.requestId, ok: true, kind: r.kind, payload: r.payload };
    } catch (e) {
      if (e instanceof UnsupportedKindError) return { type: 'reply', causationId: env.messageId, requestId: env.requestId, ok: false, error: { code: 'unsupported_kind', message: e.message } };
      // 내부 오류 내용은 서버 로그에만 남긴다 (비밀값이 섞일 수 있는 원문은 응답에 넣지 않음)
      this.log(`요청 처리 오류 ${env.kind} [${env.requestId}]: ${e instanceof Error ? e.name : 'error'}`);
      return { type: 'reply', causationId: env.messageId, requestId: env.requestId, ok: false, error: { code: 'internal', message: 'request failed inside the harness; check the request state before retrying' } };
    }
  }

  private remember(messageId: string, c: CachedReply) {
    this.replies.set(messageId, c);
    const cap = this.o.replayCacheSize ?? 1_000;
    while (this.replies.size > cap) this.replies.delete(this.replies.keys().next().value!);
  }

  // ------------------------------------------------------------------ subscribe
  /** 다시 구독하면(불완전 동기화 복구) 새 snapshot을 보낸다 */
  private async subscribe(conn: Conn) {
    conn.subscribed = true;
    // snapshot을 읽기 전에 이벤트 수집을 시작한다 → snapshot 이후 누락 없음 (message-contracts §Projection)
    conn.pendingEvents = [];
    const records = await this.o.store.readProjectionSnapshot();
    this.send(conn, { type: 'snapshot', snapshot: snapshotFromHarness(records, this.epoch) });
    const queued = conn.pendingEvents ?? [];
    conn.pendingEvents = null;
    for (const e of queued) this.send(conn, { type: 'event', event: e });
  }

  private broadcast(c: StoreChange) {
    const event = fromStoreChange(c, this.epoch);
    for (const conn of this.conns) {
      if (!conn.subscribed) continue;
      if (conn.pendingEvents) {
        // 구독 snapshot을 만드는 동안 이벤트가 너무 많이 쌓이면 메모리를 지키기 위해 연결을 닫는다. 클라이언트는 다시 연결해 새 snapshot을 받는다 (감사 F-07)
        if (conn.pendingEvents.length >= (this.o.maxPendingEvents ?? 1_000)) {
          conn.pendingEvents = [];
          conn.subscribed = false;
          this.log(`구독 이벤트 대기열 초과 #${conn.id} — 연결을 닫아 다시 동기화하게 합니다`);
          conn.ws.close(CLOSE.slowConsumer, 'resync required');
          continue;
        }
        conn.pendingEvents.push(event);
      }
      else this.send(conn, { type: 'event', event });
    }
  }

  /**
   * 요청이 끝난 뒤 확정된 결과를 pipeline 연결에 알린다 (D-23: 늦게 끝난 Eureka 반영, 주기 복구 결과).
   * 연결이 없으면 버린다 — 같은 변경은 operation.updated 이벤트와 snapshot으로도 확인할 수 있다.
   */
  notify(notice: unknown, resultText: string): number {
    let sent = 0;
    for (const conn of this.conns) {
      if (conn.role !== 'pipeline') continue;
      this.send(conn, { type: 'notice', notice, resultText });
      sent += 1;
    }
    return sent;
  }

  // -------------------------------------------------------------------- output
  private send(conn: Conn, frame: ServerFrame) {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    if (conn.ws.bufferedAmount > (this.o.maxBufferedBytes ?? 1024 * 1024)) {
      this.log(`느린 연결 #${conn.id} 종료 (송신 버퍼 초과)`);
      conn.ws.close(CLOSE.slowConsumer, 'slow consumer');
      return;
    }
    conn.ws.send(JSON.stringify(frame));
  }

  private protocolError(conn: Conn, code: ErrorCode, message: string) {
    this.send(conn, { type: 'error', code, message });
  }
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

function fingerprintOf(env: Envelope): string {
  return createHash('sha256').update(JSON.stringify({ k: env.kind, r: env.requestId, p: env.payload })).digest('hex');
}

function peekIds(raw: unknown): { messageId: string | null; requestId: string | null } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { messageId: typeof r['messageId'] === 'string' ? r['messageId'] : null, requestId: typeof r['requestId'] === 'string' ? r['requestId'] : null };
}

// ------------------------------------------------------------ 접속 주소 (D-25)
export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isLoopback(ip: string): boolean {
  return ip === '::1' || ip.startsWith('127.');
}

function ipv4ToInt(ip: string): number | undefined {
  const p = ip.split('.');
  if (p.length !== 4) return undefined;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return undefined;
    n = n * 256 + Number(x);
  }
  return n;
}

/** "192.168.0.10", "192.168.0.0/24" → 검사 함수. IPv6는 정확히 같은 주소만 */
export function parseClientRules(rules: string[]): ((ip: string) => boolean)[] {
  return rules.flatMap((raw) => {
    const r = raw.trim();
    if (!r) return [];
    const [addr, bitsS] = r.split('/');
    const base = ipv4ToInt(addr!);
    if (base === undefined) return [(ip: string) => ip === r];
    const bits = bitsS === undefined ? 32 : Number(bitsS);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`invalid client rule: ${r}`);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return [(ip: string) => {
      const n = ipv4ToInt(ip);
      return n !== undefined && ((n & mask) >>> 0) === ((base & mask) >>> 0);
    }];
  });
}
