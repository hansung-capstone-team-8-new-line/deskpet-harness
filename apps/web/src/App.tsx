import { SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ConnectForm } from '@/components/connect-form';
import { DetailPanel } from '@/components/detail-panel';
import { TaskTable } from '@/components/task-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { HarnessConnection, type ConnView } from '@/lib/connection';
import { STATUS_LABEL, STATUS_ORDER, filterRows, toRows, type StatusKey } from '@/lib/model';

const DEFAULT_URL = 'ws://127.0.0.1:8787';
const KEY = 'deskpet.viewer';

function loadSaved(): { url: string; token: string } | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as { url: string; token: string }) : null;
  } catch {
    return null;
  }
}

export function App() {
  const [conn, setConn] = useState<HarnessConnection | null>(() => {
    const s = loadSaved();
    return s ? new HarnessConnection(s.url, s.token) : null;
  });
  const [formError, setFormError] = useState<string>();

  useEffect(() => {
    if (!conn) return;
    conn.start();
    return () => conn.stop();
  }, [conn]);

  if (!conn) {
    return (
      <ConnectForm
        initialUrl={loadSaved()?.url ?? DEFAULT_URL}
        error={formError}
        onConnect={(url, token) => {
          try {
            sessionStorage.setItem(KEY, JSON.stringify({ url, token }));
          } catch {
            /* 저장 실패해도 이 탭에서는 연결된다 */
          }
          setFormError(undefined);
          setConn(new HarnessConnection(url, token));
        }}
      />
    );
  }
  return (
    <Dashboard
      conn={conn}
      onDisconnect={(error) => {
        try {
          sessionStorage.removeItem(KEY);
        } catch {
          /* 무시 */
        }
        setFormError(error);
        setConn(null);
      }}
    />
  );
}

function Dashboard({ conn, onDisconnect }: { conn: HarnessConnection; onDisconnect: (error?: string) => void }) {
  const view = useSyncExternalStore(conn.subscribe, conn.getView);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusKey | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string>();

  // view.version이 바뀔 때마다 투영 상태를 다시 읽는다
  const rows = useMemo(() => toRows(conn.projector.objects('harness')), [conn, view.version]);
  const sync = useMemo(() => conn.projector.syncStates().find((s) => s.source === 'harness'), [conn, view.version]);
  const visible = filterRows(rows, query, status);
  const selected = rows.find((r) => r.id === selectedId);

  useEffect(() => {
    if (view.state === 'auth_failed') onDisconnect(view.lastError);
  }, [view.state, view.lastError, onDisconnect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">작업 상태</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">DeskPet Harness의 작업과 확인 질문 (보기 전용)</p>
        </div>
        <div className="flex items-center gap-3">
          <ConnectionText view={view} sync={sync?.synchronizationState} />
          <Button variant="outline" size="sm" onClick={() => onDisconnect()}>
            연결 해제
          </Button>
        </div>
      </header>

      <ConnectionNotice view={view} sync={sync} onRetry={() => conn.reconnectNow()} />

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label="작업 검색" placeholder="작업·대상·요청 검색" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as StatusKey | 'all')}>
          <SelectTrigger className="w-40" aria-label="상태 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">모든 상태</SelectItem>
            {STATUS_ORDER.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(query || status !== 'all') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery('');
              setStatus('all');
            }}
          >
            필터 지우기
          </Button>
        )}
        <span className="ml-auto text-sm text-muted-foreground" aria-live="polite">
          {visible.length}건{visible.length !== rows.length ? ` / 전체 ${rows.length}건` : ''}
        </span>
      </div>

      <div className="mt-3 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <TaskTable
          rows={visible}
          selectedId={selectedId}
          onSelect={setSelectedId}
          emptyText={!view.hasData ? '서버에서 상태를 받는 중이에요.' : rows.length === 0 ? '표시할 작업이 없어요.' : '조건에 맞는 작업이 없어요.'}
        />
        <div className="lg:sticky lg:top-4 lg:self-start">
          {selected ? (
            <DetailPanel row={selected} onClose={() => setSelectedId(undefined)} />
          ) : (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">행을 선택하면 상세 결과를 볼 수 있어요.</p>
          )}
        </div>
      </div>

      <p className="mt-6 text-xs text-muted-foreground">이 화면은 상태를 보여 주기만 합니다. 승인 등 변경은 DeskPet의 확인 절차로만 처리됩니다.</p>
    </div>
  );
}

function ConnectionText({ view, sync }: { view: ConnView; sync?: string }) {
  const text =
    view.state === 'connected'
      ? sync === 'incomplete'
        ? '연결됨 · 동기화 불완전'
        : sync === 'syncing'
          ? '연결됨 · 동기화 중'
          : '연결됨'
      : view.state === 'reconnecting'
        ? '연결 끊김 · 다시 연결 중'
        : view.state === 'connecting'
          ? '연결 중'
          : '연결 안 됨';
  const ok = view.state === 'connected' && sync === 'synced';
  return (
    <span className="flex items-center gap-1.5 text-sm" role="status">
      <span aria-hidden className={ok ? 'size-2 rounded-full bg-foreground/70' : 'size-2 rounded-full border border-foreground/70'} />
      {text}
    </span>
  );
}

function ConnectionNotice({ view, sync, onRetry }: { view: ConnView; sync?: { synchronizationState: string; incompleteReason?: string }; onRetry: () => void }) {
  if (view.state === 'reconnecting' || (view.state === 'connecting' && view.lastError)) {
    return (
      <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 px-4 py-3 text-sm">
        <div>
          <p className="font-medium">서버와 연결이 끊겼어요.</p>
          <p className="text-muted-foreground">
            {view.hasData ? '아래 목록은 마지막으로 받은 상태예요. ' : ''}
            {view.retryInSec !== undefined ? `${view.retryInSec}초 후 다시 연결합니다.` : '다시 연결하는 중이에요.'}
            {view.lastError ? ` (${view.lastError})` : ''}
          </p>
        </div>
        <Button size="sm" onClick={onRetry}>
          지금 다시 연결
        </Button>
      </div>
    );
  }
  if (view.state === 'connected' && sync?.synchronizationState === 'incomplete') {
    return (
      <div role="alert" className="mt-4 rounded-md border border-warning/40 px-4 py-3 text-sm">
        <p className="font-medium">동기화가 완전하지 않아요.</p>
        <p className="text-muted-foreground">
          일부 변경을 놓쳤을 수 있어 다시 받아오는 중이에요{sync.incompleteReason ? ` (${sync.incompleteReason})` : ''}.
        </p>
      </div>
    );
  }
  return null;
}
