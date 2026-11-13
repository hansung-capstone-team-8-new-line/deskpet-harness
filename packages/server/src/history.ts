import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HarnessResult } from '@deskpet/contracts';
import { fallbackText, mapHarnessResult } from '@deskpet/output';

/**
 * 세션 기록 (D-47). 실행 요청(발화 → 결과)을 시간순으로 남겨 웹 화면에서 다시 볼 수 있게 한다.
 *
 * - 세션 = Harness 서버 한 번 실행 (sessionId = 시작 시각). 대화 ID도 함께 남긴다
 * - 남기는 것: 발화 문장, 라우터 의도, 결과 상태, 사용자에게 말한 문장(고정 문구), 실행한 동작, 처리 시간
 * - 남기지 않는 것: 토큰·키, facts 원문, 응답 원문 (승인 근거가 아니라 보기용 기록)
 * - path가 있으면 JSONL 파일에 덧붙여 서버를 다시 켜도 남는다. 메모리에는 최근 maxEntries건만
 * - 웹 화면(viewer)에서 읽을 수 있다: 토큰 없는 보기 전용(D-45)이면 허용 IP 안의 누구나 발화 기록을 본다
 */
export type HistoryStatus = 'succeeded' | 'failed' | 'question' | 'unknown' | 'cancelled' | 'rejected';

export interface HistoryEntry {
  id: string;
  /** 처리가 끝난 시각 */
  at: string;
  sessionId: string;
  kind: string;
  requestId: string;
  conversationId?: string;
  /** 사용자 발화 (STT 결과) */
  input?: string;
  inputChannel?: string;
  sttConfidence?: number;
  /** 라우터 의도 (route / intention) */
  route?: string;
  status: HistoryStatus;
  /** 사용자에게 전한 문장 (확인 질문 또는 결과 고정 문구) */
  resultText?: string;
  actions?: { action: string; status: string }[];
  errorCode?: string;
  ms: number;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  hasMore: boolean;
}

/** 기록하는 요청 종류: 사용자 발화로 시작되는 실행 요청만 (리마인더 조회·출력 생성은 빼서 기록이 묻히지 않게) */
export const HISTORY_KINDS: ReadonlySet<string> = new Set(['harness.request', 'harness.resume', 'harness.run', 'eureka.execute']);

const MAX_TEXT = 500;

export class HistoryLog {
  readonly sessionId: string;
  private readonly entries: HistoryEntry[] = [];
  private readonly max: number;
  private seq = 0;
  private readonly listeners = new Set<(e: HistoryEntry) => void>();

