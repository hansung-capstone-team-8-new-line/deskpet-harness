import { spawn } from 'node:child_process';
const PROTOCOL_VERSION = '2025-03-26';
/**
 * Stdio 기반 MCP 전송 구현 (자식 프로세스의 stdin/stdout newline-delimited JSON-RPC 2.0).
 */
export class StdioMcpTransport {
    cfg;
    proc;
    initialized = false;
    initPromise;
    seq = 0;
    buffer = '';
    pending = new Map();
    constructor(cfg) {
        this.cfg = cfg;
        if (!cfg.command)
            throw new Error(`MCP stdio server '${cfg.mcpId}' requires command`);
    }
    get mcpId() {
        return this.cfg.mcpId;
    }
    async ensureInitialized(deadlineAt, signal) {
        if (this.initialized)
            return;
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = this.doInitialize(deadlineAt, signal).finally(() => {
            this.initPromise = undefined;
        });
        return this.initPromise;
    }
    async doInitialize(deadlineAt, signal) {
        this.spawnProcess();
        await this.sendRpc('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'deskpet-harness', version: '0.2.0' },
        }, deadlineAt, signal);
        this.notify('notifications/initialized', {});
        this.initialized = true;
    }
    spawnProcess() {
        if (this.proc && !this.proc.killed)
            return;
        const child = spawn(this.cfg.command, this.cfg.args ?? [], {
            ...(this.cfg.cwd ? { cwd: this.cfg.cwd } : {}),
            env: { ...process.env, ...(this.cfg.env ?? {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => this.onStdout(chunk));
        child.on('error', (err) => this.rejectAll(err));
        child.on('exit', (code, sig) => {
            this.initialized = false;
            this.proc = undefined;
            this.rejectAll(new Error(`MCP process '${this.cfg.mcpId}' exited (code=${code}, signal=${sig})`));
        });
        this.proc = child;
    }
    onStdout(chunk) {
        this.buffer += chunk;
        let idx = this.buffer.indexOf('\n');
        while (idx >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (line)
                this.handleLine(line);
            idx = this.buffer.indexOf('\n');
        }
    }
    handleLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            return;
        }
        if (typeof msg.id !== 'number')
            return;
        const entry = this.pending.get(msg.id);
        if (!entry)
            return;
        this.pending.delete(msg.id);
        if (msg.error)
            entry.reject(new Error(msg.error.message ?? `MCP error ${msg.error.code ?? ''}`));
        else
            entry.resolve(msg.result);
    }
    notify(method, params) {
        if (!this.proc?.stdin.writable)
            return;
        this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    }
    async request(method, params, deadlineAt, signal) {
        await this.ensureInitialized(deadlineAt, signal);
        return (await this.sendRpc(method, params, deadlineAt, signal));
    }
    sendRpc(method, params, deadlineAt, signal) {
        this.spawnProcess();
        if (!this.proc?.stdin.writable) {
            return Promise.reject(new Error(`MCP server '${this.cfg.mcpId}' stdin is not writable`));
        }
        const id = ++this.seq;
        const timeoutMs = remainingMs(deadlineAt, this.cfg.timeoutMs ?? 30_000);
        if (timeoutMs <= 0 || signal?.aborted) {
            return Promise.reject(new Error('deadline exceeded or aborted'));
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.delete(id))
                    reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            const onAbort = () => {
                clearTimeout(timer);
                if (this.pending.delete(id))
                    reject(new Error(`MCP request '${method}' aborted`));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                    resolve(value);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                    reject(err);
                },
            });
            this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
        });
    }
    rejectAll(err) {
        for (const [id, entry] of this.pending) {
            this.pending.delete(id);
            entry.reject(err);
        }
    }
    async close() {
        this.initialized = false;
        this.rejectAll(new Error(`MCP server '${this.cfg.mcpId}' closed`));
        if (this.proc && !this.proc.killed) {
            this.proc.kill('SIGTERM');
        }
        this.proc = undefined;
    }
}
/**
 * Streamable HTTP 기반 MCP 전송 구현.
 */
export class StreamableHttpMcpTransport {
    cfg;
    fetchImpl;
    initialized = false;
    sessionId;
    seq = 0;
    constructor(cfg, fetchImpl = fetch) {
        this.cfg = cfg;
        this.fetchImpl = fetchImpl;
        if (!cfg.url)
            throw new Error(`MCP http server '${cfg.mcpId}' requires url`);
    }
    get mcpId() {
        return this.cfg.mcpId;
    }
    async ensureInitialized(deadlineAt, signal) {
        if (this.initialized)
            return;
        await this.sendRpc('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'deskpet-harness', version: '0.2.0' },
        }, deadlineAt, signal);
        this.initialized = true;
    }
    async request(method, params, deadlineAt, signal) {
        await this.ensureInitialized(deadlineAt, signal);
        return (await this.sendRpc(method, params, deadlineAt, signal));
    }
    async sendRpc(method, params, deadlineAt, signal) {
        const id = ++this.seq;
        const timeoutMs = remainingMs(deadlineAt, this.cfg.timeoutMs ?? 30_000);
        if (timeoutMs <= 0 || signal?.aborted) {
            throw new Error('deadline exceeded or aborted');
        }
        const mergedSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs);
        const headers = {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(this.cfg.headers ?? {}),
            ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        };
        const res = await this.fetchImpl(this.cfg.url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
            signal: mergedSignal,
        });
        const sid = res.headers.get('mcp-session-id');
        if (sid)
            this.sessionId = sid;
        if (!res.ok) {
            throw new Error(`MCP HTTP ${res.status} on ${method}`);
        }
        const contentType = res.headers.get('content-type') ?? '';
        const text = await res.text();
        const parsed = contentType.includes('text/event-stream')
            ? parseSseJsonRpc(text, id)
            : JSON.parse(text);
        if (parsed.error) {
            throw new Error(parsed.error.message ?? `MCP error ${parsed.error.code ?? ''}`);
        }
        return parsed.result;
    }
    async close() {
        this.initialized = false;
        this.sessionId = undefined;
    }
}
/**
 * 다중 MCP 서버를 관리하고 동적 tools/list 조회 및 tools/call 자유 실행을 제공하는 매니저.
 * 폐쇄형 도구 화이트리스트나 임의 제한을 강제하지 않는다.
 */
