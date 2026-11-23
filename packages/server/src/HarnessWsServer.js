import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';
import { clampPayloadDeadline, parseEnvelope, SUPPORTED_MAJOR } from '@deskpet/contracts';
import { fromStoreChange, snapshotFromHarness } from '@deskpet/projector';
import { UnsupportedKindError } from './inbound.js';
import { CLOSE, ClientFrame, PROTOCOL } from './protocol.js';
import { historyEntryFrom } from './history.js';
import { createStaticHandler, isSameOriginLiteral, WEB_SECURITY_HEADERS } from './staticWeb.js';
const CONTROL_KINDS = new Set(['pipeline.event', 'harness.cancel', 'harness.reconcile', 'eureka.reconcile']);
export function laneOf(kind) {
    if (CONTROL_KINDS.has(kind))
        return 'control';
    if (kind.startsWith('eureka.'))
        return 'eureka';
    return 'work';
}
const LANE_DEFAULTS = { work: 16, eureka: 16, control: 64 };
export class HarnessWsServer {
    o;
    wss;
    http;
    conns = new Set();
    inFlight = new Set();
    laneInFlight = { work: 0, eureka: 0, control: 0 };
    replies = new Map();
    heldNotices = [];
    tokenDigest;
    viewerDigest;
    adminDigest;
    unsubscribeHistory;
    epoch = Date.now();
    unsubscribe;
    stopping = false;
    nextId = 0;
    log;
    constructor(o) {
        this.o = o;
        // 토큰 길이 검사는 없앴다 (D-60). 비어 있으면 안 된다
        if (!o.token)
            throw new Error('server token is required');
        this.tokenDigest = digest(o.token);
        if (o.openViewer && o.viewerToken !== undefined)
            throw new Error('openViewer and viewerToken cannot be used together');
        if (o.viewerToken !== undefined) {
            if (!o.viewerToken)
                throw new Error('viewer token must not be empty');
            if (o.viewerToken === o.token)
                throw new Error('viewer token must differ from the pipeline token');
            this.viewerDigest = digest(o.viewerToken);
        }
        if (o.adminToken !== undefined) {
            if (!o.adminToken)
                throw new Error('admin token must not be empty');
            this.adminDigest = digest(o.adminToken);
        }
        this.log = o.log ?? (() => { });
    }
    async start() {
        const host = this.o.host ?? '127.0.0.1';
        const allowed = new Set(this.o.allowedOrigins ?? []);
        const clients = parseClientRules(this.o.allowedClients ?? []);
        const verifyClient = (info, done) => {
            const ip = normalizeIp(info.req.socket.remoteAddress ?? '');
            if (!this.o.anyClient && !isLoopback(ip) && !clients.some((r) => r(ip))) {
                this.log(`거부: 허용되지 않은 클라이언트 주소 ${ip || '(알 수 없음)'}`);
                return done(false, 403, 'client address not allowed');
            }
            const origin = info.origin;
            // 이 서버가 내보낸 웹 화면(같은 IP·localhost 주소)은 Origin 목록 없이 받는다 (D-42)
            const sameOrigin = !!this.o.web && !!origin && isSameOriginLiteral(origin, info.req.headers.host, !!this.o.tls);
            if (origin && !this.o.anyOrigin && !allowed.has(origin) && !sameOrigin) {
                this.log(`거부: 허용되지 않은 Origin ${origin}`);
                return done(false, 403, 'origin not allowed');
            }
            done(true);
        };
        const common = { maxPayload: this.o.maxPayloadBytes ?? 256 * 1024, verifyClient };
        const web = this.o.web ? createStaticHandler(this.o.web) : undefined;
        const onHttp = (req, res) => {
            const ip = normalizeIp(req.socket.remoteAddress ?? '');
            if (!this.o.anyClient && !isLoopback(ip) && !clients.some((r) => r(ip))) {
                this.log(`거부(HTTP): 허용되지 않은 클라이언트 주소 ${ip || '(알 수 없음)'}`);
                res.writeHead(403, { ...WEB_SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
                return void res.end('client address not allowed');
            }
            if (!web) {
                res.writeHead(426, { ...WEB_SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', Upgrade: 'websocket' });
                return void res.end(`DeskPet Harness WebSocket server (${PROTOCOL})`);
            }
            web(req, res).catch(() => {
                if (!res.headersSent)
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end();
            });
        };
        this.http = this.o.tls ? createHttpsServer({ cert: this.o.tls.cert, key: this.o.tls.key }, onHttp) : createHttpServer(onHttp);
        this.wss = new WebSocketServer({ ...common, server: this.http });
        await new Promise((resolve, reject) => {
            this.http.once('error', reject);
            this.http.listen(this.o.port ?? 8787, host, () => resolve());
        });
        this.wss.on('connection', (ws) => this.onConnection(ws));
        this.unsubscribe = this.o.store.subscribe((c) => this.broadcast(c));
        this.unsubscribeHistory = this.o.history?.onAppend((entry) => {
            for (const conn of this.conns)
                if (conn.role && conn.wantsHistory)
                    this.send(conn, { type: 'history.appended', entry });
        });
        const addr = this.http.address();
        this.log(`Harness WebSocket 서버 ${this.o.tls ? 'wss' : 'ws'}://${host}:${addr.port} (protocol ${PROTOCOL}, epoch ${this.epoch})`);
        return { host, port: addr.port };
    }
    /** 새 연결을 받지 않고, 진행 중 요청이 끝나길 기다린 뒤(최대 drainMs) 연결을 닫는다 */
    async stop(drainMs = 30_000) {
        this.stopping = true;
        this.unsubscribe?.();
        this.unsubscribeHistory?.();
        const wss = this.wss;
        if (!wss)
            return;
        const drained = Promise.allSettled([...this.inFlight]);
        await Promise.race([drained, new Promise((r) => setTimeout(r, drainMs))]);
        for (const c of this.conns)
            c.ws.close(CLOSE.shuttingDown, 'server shutting down');
        await new Promise((resolve) => wss.close(() => resolve()));
        if (this.http) {
            this.http.closeAllConnections?.();
            await new Promise((resolve) => this.http.close(() => resolve()));
        }
        this.log('Harness WebSocket 서버 종료');
    }
    /** 테스트·진단용 */
    get connectionCount() {
        return this.conns.size;
    }
    /** 처리 중인 요청 수 (업데이트 전 확인용) */
    get inFlightCount() {
        return this.inFlight.size;
    }
    /** 서버 정보가 바뀌었을 때(업데이트 상태 등) 접속한 모든 연결에 다시 보낸다 (D-49) */
    publishInfo() {
        if (!this.o.info)
            return;
        const info = this.o.info();
        for (const conn of this.conns)
            if (conn.role)
                this.send(conn, { type: 'server.info', info });
    }
    /** 현황이 바뀌었을 때 접속한 모든 연결에 보낸다 (D-51) */
    publishOverview() {
        if (!this.o.overview)
            return;
        const overview = this.o.overview.get();
        for (const conn of this.conns)
            if (conn.role)
                this.send(conn, { type: 'overview', overview });
    }
    inFlightIdle() {
        return Promise.allSettled([...this.inFlight]).then(() => undefined);
    }
    // ---------------------------------------------------------------- connection
    onConnection(ws) {
        const conn = { id: ++this.nextId, ws, inFlight: 0, subscribed: false, pendingEvents: null };
        this.conns.add(conn);
        const helloTimer = setTimeout(() => {
            if (!conn.role)
                ws.close(CLOSE.helloTimeout, 'hello timeout');
        }, this.o.helloTimeoutMs ?? 5_000);
        ws.on('message', (data, isBinary) => {
            if (isBinary)
                return this.protocolError(conn, 'invalid_frame', 'binary frames are not supported');
            void this.onMessage(conn, data);
        });
        ws.on('close', () => {
            clearTimeout(helloTimer);
            this.conns.delete(conn);
            // 끊김은 취소가 아니다: 진행 중 요청은 계속 처리된다
            if (conn.role)
                this.log(`연결 종료 #${conn.id} (${conn.role})${conn.inFlight ? `, 처리 중 요청 ${conn.inFlight}건은 계속 진행` : ''}`);
        });
        ws.on('error', () => ws.terminate());
    }
    async onMessage(conn, data) {
        let raw;
        try {
            raw = JSON.parse(data.toString());
        }
        catch {
            return this.protocolError(conn, 'invalid_frame', 'not JSON');
        }
        const f = ClientFrame.safeParse(raw);
        if (!f.success)
            return this.protocolError(conn, 'invalid_frame', f.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        const frame = f.data;
        if (!conn.role) {
            if (frame.type !== 'hello') {
                this.send(conn, { type: 'error', code: 'hello_required', message: 'first frame must be hello' });
                return conn.ws.close(CLOSE.unauthorized, 'hello required');
            }
            // pipeline 토큰은 두 역할 모두, viewer 토큰은 viewer 역할만 허용한다 (역할은 토큰이 정한다)
            const d = digest(frame.token);
            const isPipeline = timingSafeEqual(d, this.tokenDigest);
            const isViewer = (!!this.viewerDigest && timingSafeEqual(d, this.viewerDigest)) || (!!this.o.openViewer && frame.role === 'viewer');
            if (!isPipeline && !(isViewer && frame.role === 'viewer')) {
                this.log(`거부: 토큰 불일치 (#${conn.id})`);
                this.send(conn, { type: 'error', code: 'unauthorized', message: 'invalid token' });
                return conn.ws.close(CLOSE.unauthorized, 'unauthorized');
            }
            conn.role = frame.role;
            this.log(`연결 #${conn.id} 인증됨 (${frame.role}${frame.client ? `, ${frame.client}` : ''})`);
            this.send(conn, { type: 'welcome', protocol: PROTOCOL, schemaVersion: `${SUPPORTED_MAJOR}.0`, role: frame.role, epoch: this.epoch, serverTime: new Date().toISOString() });
            if (this.o.info)
                this.send(conn, { type: 'server.info', info: this.o.info() });
            if (this.o.overview)
                this.send(conn, { type: 'overview', overview: this.o.overview.get() });
            if (frame.role === 'pipeline')
                this.flushHeldNotices(conn);
            return;
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
            case 'history': {
                conn.wantsHistory = true;
                const page = this.o.history?.page({ ...(frame.beforeId ? { beforeId: frame.beforeId } : {}), ...(frame.limit ? { limit: frame.limit } : {}) }) ?? { entries: [], hasMore: false };
                return this.send(conn, { type: 'history', entries: page.entries, hasMore: page.hasMore, sessionId: this.o.history?.sessionId ?? '' });
            }
            case 'admin':
                return this.onAdmin(conn, frame);
            case 'settings.set': {
                const reply = (ok, message) => this.send(conn, { type: 'settings.result', ...(frame.id ? { id: frame.id } : {}), ok, message });
                if (!this.o.settings)
                    return reply(false, 'settings_disabled');
                this.log(`설정 저장 요청 (#${conn.id}, ${conn.role})`);
                try {
                    const r = await this.o.settings(frame.settings);
                    return reply(r.ok, r.message);
                }
                catch {
                    return reply(false, 'internal');
                }
            }
            case 'wifi': {
                const { id, action, ssid, password, identity } = frame;
                const reply = (ok, message, data) => this.send(conn, { type: 'wifi.result', ...(id ? { id } : {}), action, ok, message, ...(data !== undefined ? { data } : {}) });
                if (!this.o.wifi)
                    return reply(false, 'wifi_disabled');
                // 비밀번호·아이디는 로그에 남기지 않는다
                if (action === 'connect')
                    this.log(`Wi-Fi 연결 요청 (#${conn.id}, ${conn.role})`);
                try {
                    const r = await this.o.wifi({ action, ...(ssid !== undefined ? { ssid } : {}), ...(password !== undefined ? { password } : {}), ...(identity !== undefined ? { identity } : {}) });
                    return reply(r.ok, r.message, r.data);
                }
                catch {
                    return reply(false, 'internal');
                }
            }
            case 'overview.refresh':
                // 결과는 publishOverview로 모든 연결에 간다
                if (this.o.overview)
                    void this.o.overview.refresh().catch(() => undefined);
                return;
        }
    }
    // ---------------------------------------------------------------------- admin
    async onAdmin(conn, frame) {
        const reply = (ok, message) => this.send(conn, { type: 'admin.result', ...(frame.id ? { id: frame.id } : {}), action: frame.action, ok, message });
        if (!this.o.admin)
            return reply(false, 'admin_disabled');
        // 관리 토큰이 없으면 확인하지 않는다 (D-60)
        if (this.adminDigest && !timingSafeEqual(digest(frame.token ?? ''), this.adminDigest)) {
            conn.adminFailures = (conn.adminFailures ?? 0) + 1;
            this.log(`거부: 관리 토큰 불일치 (#${conn.id}, ${conn.adminFailures}회)`);
            reply(false, 'admin_unauthorized');
            // 토큰을 계속 바꿔 보는 연결은 닫는다
            if (conn.adminFailures >= 5)
                conn.ws.close(CLOSE.unauthorized, 'too many admin failures');
            return;
        }
        this.log(`관리 동작 ${frame.action} (#${conn.id})`);
        try {
            const r = await this.o.admin(frame.action);
            reply(r.ok, r.message);
        }
        catch (e) {
            this.log(`관리 동작 오류 ${frame.action}: ${e instanceof Error ? e.message : 'error'}`);
            reply(false, 'internal');
        }
    }
    // ------------------------------------------------------------------- requests
    async onRequest(conn, rawEnvelope) {
        const ids = peekIds(rawEnvelope);
        const fail = (code, message, issues) => ({
            type: 'reply',
            causationId: ids.messageId,
            requestId: ids.requestId,
            ok: false,
            error: { code, message, ...(issues ? { issues } : {}) },
        });
        if (conn.role !== 'pipeline')
            return this.send(conn, fail('forbidden', 'viewer connections cannot execute requests'));
        if (this.stopping)
            return this.send(conn, fail('shutting_down', 'server is shutting down'));
        const parsed = parseEnvelope(rawEnvelope);
        if (!parsed.ok)
            return this.send(conn, fail('invalid_message', 'envelope rejected before execution', parsed.issues));
        const env = parsed.value;
        if (!this.o.inbound.kinds.has(env.kind))
            return this.send(conn, fail('unsupported_kind', `kind ${env.kind} is not accepted`));
        // 같은 messageId 재전달 → 같은 응답 (실행은 한 번). 내용이 다르면 거부
        const fingerprint = fingerprintOf(env);
        const cached = this.replies.get(env.messageId);
        if (cached) {
            if (cached.fingerprint !== fingerprint)
                return this.send(conn, fail('invalid_message', 'messageId reused with different content'));
            return this.send(conn, await cached.reply);
        }
        // 이미 기한이 지난 요청은 실행하지 않는다. 위의 재전달 응답은 실행 결과이므로 그대로 돌려준다 (감사 F-05)
        if (env.deadlineAt && Date.parse(env.deadlineAt) <= (this.o.now ?? Date.now)())
            return this.send(conn, fail('deadline_exceeded', 'envelope deadline already passed; not executed'));
        const lane = laneOf(env.kind);
        const laneCap = this.o.maxInFlightByLane?.[lane] ?? LANE_DEFAULTS[lane];
        if (this.laneInFlight[lane] >= laneCap)
            return this.send(conn, fail('too_many_in_flight', `server is at its concurrent limit for ${lane} requests`));
        if (lane !== 'control') {
            if (this.laneInFlight.work + this.laneInFlight.eureka >= (this.o.maxInFlightTotal ?? 32))
                return this.send(conn, fail('too_many_in_flight', 'server is at its concurrent request limit'));
            if (conn.inFlight >= (this.o.maxInFlightPerConnection ?? 8))
                return this.send(conn, fail('too_many_in_flight', 'too many concurrent requests on this connection'));
        }
        if (lane !== 'control')
            conn.inFlight += 1;
        this.laneInFlight[lane] += 1;
        const started = Date.now();
        const reply = this.execute(clampPayloadDeadline(env));
        void reply.then((f) => {
            try {
                const ms = Date.now() - started;
                const h = this.o.history && historyEntryFrom(env, f.type === 'reply' && f.ok ? { ok: true, payload: f.payload } : { ok: false, code: f.type === 'reply' && !f.ok ? f.error.code : 'internal' }, ms);
                if (h)
                    this.o.history.append(h);
            }
            catch {
                // 기록 실패는 응답에 영향을 주지 않는다
            }
            try {
                this.o.onCompleted?.({ kind: env.kind, requestId: env.requestId, ms: Date.now() - started, ok: f.type === 'reply' && f.ok, ...(f.type === 'reply' && f.ok ? { payload: f.payload } : {}) });
            }
            catch {
                // 기록 실패는 응답에 영향을 주지 않는다
            }
        });
        this.remember(env.messageId, { fingerprint, reply });
        this.inFlight.add(reply);
        try {
            const frame = await reply;
            this.send(conn, frame); // 연결이 끊겼으면 보내지 않는다. 결과는 Harness 기록·같은 turnId 재전송으로 얻는다
        }
        finally {
            if (lane !== 'control')
                conn.inFlight -= 1;
            this.laneInFlight[lane] -= 1;
            this.inFlight.delete(reply);
        }
    }
    async execute(env) {
        try {
            const r = await this.o.inbound.dispatch(env);
            return { type: 'reply', causationId: env.messageId, requestId: env.requestId, ok: true, kind: r.kind, payload: r.payload };
        }
        catch (e) {
            if (e instanceof UnsupportedKindError)
                return { type: 'reply', causationId: env.messageId, requestId: env.requestId, ok: false, error: { code: 'unsupported_kind', message: e.message } };
            // 내부 오류 내용은 서버 로그에만 남긴다 (비밀값이 섞일 수 있는 원문은 응답에 넣지 않음)
            this.log(`요청 처리 오류 ${env.kind} [${env.requestId}]: ${e instanceof Error ? e.name : 'error'}`);
            return { type: 'reply', causationId: env.messageId, requestId: env.requestId, ok: false, error: { code: 'internal', message: 'request failed inside the harness; check the request state before retrying' } };
        }
    }
    remember(messageId, c) {
        this.replies.set(messageId, c);
        const cap = this.o.replayCacheSize ?? 1_000;
        while (this.replies.size > cap)
            this.replies.delete(this.replies.keys().next().value);
    }
    // ------------------------------------------------------------------ subscribe
    /** 다시 구독하면(불완전 동기화 복구) 새 snapshot을 보낸다 */
    async subscribe(conn) {
        conn.subscribed = true;
        // snapshot을 읽기 전에 이벤트 수집을 시작한다 → snapshot 이후 누락 없음 (message-contracts §Projection)
        conn.pendingEvents = [];
        const records = await this.o.store.readProjectionSnapshot();
        this.send(conn, { type: 'snapshot', snapshot: snapshotFromHarness(records, this.epoch) });
        const queued = conn.pendingEvents ?? [];
        conn.pendingEvents = null;
        for (const e of queued)
            this.send(conn, { type: 'event', event: e });
    }
    broadcast(c) {
        const event = fromStoreChange(c, this.epoch);
        for (const conn of this.conns) {
            if (!conn.subscribed)
                continue;
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
            else
                this.send(conn, { type: 'event', event });
        }
    }
    /**
     * 요청이 끝난 뒤 확정된 결과를 pipeline 연결에 알린다 (D-23: 늦게 끝난 Eureka 반영, 주기 복구 결과).
     * 연결이 없으면 버린다 — 같은 변경은 operation.updated 이벤트와 snapshot으로도 확인할 수 있다.
     */
    notify(notice, resultText) {
        let sent = 0;
        for (const conn of this.conns) {
            if (conn.role !== 'pipeline')
                continue;
            this.send(conn, { type: 'notice', notice, resultText });
            sent += 1;
        }
        // 받을 파이프라인 연결이 없으면 보관했다가 다음 pipeline 연결에 순서대로 보낸다 (2026-11-08).
        // 개수·기간 상한이 있고, 한 번 보낸 알림은 지운다. 오래된 알림의 적용 여부는 파이프라인이 requestId로 판단한다
        if (sent === 0) {
            this.heldNotices.push({ notice, resultText, at: Date.now() });
            const max = this.o.maxHeldNotices ?? 50;
            if (this.heldNotices.length > max)
                this.heldNotices.splice(0, this.heldNotices.length - max);
        }
        return sent;
    }
    /** 보관 중인 알림 수 (진단·테스트용) */
    heldNoticeCount() {
        this.dropExpiredNotices();
        return this.heldNotices.length;
    }
    dropExpiredNotices() {
        const ttl = this.o.heldNoticeTtlMs ?? 10 * 60_000;
        const now = Date.now();
        while (this.heldNotices.length && now - this.heldNotices[0].at > ttl)
            this.heldNotices.shift();
    }
    flushHeldNotices(conn) {
        this.dropExpiredNotices();
        const items = this.heldNotices.splice(0);
        for (const h of items)
            this.send(conn, { type: 'notice', notice: h.notice, resultText: h.resultText, held: true });
        if (items.length)
            this.log(`보관한 알림 ${items.length}건 전달 #${conn.id}`);
    }
    // -------------------------------------------------------------------- output
    send(conn, frame) {
        if (conn.ws.readyState !== WebSocket.OPEN)
            return;
        if (conn.ws.bufferedAmount > (this.o.maxBufferedBytes ?? 1024 * 1024)) {
            this.log(`느린 연결 #${conn.id} 종료 (송신 버퍼 초과)`);
            conn.ws.close(CLOSE.slowConsumer, 'slow consumer');
            return;
        }
        conn.ws.send(JSON.stringify(frame));
    }
    protocolError(conn, code, message) {
        this.send(conn, { type: 'error', code, message });
    }
}
function digest(s) {
    return createHash('sha256').update(s).digest();
}
function fingerprintOf(env) {
    return createHash('sha256').update(JSON.stringify({ k: env.kind, r: env.requestId, p: env.payload })).digest('hex');
}
function peekIds(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return { messageId: typeof r['messageId'] === 'string' ? r['messageId'] : null, requestId: typeof r['requestId'] === 'string' ? r['requestId'] : null };
}
// ------------------------------------------------------------ 접속 주소 (D-25)
export function normalizeIp(ip) {
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
function isLoopback(ip) {
    return ip === '::1' || ip.startsWith('127.');
}
function ipv4ToInt(ip) {
    const p = ip.split('.');
    if (p.length !== 4)
        return undefined;
    let n = 0;
    for (const x of p) {
        if (!/^\d{1,3}$/.test(x) || Number(x) > 255)
            return undefined;
        n = n * 256 + Number(x);
    }
    return n;
}
/** "192.168.0.10", "192.168.0.0/24" → 검사 함수. IPv6는 정확히 같은 주소만 */
export function parseClientRules(rules) {
    return rules.flatMap((raw) => {
        const r = raw.trim();
        if (!r)
            return [];
        const [addr, bitsS] = r.split('/');
        const base = ipv4ToInt(addr);
        if (base === undefined)
            return [(ip) => ip === r];
        const bits = bitsS === undefined ? 32 : Number(bitsS);
        if (!Number.isInteger(bits) || bits < 0 || bits > 32)
            throw new Error(`invalid client rule: ${r}`);
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        return [(ip) => {
                const n = ipv4ToInt(ip);
                return n !== undefined && ((n & mask) >>> 0) === ((base & mask) >>> 0);
            }];
    });
}
