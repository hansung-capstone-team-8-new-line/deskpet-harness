import type { OperationUpdated, Snapshot, Tombstone } from '@deskpet/contracts';
import { RequestStateProjector } from '@deskpet/projector';
import type { HistoryEntry, Overview, ServerInfo } from '@/lib/server-info';

/**
 * Harness 서버(viewer 역할) 연결. 보기 전용: 실행 요청을 보내지 않는다.
 * - 연결 → hello(viewer) → welcome → resync + subscribe → snapshot 적용 → 이후 이벤트 적용
 * - 끊기면 마지막 상태를 유지한 채 표시하고 점점 늘어나는 간격으로 다시 연결한다
 * - 불완전 동기화(버퍼 포화·epoch 변경 등)면 다시 구독해 새 snapshot을 받는다
 */
export type ConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'auth_failed';

export interface ConnView {
  state: ConnState;
  /** 다음 재연결까지 남은 초 (reconnecting) */
  retryInSec?: number;
  lastError?: string;
  /** 서버 epoch (서버 재시작 시 바뀜) */
  epoch?: number;
  /** 한 번이라도 snapshot을 받았는지 */
  hasData: boolean;
  version: number;
  /** 서버 정보 (D-49) */
  info?: ServerInfo;
  /** 현황 (D-51). 서버가 꺼 두었으면 없음 */
  overview?: Overview;
  /** 이 화면이 처음 받은 서버 버전. 바뀌면 화면을 새로 고쳐야 한다 */
  firstCommit?: string;
  /** 세션 기록 (D-47). 최신 순 */
  history: { entries: HistoryEntry[]; hasMore: boolean; loaded: boolean; loading: boolean; sessionId?: string };
}

export interface AdminResult {
  ok: boolean;
  message: string;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];

export class HarnessConnection {
  readonly projector = new RequestStateProjector({ bufferLimit: 2_000 });
  private ws?: WebSocket;
  private view: ConnView = { state: 'idle', hasData: false, version: 0, history: { entries: [], hasMore: false, loaded: false, loading: false } };
  private historyWanted = false;
  /** 다음 history 응답이 '더 보기'(이어 붙이기)인지 */
  private pendingBefore = false;
  private adminSeq = 0;
  private readonly adminWaiters = new Map<string, (r: AdminResult) => void>();
  private listeners = new Set<() => void>();
  private attempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private countdown?: ReturnType<typeof setInterval>;
  private stopped = true;

  constructor(
    private url: string,
    private token: string,
  ) {
    this.projector.subscribe(() => {
      this.checkSync();
      this.bump({});
    });
  }

  getView = (): ConnView => this.view;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  start() {
    this.stopped = false;
    this.open();
  }

  /** 사용자가 누른 즉시 다시 연결 */
  reconnectNow() {
    this.clearTimers();
    this.ws?.close();
    this.attempt = 0;
    this.open();
  }

  /** 세션 기록 읽기. beforeId가 없으면 처음부터(최신) 다시 */
  loadHistory(beforeId?: string) {
    this.historyWanted = true;
    if (this.view.state !== 'connected' || !this.ws) return;
    this.pendingBefore = !!beforeId;
    this.bump({ history: { ...this.view.history, loading: true } });
    this.ws.send(JSON.stringify({ type: 'history', limit: 100, ...(beforeId ? { beforeId } : {}) }));
  }

  /** 현황 다시 읽기 (D-51). 결과는 overview 프레임으로 온다 */
  refreshOverview() {
    if (this.view.state === 'connected') this.ws?.send(JSON.stringify({ type: 'overview.refresh' }));
  }

