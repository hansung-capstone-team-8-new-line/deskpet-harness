import type { OperationUpdated, Snapshot, Tombstone } from '@deskpet/contracts';
import { RequestStateProjector } from '@deskpet/projector';

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
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];

export class HarnessConnection {
  readonly projector = new RequestStateProjector({ bufferLimit: 2_000 });
  private ws?: WebSocket;
  private view: ConnView = { state: 'idle', hasData: false, version: 0 };
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
        break;
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
