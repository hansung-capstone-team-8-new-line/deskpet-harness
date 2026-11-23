export class HarnessClient {
    url;
    runId;
    ws;
    seq = 0;
    waiting = new Map();
    /** 구독으로 받은 표시용 상태 (revision이 더 높을 때만 갱신) */
    entities = new Map();
    epoch;
    constructor(url, runId) {
        this.url = url;
        this.runId = runId;
    }
    async connect(token, role = 'pipeline') {
        this.ws = new WebSocket(this.url);
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', () => resolve(), { once: true });
            this.ws.addEventListener('error', () => reject(new Error(`서버에 연결하지 못했어요: ${this.url} (pnpm harness가 켜져 있는지 확인하세요)`)), { once: true });
        });
        const welcome = new Promise((resolve, reject) => {
            this.ws.addEventListener('close', (e) => reject(new Error(`연결이 닫혔어요 (${e.code} ${e.reason})`)), { once: true });
            this.ws.addEventListener('message', (ev) => {
                const f = JSON.parse(String(ev.data));
                if (f['type'] === 'welcome') {
                    this.epoch = f['epoch'];
                    resolve({ protocol: String(f['protocol']), epoch: this.epoch });
                }
                else
                    this.onFrame(f);
            });
        });
        this.ws.send(JSON.stringify({ type: 'hello', token, role, client: 'deskpet-demo' }));
        return welcome;
    }
    subscribe() {
        this.ws.send(JSON.stringify({ type: 'subscribe', source: 'harness' }));
    }
    /** Envelope로 감싸 보내고 같은 messageId의 응답을 기다린다 */
    request(kind, requestId, payload, deadlineAt) {
        const messageId = `demo-msg-${this.runId}-${++this.seq}`;
        const envelope = { schemaVersion: '1.0', messageId, kind, requestId, createdAt: new Date().toISOString(), ...(deadlineAt ? { deadlineAt } : {}), payload };
        return new Promise((resolve) => {
            this.waiting.set(messageId, resolve);
            this.ws.send(JSON.stringify({ type: 'request', envelope }));
        });
    }
    close() {
        this.ws.close(1000, 'demo done');
    }
    onFrame(f) {
        if (f['type'] === 'reply') {
            const r = f;
            const done = r.causationId ? this.waiting.get(r.causationId) : undefined;
            if (done) {
                this.waiting.delete(r.causationId);
                done(r);
            }
            else if (!r.ok)
                console.log(`  ! 서버 오류: ${r.error?.code} ${r.error?.message}`);
        }
        else if (f['type'] === 'snapshot') {
            const s = f['snapshot'];
            for (const o of s.objectsWithRevisions)
                this.put(o);
        }
        else if (f['type'] === 'event') {
            const e = f['event'];
            if (e.kind === 'tombstone')
                this.entities.delete(e.entityId);
            else
                this.put({ entityType: e.entityType, entityId: e.entityId, revision: e.revision, state: e.currentState ?? {} });
        }
        else if (f['type'] === 'notice') {
            // 요청이 끝난 뒤 확정된 결과 (D-23): 늦게 끝난 Eureka 반영, 주기 복구
            const n = f['notice'];
            console.log(`\n  🔔 알림 (${n.source}, ${n.action} → ${n.status}): ${String(f['resultText'])}`);
            this.notices += 1;
        }
        else if (f['type'] === 'error')
            console.log(`  ! 서버: ${String(f['code'])} ${String(f['message'])}`);
    }
    /** 받은 notice 수 */
    notices = 0;
    put(o) {
        const cur = this.entities.get(o.entityId);
        if (!cur || cur.revision < o.revision)
            this.entities.set(o.entityId, o);
    }
}