export class McpClientManager {
    transports = new Map();
    toolCache = new Map();
    now;
    cacheTtlMs;
    constructor(opts = {}) {
        this.now = opts.now ?? (() => Date.now());
        this.cacheTtlMs = opts.toolCacheTtlMs ?? 60_000;
        for (const s of opts.servers ?? []) {
            if (s.enabled === false)
                continue;
            this.registerServer(s);
        }
        for (const t of opts.transports ?? []) {
            this.transports.set(t.mcpId, t);
        }
    }
    registerServer(cfg) {
        const transport = cfg.transport === 'stdio' ? new StdioMcpTransport(cfg) : new StreamableHttpMcpTransport(cfg);
        this.transports.set(cfg.mcpId, transport);
        this.toolCache.delete(cfg.mcpId);
    }
    registerTransport(transport) {
        this.transports.set(transport.mcpId, transport);
        this.toolCache.delete(transport.mcpId);
    }
    listServerIds() {
        return [...this.transports.keys()];
    }
    hasServer(mcpId) {
        return this.transports.has(mcpId);
    }
    async listTools(mcpId, c) {
        const ids = mcpId ? [mcpId] : this.listServerIds();
        const all = [];
        for (const id of ids) {
            const transport = this.transports.get(id);
            if (!transport)
                continue;
            const cached = this.toolCache.get(id);
            if (cached && this.now() - cached.fetchedAt < this.cacheTtlMs) {
                all.push(...cached.tools);
                continue;
            }
            const tools = [];
            let cursor;
            for (let page = 0; page < 10; page++) {
                const res = (await transport.request('tools/list', cursor ? { cursor } : undefined, c?.deadlineAt, c?.signal)) ?? { tools: [] };
                for (const t of res.tools ?? []) {
                    tools.push({
                        mcpId: id,
                        name: t.name,
                        qualifiedName: `${id}::${t.name}`,
                        ...(t.description ? { description: t.description } : {}),
                        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
                    });
                }
                if (!res.nextCursor)
                    break;
                cursor = res.nextCursor;
            }
            this.toolCache.set(id, { tools, fetchedAt: this.now() });
            all.push(...tools);
        }
        return all;
    }
    async callTool(req, c) {
        const transport = this.transports.get(req.mcpId);
        const observedAt = new Date(this.now()).toISOString();
        if (!transport) {
            return {
                mcpId: req.mcpId,
                toolName: req.toolName,
                ok: false,
                content: [],
                isError: true,
                error: `MCP server '${req.mcpId}' is not registered`,
                observedAt,
            };
        }
        try {
            const res = (await transport.request('tools/call', { name: req.toolName, arguments: req.arguments ?? {} }, req.deadlineAt ?? c?.deadlineAt, c?.signal)) ?? {};
            const isError = Boolean(res.isError);
            return {
                mcpId: req.mcpId,
                toolName: req.toolName,
                ok: !isError,
                content: Array.isArray(res.content) ? res.content : [],
                ...(res.structuredContent ? { structuredContent: res.structuredContent } : {}),
                isError,
                ...(isError ? { error: extractErrorText(res.content) ?? 'MCP tool returned isError=true' } : {}),
                observedAt: new Date(this.now()).toISOString(),
            };
        }
        catch (e) {
            return {
                mcpId: req.mcpId,
                toolName: req.toolName,
                ok: false,
                content: [],
                isError: true,
                error: e instanceof Error ? e.message : String(e),
                observedAt: new Date(this.now()).toISOString(),
            };
        }
    }
    async closeAll() {
        await Promise.allSettled([...this.transports.values()].map((t) => t.close()));
    }
}
export function parseMcpServersEnv(raw) {
    if (!raw?.trim())
        return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed))
        return [];
    return parsed.filter((x) => Boolean(x && typeof x === 'object' && 'mcpId' in x));
}
function remainingMs(deadlineAt, fallbackMs) {
    if (!deadlineAt)
        return fallbackMs;
    return Math.max(0, Math.min(fallbackMs, Date.parse(deadlineAt) - Date.now()));
}
function extractErrorText(content) {
    if (!Array.isArray(content))
        return undefined;
    const msg = content
        .map((c) => c.text)
        .filter((t) => typeof t === 'string' && t.length > 0)
        .join('\n');
    return msg || undefined;
}
function parseSseJsonRpc(raw, expectedId) {
    let fallback;
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:'))
            continue;
        const payload = trimmed.slice(5).trim();
        if (!payload)
            continue;
        try {
            const obj = JSON.parse(payload);
            if (obj.id === expectedId)
                return obj;
            fallback = obj;
        }
        catch {
            // ignore non-json SSE lines
        }
    }
    if (fallback)
        return fallback;
    throw new Error('empty SSE response from MCP server');
}
