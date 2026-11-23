import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fallbackText, mapHarnessResult } from '@deskpet/output';
/** 기록하는 요청 종류: 사용자 발화로 시작되는 실행 요청만 (리마인더 조회·출력 생성은 빼서 기록이 묻히지 않게) */
export const HISTORY_KINDS = new Set(['harness.request', 'harness.resume', 'harness.run', 'eureka.execute']);
const MAX_TEXT = 500;
export class HistoryLog {
    o;
    sessionId;
    entries = [];
    max;
    seq = 0;
    listeners = new Set();
    constructor(o = {}) {
        this.o = o;
        this.max = o.maxEntries ?? 1_000;
        this.sessionId = new Date(this.now()).toISOString();
        if (o.path)
            this.load(o.path);
    }
    now() {
        return (this.o.now ?? Date.now)();
    }
    load(path) {
        if (!existsSync(path))
            return;
        try {
            const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
            for (const line of lines.slice(-this.max)) {
                try {
                    const e = JSON.parse(line);
                    if (e && typeof e.id === 'string' && typeof e.at === 'string')
                        this.entries.push(e);
                }
                catch {
                    // 깨진 줄(쓰는 도중 꺼짐)은 건너뛴다
                }
            }
            // 파일이 상한의 두 배를 넘으면 최근 것만 남겨 다시 쓴다
            if (lines.length > this.max * 2)
                writeFileSync(path, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
        }
        catch (e) {
            this.o.log?.(`세션 기록 파일을 읽지 못했어요 (${e instanceof Error ? e.message : String(e)}) — 이번 실행 기록만 보여요`);
        }
    }
    onAppend(l) {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    }
    append(e) {
        const entry = { id: `${this.sessionId}#${++this.seq}`, at: new Date(this.now()).toISOString(), sessionId: this.sessionId, ...e };
        this.entries.push(entry);
        if (this.entries.length > this.max)
            this.entries.splice(0, this.entries.length - this.max);
        if (this.o.path) {
            try {
                mkdirSync(dirname(this.o.path), { recursive: true });
                appendFileSync(this.o.path, JSON.stringify(entry) + '\n');
            }
            catch (err) {
                this.o.log?.(`세션 기록을 파일에 남기지 못했어요 (${err instanceof Error ? err.message : String(err)})`);
            }
        }
        for (const l of this.listeners) {
            try {
                l(entry);
            }
            catch {
                // 받는 쪽 오류는 기록에 영향을 주지 않는다
            }
        }
        return entry;
    }
    /** 최신 순. beforeId를 주면 그 항목보다 오래된 것부터 */
    page(opts = {}) {
        const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
        let end = this.entries.length;
        if (opts.beforeId) {
            const i = this.entries.findIndex((e) => e.id === opts.beforeId);
            end = i < 0 ? 0 : i;
        }
        const start = Math.max(0, end - limit);
        return { entries: this.entries.slice(start, end).reverse(), hasMore: start > 0 };
    }
    get size() {
        return this.entries.length;
    }
}
/** 요청 Envelope와 응답에서 기록 한 줄을 만든다. 기록할 종류가 아니면 undefined */
export function historyEntryFrom(env, reply, ms) {
    if (!HISTORY_KINDS.has(env.kind))
        return undefined;
    const p = (env.payload ?? {}); // eslint-disable-line @typescript-eslint/no-explicit-any
    const base = { kind: env.kind, requestId: env.requestId, ms };
    if (env.kind === 'harness.request' || env.kind === 'harness.resume') {
        const t = p['currentTurn'] ?? {};
        Object.assign(base, clean({ conversationId: str(t.conversationId), input: text(t.rawText), inputChannel: str(t.inputChannel), sttConfidence: num(t.sttConfidence), route: str(t.routeDecision?.route) }));
    }
    else if (env.kind === 'harness.run') {
        const d = p['action']?.decision ?? {};
        const intention = d.headOutputs?.intention?.value;
        Object.assign(base, clean({ conversationId: str(p['conversationId']) ?? str(p['context']?.stamp?.conversationId), input: text(p['transcript']?.text), inputChannel: 'voice', sttConfidence: num(p['transcript']?.sttConfidence), route: str(intention) ?? str(d.route) }));
    }
    else if (env.kind === 'eureka.execute') {
        // 라우터 결정의 operation을 의도로 보여 준다 (eureka list 등). 발화 문장은 transcript가 있으면 (Harness 확장, 선택)
        const d = p['decision'] ?? {};
        const op = str(d.headOutputs?.operation?.value);
        Object.assign(base, clean({ input: text(p['transcript']?.text), inputChannel: p['transcript'] ? 'voice' : undefined, sttConfidence: num(p['transcript']?.sttConfidence), route: op ? `eureka.${op}` : (str(d.headOutputs?.intention?.value) ?? str(d.route)) }));
    }
    if (!reply.ok)
        return { ...base, status: 'rejected', errorCode: reply.code };
    const r = (reply.payload ?? {}); // eslint-disable-line @typescript-eslint/no-explicit-any
    if (env.kind === 'harness.request' || env.kind === 'harness.resume') {
        const res = r;
        const actions = (res.actionResults ?? []).map((a) => ({ action: a.action, status: a.status }));
        let resultText;
        try {
            resultText = fallbackText(mapHarnessResult(res)).text;
        }
        catch {
            resultText = undefined;
        }
        const status = res.disposition === 'awaiting_user' ? 'question' : res.disposition === 'cancelled' ? 'cancelled' : res.disposition === 'failed' ? 'failed' : actions.some((a) => a.status === 'unknown') ? 'unknown' : actions.some((a) => a.status === 'failed') ? 'failed' : 'succeeded';
        const err = res.processingErrors?.[0]?.provisionalCode ?? (res.actionResults ?? []).find((a) => a.error)?.error?.provisionalCode;
        return { ...base, status, ...clean({ resultText: text(resultText), errorCode: str(err) }), ...(actions.length ? { actions } : {}) };
    }
    // 파이프라인 형식: { action: {status, error}, question, resultText } 또는 ActionResult 그대로
    const a = (r['action'] ?? r); // eslint-disable-line @typescript-eslint/no-explicit-any
    const s = String(a['status'] ?? '');
    const status = s === 'needs_clarification' ? 'question' : s === 'succeeded' || s === 'failed' || s === 'unknown' || s === 'cancelled' ? s : 'unknown';
    const resultText = str(r['question']) ?? str(r['resultText']) ?? str(a['facts']?.question) ?? str(a['facts']?.resultText);
    return { ...base, status, ...clean({ resultText: text(resultText), errorCode: str(a['error']?.code) }) };
}
function str(v) {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined;
}
function text(v) {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_TEXT) : undefined;
}
function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function clean(o) {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
