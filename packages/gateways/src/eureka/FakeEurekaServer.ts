import { HttpTransportError, type HttpClient, type HttpRequest, type HttpResponse } from '../http.js';

/**
 * 테스트용 in-process Eureka 서버. PDF §4의 응답 형태를 흉내 낸다.
 * fault 주입: 응답 유실(적용 후/전), 연결 거부, 임의 status.
 */
export interface FakeStage {
  id: string;
  name: string;
  status?: 'todo' | 'doing' | 'done' | 'skip';
  order: number;
  completedAt?: number;
  /** 단계 기록 (GET /_api_/notes/0/list?stageId=) */
  notes?: { id: string; content: string; uid?: string; deletedAt?: number }[];
}
export interface FakeItem {
  id: string;
  name: string;
  description?: string;
  dueAt?: number;
  priority?: string;
  status?: 'hold';
  stages: FakeStage[];
}

export type Fault =
  | { kind: 'refuse' }
  | { kind: 'status'; status: number; body: string }
  | { kind: 'drop_after_apply' }
  | { kind: 'drop_before_apply' }
  /** 실제 시간으로 늦게 응답 (후속 작업 대기 시험용) */
  | { kind: 'delay'; ms: number };

export class FakeEurekaServer implements HttpClient {
  items = new Map<string, FakeItem>();
  readonly calls: { method: string; path: string; body?: unknown }[] = [];
  private faults: { match: (r: HttpRequest) => boolean; fault: Fault; remaining: number }[] = [];
  apiKeyValid = true;

  constructor(private readonly now: () => number) {}

  addItem(item: FakeItem) {
    this.items.set(item.id, structuredClone(item));
  }

  injectFault(match: (r: HttpRequest) => boolean, fault: Fault, times = 1) {
    this.faults.push({ match, fault, remaining: times });
  }

  writeCount(pathPrefix: string): number {
    return this.calls.filter((c) => c.method !== 'GET' && c.path.startsWith(pathPrefix)).length;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const f = this.takeFault(req);
    if (f?.kind === 'refuse') throw new HttpTransportError({ kind: 'not_sent', proof: 'transport:ECONNREFUSED' });
    this.calls.push({ method: req.method, path: req.path, ...(req.body !== undefined ? { body: req.body } : {}) });
    if (f?.kind === 'drop_before_apply') throw new HttpTransportError({ kind: 'no_response', detail: 'TimeoutError' });
    if (f?.kind === 'status') return { status: f.status, bodyText: f.body };
    if (f?.kind === 'delay') await new Promise((r) => setTimeout(r, f.ms));
    if (!this.apiKeyValid) return { status: 403, bodyText: JSON.stringify({ message: 'Forbidden' }) };
    const res = this.route(req);
    if (f?.kind === 'drop_after_apply') throw new HttpTransportError({ kind: 'no_response', detail: 'TimeoutError' });
    return res;
  }

  private takeFault(req: HttpRequest): Fault | undefined {
    const i = this.faults.findIndex((f) => f.remaining > 0 && f.match(req));
    if (i < 0) return undefined;
    const f = this.faults[i]!;
    f.remaining -= 1;
    return f.fault;
  }