  /** 관리 동작 (D-50). 관리 토큰은 보내기만 하고 저장하지 않는다 */
  admin(token: string, action: 'update.check' | 'update.apply' | 'settings.set', extra?: { settings: { allowedRepositories: string[] } }): Promise<AdminResult> {
    if (this.view.state !== 'connected' || !this.ws) return Promise.resolve({ ok: false, message: 'not_connected' });
    const id = `a${++this.adminSeq}`;
    const ws = this.ws;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.adminWaiters.delete(id);
        resolve({ ok: false, message: 'timeout' });
      }, 15 * 60_000);
      this.adminWaiters.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      ws.send(JSON.stringify({ type: 'admin', token, action, id, ...(extra ?? {}) }));
    });
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, 'viewer closed');
    this.bump({ state: 'idle' });
  }

  private open() {
    this.bump({ state: this.view.hasData ? 'reconnecting' : 'connecting', retryInSec: undefined });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.bump({ lastError: '서버 주소가 올바르지 않아요.' });
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token: this.token, role: 'viewer', client: 'deskpet-web' })));
    ws.addEventListener('message', (ev) => this.onFrame(JSON.parse(String(ev.data)) as Record<string, unknown>));
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return;
      if (ev.code === 4001 && ev.reason.includes('admin')) {
        this.bump({ lastError: '관리 토큰을 여러 번 틀려 서버가 연결을 닫았어요. 설정에서 관리 토큰을 확인하세요.' });
        return this.scheduleRetry();
      }
      if (ev.code === 4001) {
        this.bump({ state: 'auth_failed', lastError: '토큰이 맞지 않아요. 보기 전용 토큰(HARNESS_WS_VIEWER_TOKEN)을 확인하세요.' });
        return;
      }
      if (!this.stopped) {
        this.bump({ lastError: ev.code === 1006 ? '서버에 연결할 수 없어요. pnpm harness가 실행 중인지, 허용 Origin 설정을 확인하세요.' : `연결이 닫혔어요 (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})` });
        this.scheduleRetry();
      }
    });
  }

  private onFrame(f: Record<string, unknown>) {
    switch (f['type']) {
      case 'welcome':
        this.attempt = 0;
        this.bump({ state: 'connected', epoch: f['epoch'] as number, lastError: undefined });
        this.resubscribe();
        // 다시 연결되면 기록도 처음부터 다시 받는다 (끊긴 동안 생긴 기록 포함)
        if (this.historyWanted) this.loadHistory();
        break;
      case 'overview':
        this.bump({ overview: f['overview'] as Overview });
        break;
      case 'server.info': {
        const info = f['info'] as ServerInfo;
        this.bump({ info, firstCommit: this.view.firstCommit ?? info.version?.commit });
        break;
      }
      case 'history': {
        const entries = f['entries'] as HistoryEntry[];
        this.bump({ history: { entries: this.pendingBefore ? [...this.view.history.entries, ...entries] : entries, hasMore: f['hasMore'] as boolean, loaded: true, loading: false, sessionId: f['sessionId'] as string } });
        this.pendingBefore = false;
        break;
      }
      case 'history.appended': {
        const e = f['entry'] as HistoryEntry;
        if (this.view.history.entries.some((x) => x.id === e.id)) break;
        this.bump({ history: { ...this.view.history, entries: [e, ...this.view.history.entries] } });
        break;
      }
      case 'admin.result': {
        const id = String(f['id'] ?? '');
        const w = this.adminWaiters.get(id);
        if (w) {
          this.adminWaiters.delete(id);
          w({ ok: f['ok'] === true, message: String(f['message'] ?? '') });
        }
        break;
      }
      case 'snapshot': {
        const r = this.projector.applySnapshot(f['snapshot'] as Snapshot);
        if (r === 'applied') this.bump({ hasData: true });
        break;
      }
      case 'event':
        this.projector.apply(f['event'] as OperationUpdated | Tombstone);
        break;
      case 'error':
        this.bump({ lastError: String(f['message'] ?? f['code']) });
        break;
    }
  }

  private resubscribe() {
    this.projector.resync('harness');
    this.ws?.send(JSON.stringify({ type: 'subscribe', source: 'harness' }));
  }

  private resyncing = false;
  /** 불완전 동기화면 한 번 다시 구독한다 (상태는 화면에 그대로 보인다) */
  private checkSync() {
    const s = this.projector.syncStates().find((x) => x.source === 'harness');
    if (s?.synchronizationState === 'incomplete' && this.view.state === 'connected' && !this.resyncing) {
      this.resyncing = true;
      setTimeout(() => {
        this.resyncing = false;
        if (this.view.state === 'connected') this.resubscribe();
      }, 1_000);
    }
  }

  private scheduleRetry() {
    if (this.stopped) return;
    const ms = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    let left = Math.ceil(ms / 1000);
    this.bump({ state: this.view.hasData ? 'reconnecting' : 'connecting', retryInSec: left });
    this.countdown = setInterval(() => {
      left = Math.max(0, left - 1);
      this.bump({ retryInSec: left });
    }, 1_000);
    this.retryTimer = setTimeout(() => {
      this.clearTimers();
      this.open();
    }, ms);
  }

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.countdown) clearInterval(this.countdown);
    this.retryTimer = undefined;
    this.countdown = undefined;
  }

  private bump(p: Partial<ConnView>) {
    this.view = { ...this.view, ...p, version: this.view.version + 1 };
    for (const l of this.listeners) l();
  }
}
