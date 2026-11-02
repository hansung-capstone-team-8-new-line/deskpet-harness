/* eslint-disable no-console */
/**
 * 데모용 Harness WebSocket 클라이언트 (파이프라인 흉내). demo/ 폴더는 서버와 무관하게 통째로 지울 수 있다.
 * Node 22 내장 WebSocket을 쓴다 (추가 의존성 없음).
 */
export interface Reply {
  type: 'reply';
  causationId: string | null;
  requestId: string | null;
  ok: boolean;
  kind?: string;
  payload?: unknown;
  error?: { code: string; message: string; issues?: string[] };
}

export interface ProjectedEntity {
  entityType: string;
  entityId: string;
  revision: number;
  state: Record<string, unknown>;
}

export class HarnessClient {
  private ws!: WebSocket;
  private seq = 0;
  private readonly waiting = new Map<string, (r: Reply) => void>();
  /** 구독으로 받은 표시용 상태 (revision이 더 높을 때만 갱신) */
  readonly entities = new Map<string, ProjectedEntity>();
  epoch?: number;

  constructor(
    private readonly url: string,
    private readonly runId: string,
  ) {}

  async connect(token: string, role: 'pipeline' | 'viewer' = 'pipeline'): Promise<{ protocol: string; epoch: number }> {
    this.ws = new WebSocket(this.url);
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error(`서버에 연결하지 못했어요: ${this.url} (pnpm harness가 켜져 있는지 확인하세요)`)), { once: true });
    });
    const welcome = new Promise<{ protocol: string; epoch: number }>((resolve, reject) => {
      this.ws.addEventListener('close', (e) => reject(new Error(`연결이 닫혔어요 (${e.code} ${e.reason})`)), { once: true });
      this.ws.addEventListener('message', (ev) => {
        const f = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (f['type'] === 'welcome') {
          this.epoch = f['epoch'] as number;
          resolve({ protocol: String(f['protocol']), epoch: this.epoch });
        } else this.onFrame(f);
      });
    });
    this.ws.send(JSON.stringify({ type: 'hello', token, role, client: 'deskpet-demo' }));
    return welcome;
  }

  subscribe(): void {
    this.ws.send(JSON.stringify({ type: 'subscribe', source: 'harness' }));
  }

  /** Envelope로 감싸 보내고 같은 messageId의 응답을 기다린다 */
  request(kind: string, requestId: string, payload: unknown, deadlineAt?: string): Promise<Reply> {
    const messageId = `demo-msg-${this.runId}-${++this.seq}`;
    const envelope = { schemaVersion: '1.0', messageId, kind, requestId, createdAt: new Date().toISOString(), ...(deadlineAt ? { deadlineAt } : {}), payload };
    return new Promise((resolve) => {
      this.waiting.set(messageId, resolve);
      this.ws.send(JSON.stringify({ type: 'request', envelope }));
    });
  }

  close(): void {
    this.ws.close(1000, 'demo done');
  }

  private onFrame(f: Record<string, unknown>) {
    if (f['type'] === 'reply') {
      const r = f as unknown as Reply;
      const done = r.causationId ? this.waiting.get(r.causationId) : undefined;
      if (done) {
        this.waiting.delete(r.causationId!);
        done(r);
      } else if (!r.ok) console.log(`  ! 서버 오류: ${r.error?.code} ${r.error?.message}`);
    } else if (f['type'] === 'snapshot') {
      const s = f['snapshot'] as { objectsWithRevisions: ProjectedEntity[] };
      for (const o of s.objectsWithRevisions) this.put(o);
    } else if (f['type'] === 'event') {
      const e = f['event'] as { kind: string; entityType?: string; entityId: string; revision: number; currentState?: Record<string, unknown> };
      if (e.kind === 'tombstone') this.entities.delete(e.entityId);
      else this.put({ entityType: e.entityType!, entityId: e.entityId, revision: e.revision, state: e.currentState ?? {} });
    } else if (f['type'] === 'notice') {
      // 요청이 끝난 뒤 확정된 결과 (D-23): 늦게 끝난 Eureka 반영, 주기 복구
      const n = f['notice'] as { source?: string; action?: string; status?: string };
      console.log(`\n  🔔 알림 (${n.source}, ${n.action} → ${n.status}): ${String(f['resultText'])}`);
      this.notices += 1;
    } else if (f['type'] === 'error') console.log(`  ! 서버: ${String(f['code'])} ${String(f['message'])}`);
  }

  /** 받은 notice 수 */
  notices = 0;

  private put(o: ProjectedEntity) {
    const cur = this.entities.get(o.entityId);
    if (!cur || cur.revision < o.revision) this.entities.set(o.entityId, o);
  }
}