  private route(req: HttpRequest): HttpResponse {
    const ok = (b: unknown) => ({ status: 200, bodyText: JSON.stringify(b) });
    let m: RegExpMatchArray | null;
    if (req.method === 'GET' && req.path === '/_api_/items/0/list') {
      const list = [...this.items.values()].map((i) => ({
        id: i.id,
        name: i.name,
        ...(i.description ? { description: i.description } : {}),
        dueAt: i.dueAt,
        priority: i.priority,
        ...(i.status ? { status: i.status } : {}),
        'stage$$': i.stages.map((s) => ({ id: s.id, name: s.name, status: s.status, order: s.order, noteIds: (s.notes ?? []).map((n) => n.id), 'note$$': (s.notes ?? []).map((n) => ({ id: n.id, stereo: 'comment' })) })),
      }));
      return ok({ total: list.length, list });
    }
    if (req.method === 'GET' && (m = req.path.match(/^\/_api_\/items\/([^/]+)\/status$/))) {
      const it = this.items.get(decodeURIComponent(m[1]!));
      if (!it) return { status: 404, bodyText: `.id[${m[1]}] not found` };
      const done = it.stages.filter((s) => s.status === 'done' || s.status === 'skip').length;
      const status = it.status === 'hold' ? 'hold' : it.stages.length === 0 ? 'todo' : done === it.stages.length ? 'done' : it.stages.some((s) => s.status === 'doing' || s.status === 'done') ? 'doing' : 'todo';
      return ok({ id: it.id, status, total: it.stages.length, done });
    }
    if (req.method === 'POST' && (m = req.path.match(/^\/_api_\/stages\/([^/]+)\/status$/))) {
      const id = decodeURIComponent(m[1]!);
      for (const it of this.items.values()) {
        const s = it.stages.find((x) => x.id === id);
        if (!s) continue;
        if (it.status === 'hold') return { status: 409, bodyText: 'item is on hold' };
        const body = req.body as { status?: string };
        if (body?.status !== 'done') return { status: 500, bodyText: `.status[${body?.status}] is invalid` };
        s.status = 'done';
        s.completedAt = this.now();
        return ok({ stage: { id: s.id, status: s.status, completedAt: s.completedAt }, warnings: [] });
      }
      return { status: 404, bodyText: `.id[${id}] not found` };
    }
    if (req.method === 'PUT' && (m = req.path.match(/^\/_api_\/items\/([^/]+)$/))) {
      const it = this.items.get(decodeURIComponent(m[1]!));
      if (!it) return { status: 404, bodyText: `.id[${m[1]}] not found` };
      const body = req.body as { dueAt?: unknown };
      if (typeof body?.dueAt === 'number') it.dueAt = body.dueAt;
      return ok({ id: it.id, name: it.name, dueAt: it.dueAt });
    }
    if (req.method === 'POST' && req.path === '/_api_/items/0/start') {
      const body = req.body as { processId?: unknown; name?: unknown; dueAt?: unknown };
      if (typeof body?.processId !== 'string') return { status: 500, bodyText: '.processId is required' };
      const id = String(1000100 + this.items.size);
      this.items.set(id, { id, name: String(body.name ?? ''), ...(typeof body.dueAt === 'number' ? { dueAt: body.dueAt } : {}), stages: [{ id: `${id}1`, name: '시작', status: 'todo', order: 1 }] });
      return ok({ id, stageIds: [`${id}1`] });
    }
    if (req.method === 'POST' && (m = req.path.match(/^\/_api_\/items\/([^/]+)\/complete$/))) {
      const it = this.items.get(decodeURIComponent(m[1]!));
      if (!it) return { status: 404, bodyText: `.id[${m[1]}] not found` };
      if (it.status === 'hold') return { status: 409, bodyText: 'item is on hold' };
      for (const st of it.stages) if (st.status !== 'skip') st.status = 'done';
      return ok({ id: it.id, status: 'done' });
    }
    if (req.method === 'GET' && req.path === '/_api_/notes/0/list') {
      const stageId = req.query?.['stageId'];
      const stage = [...this.items.values()].flatMap((i) => i.stages).find((s) => s.id === stageId);
      const limit = Number(req.query?.['limit'] ?? 10);
      const all = (stage?.notes ?? []).map((n) => ({ id: n.id, $: { sid: '1', uid: n.uid ?? '1' }, stereo: 'comment', content: n.content, stageId, deletedAt: n.deletedAt ?? 0, isResolved: false }));
      return ok({ total: all.length, limit, page: 0, list: all.slice(0, limit) });
    }
    if (req.method === 'GET' && req.path === '/_api_/processes/0/list') {
      return ok({ total: 1, list: [{ id: 'general-work-v1@10204', name: '일반 업무', stageIds: [] }] });
    }
    return { status: 404, bodyText: 'not routed in fake' };
  }
}