  constructor(private readonly o: { path?: string; maxEntries?: number; now?: () => number; log?: (line: string) => void } = {}) {
    this.max = o.maxEntries ?? 1_000;
    this.sessionId = new Date(this.now()).toISOString();
    if (o.path) this.load(o.path);
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  private load(path: string) {
    if (!existsSync(path)) return;
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      for (const line of lines.slice(-this.max)) {
        try {
          const e = JSON.parse(line) as HistoryEntry;
          if (e && typeof e.id === 'string' && typeof e.at === 'string') this.entries.push(e);
        } catch {
          // 깨진 줄(쓰는 도중 꺼짐)은 건너뛴다
        }
      }
      // 파일이 상한의 두 배를 넘으면 최근 것만 남겨 다시 쓴다
      if (lines.length > this.max * 2) writeFileSync(path, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    } catch (e) {
      this.o.log?.(`세션 기록 파일을 읽지 못했어요 (${e instanceof Error ? e.message : String(e)}) — 이번 실행 기록만 보여요`);
    }
  }

  onAppend(l: (e: HistoryEntry) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  append(e: Omit<HistoryEntry, 'id' | 'at' | 'sessionId'>): HistoryEntry {
    const entry: HistoryEntry = { id: `${this.sessionId}#${++this.seq}`, at: new Date(this.now()).toISOString(), sessionId: this.sessionId, ...e };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    if (this.o.path) {
      try {
        mkdirSync(dirname(this.o.path), { recursive: true });
        appendFileSync(this.o.path, JSON.stringify(entry) + '\n');
      } catch (err) {
        this.o.log?.(`세션 기록을 파일에 남기지 못했어요 (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch {
        // 받는 쪽 오류는 기록에 영향을 주지 않는다
      }
    }
    return entry;
  }

  /** 최신 순. beforeId를 주면 그 항목보다 오래된 것부터 */
  page(opts: { beforeId?: string; limit?: number } = {}): HistoryPage {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    let end = this.entries.length;
    if (opts.beforeId) {
      const i = this.entries.findIndex((e) => e.id === opts.beforeId);
      end = i < 0 ? 0 : i;
    }
    const start = Math.max(0, end - limit);
    return { entries: this.entries.slice(start, end).reverse(), hasMore: start > 0 };
  }

  get size(): number {
    return this.entries.length;
  }
}

/** 요청 Envelope와 응답에서 기록 한 줄을 만든다. 기록할 종류가 아니면 undefined */
export function historyEntryFrom(
  env: { kind: string; requestId: string; payload: unknown },
  reply: { ok: true; payload: unknown } | { ok: false; code: string },
  ms: number,
): Omit<HistoryEntry, 'id' | 'at' | 'sessionId'> | undefined {
  if (!HISTORY_KINDS.has(env.kind)) return undefined;
  const p = (env.payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const base: Omit<HistoryEntry, 'id' | 'at' | 'sessionId' | 'status'> = { kind: env.kind, requestId: env.requestId, ms };

  if (env.kind === 'harness.request' || env.kind === 'harness.resume') {
    const t = p['currentTurn'] ?? {};
    Object.assign(base, clean({ conversationId: str(t.conversationId), input: text(t.rawText), inputChannel: str(t.inputChannel), sttConfidence: num(t.sttConfidence), route: str(t.routeDecision?.route) }));
  } else if (env.kind === 'harness.run') {
    const d = p['action']?.decision ?? {};
    const intention = d.headOutputs?.intention?.value;
    Object.assign(base, clean({ conversationId: str(p['conversationId']) ?? str(p['context']?.stamp?.conversationId), input: text(p['transcript']?.text), inputChannel: 'voice', sttConfidence: num(p['transcript']?.sttConfidence), route: str(intention) ?? str(d.route) }));
  } else if (env.kind === 'eureka.execute') {
    const d = p['decision'] ?? {};
    Object.assign(base, clean({ route: str(d.headOutputs?.intention?.value) ?? str(d.route) }));
  }

  if (!reply.ok) return { ...base, status: 'rejected', errorCode: reply.code };
  const r = (reply.payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  if (env.kind === 'harness.request' || env.kind === 'harness.resume') {
    const res = r as HarnessResult;
    const actions = (res.actionResults ?? []).map((a) => ({ action: a.action, status: a.status }));
    let resultText: string | undefined;
    try {
      resultText = fallbackText(mapHarnessResult(res)).text;
    } catch {
      resultText = undefined;
    }
    const status: HistoryStatus =
      res.disposition === 'awaiting_user' ? 'question' : res.disposition === 'cancelled' ? 'cancelled' : res.disposition === 'failed' ? 'failed' : actions.some((a) => a.status === 'unknown') ? 'unknown' : actions.some((a) => a.status === 'failed') ? 'failed' : 'succeeded';
    const err = res.processingErrors?.[0]?.provisionalCode ?? (res.actionResults ?? []).find((a) => a.error)?.error?.provisionalCode;
    return { ...base, status, ...clean({ resultText: text(resultText), errorCode: str(err) }), ...(actions.length ? { actions } : {}) };
  }

  // 파이프라인 형식: { action: {status, error}, question, resultText } 또는 ActionResult 그대로
  const a = (r['action'] ?? r) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const s = String(a['status'] ?? '');
  const status: HistoryStatus = s === 'needs_clarification' ? 'question' : s === 'succeeded' || s === 'failed' || s === 'unknown' || s === 'cancelled' ? s : 'unknown';
  const resultText = str(r['question']) ?? str(r['resultText']) ?? str(a['facts']?.resultText);
  return { ...base, status, ...clean({ resultText: text(resultText), errorCode: str(a['error']?.code) }) };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined;
}
function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_TEXT) : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function clean<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
