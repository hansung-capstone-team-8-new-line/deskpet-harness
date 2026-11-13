import { SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ConnectForm } from '@/components/connect-form';
import { DetailPanel } from '@/components/detail-panel';
import { HistoryView } from '@/components/history-view';
import { SettingsView, adminMessage } from '@/components/settings-view';
import { TaskTable } from '@/components/task-table';
import { UpdateBanner } from '@/components/update-banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { HarnessConnection, type ConnView } from '@/lib/connection';
import { STATUS_LABEL, STATUS_ORDER, filterRows, toRows, type StatusKey } from '@/lib/model';
import { clearConnection, loadAdminToken, loadConnection, saveAdminToken, saveConnection, useSettings, type SavedConnection } from '@/lib/settings';
import { cn } from '@/lib/utils';

/**
 * 기본 서버 주소. Harness 서버가 이 화면을 내보낸 경우(D-42) 같은 주소의 WebSocket으로,
 * Vite 개발 서버(pnpm web:dev)에서 열었으면 이 기기의 Harness 기본 주소로.
 */
const DEFAULT_URL = import.meta.env.DEV ? 'ws://127.0.0.1:8787' : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
/** 웹에서 업데이트를 누른 탭 표시 (새로 고침 뒤에도 한 번만 쓰고 지운다) */
const UPDATED_HERE = 'deskpet.updatedHere';

export function App() {
  const [saved, setSaved] = useState<SavedConnection | null>(() => {
    const s = loadConnection();
    if (s) return s;
    // D-45: Harness 서버가 내보낸 화면이면 토큰 없이 바로 연결해 본다. 토큰이 필요한 서버면 연결 화면으로 돌아간다
    return import.meta.env.DEV ? null : { url: DEFAULT_URL, token: '' };
  });
  const conn = useMemo(() => (saved ? new HarnessConnection(saved.url, saved.token) : null), [saved]);
  const [formError, setFormError] = useState<string>();

  useEffect(() => {
    if (!conn) return;
    conn.start();
    return () => conn.stop();
  }, [conn]);

  if (!conn || !saved) {
    return (
      <ConnectForm
        initialUrl={loadConnection()?.url ?? DEFAULT_URL}
        error={formError}
        onConnect={(url, token) => {
          const c = { url, token, remember: false };
          saveConnection(c);
          setFormError(undefined);
          setSaved(c);
        }}
      />
    );
  }
  return (
    <Dashboard
      conn={conn}
      saved={saved}
      onReconnect={(c) => {
        saveConnection(c);
        setSaved(c);
      }}
      onDisconnect={(error) => {
        clearConnection();
        setFormError(error);
        setSaved(null);
      }}
    />
  );
}

type Tab = 'tasks' | 'history' | 'settings';
const TAB_LABEL: Record<Tab, string> = { tasks: '작업', history: '기록', settings: '설정' };

function Dashboard({ conn, saved, onReconnect, onDisconnect }: { conn: HarnessConnection; saved: SavedConnection; onReconnect: (c: SavedConnection) => void; onDisconnect: (error?: string) => void }) {
  const view = useSyncExternalStore(conn.subscribe, conn.getView);
  const [settings, setSettings] = useSettings();
  const [tab, setTab] = useState<Tab>('tasks');
  const [adminToken, setAdminToken] = useState(loadAdminToken);
  const [applyMsg, setApplyMsg] = useState<string>();
  const updatedHere = useRef(false);
  try {
    updatedHere.current ||= sessionStorage.getItem(UPDATED_HERE) === '1';
  } catch {
    /* 무시 */
  }

  useEffect(() => {
    if (view.state === 'auth_failed') onDisconnect(view.lastError);
  }, [view.state, view.lastError, onDisconnect]);

  // 이 탭에서 업데이트했고 서버가 새 버전으로 다시 켜졌으면 화면도 새로 고친다 (설정에서 끌 수 있음)
  const commit = view.info?.version?.commit;
  useEffect(() => {
    if (view.state !== 'connected' || !commit || !view.firstCommit || commit === view.firstCommit) return;
    if (updatedHere.current && settings.autoReload) {
      try {
        sessionStorage.removeItem(UPDATED_HERE);
      } catch {
        /* 무시 */
      }
      location.reload();
    }
  }, [view.state, commit, view.firstCommit, settings.autoReload]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">DeskPet Harness</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">작업·확인 질문과 대화 기록 (보기 전용)</p>
        </div>
        <div className="flex items-center gap-3">
          <ConnectionText view={view} sync={conn.projector.syncStates().find((s) => s.source === 'harness')?.synchronizationState} />
          <Button variant="outline" size="sm" onClick={() => onDisconnect()}>
            연결 해제
          </Button>
        </div>
      </header>

      <nav role="tablist" aria-label="화면" className="mt-4 flex gap-1 border-b">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab === t ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {TAB_LABEL[t]}
            {t === 'settings' && view.info?.update?.state === 'available' ? <span className="ml-1 text-xs text-muted-foreground">(새 버전)</span> : null}
          </button>
        ))}
      </nav>

      <ConnectionNotice view={view} sync={conn.projector.syncStates().find((s) => s.source === 'harness')} onRetry={() => conn.reconnectNow()} />
      <UpdateBanner
        view={view}
        adminToken={adminToken}
        onOpenSettings={() => setTab('settings')}
        onApply={async () => {
          setApplyMsg(undefined);
          try {
            sessionStorage.setItem(UPDATED_HERE, '1');
          } catch {
            /* 무시 */
          }
          updatedHere.current = true;
          const r = await conn.admin(adminToken, 'update.apply');
          if (!r.ok) {
            updatedHere.current = false;
            try {
              sessionStorage.removeItem(UPDATED_HERE);
            } catch {
              /* 무시 */
            }
          }
          // 성공은 위 알림(서버 상태)이 보여 주므로 실패만 따로 적는다
          setApplyMsg(r.ok ? undefined : adminMessage(r.message));
        }}
      />
      {applyMsg && (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {applyMsg}
        </p>
      )}

      {tab === 'tasks' && <TasksView conn={conn} view={view} hideFinished={settings.hideFinished} />}
      {tab === 'history' && <HistoryView conn={conn} view={view} />}
      {tab === 'settings' && (
        <SettingsView
          conn={conn}
          view={view}
          connection={saved}
          settings={settings}
          onSettings={setSettings}
          onReconnect={onReconnect}
          adminToken={adminToken}
          onAdminToken={(t) => {
            saveAdminToken(t);
            setAdminToken(t);
          }}
        />
      )}

      <p className="mt-6 text-xs text-muted-foreground">이 화면은 상태를 보여 주기만 합니다. 승인 등 변경은 DeskPet의 확인 절차로만 처리됩니다.</p>
    </div>
  );
}

const FINISHED: ReadonlySet<StatusKey> = new Set(['succeeded', 'cancelled']);

function TasksView({ conn, view, hideFinished }: { conn: HarnessConnection; view: ConnView; hideFinished: boolean }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusKey | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string>();

  // view.version이 바뀔 때마다 투영 상태를 다시 읽는다
  const rows = useMemo(() => toRows(conn.projector.objects('harness')), [conn, view.version]);
  // 완료·취소 숨기기(설정)는 상태 필터로 그 상태를 직접 고르면 무시한다
  const base = hideFinished && (status === 'all' || !FINISHED.has(status)) ? rows.filter((r) => !FINISHED.has(r.status)) : rows;
  const visible = filterRows(base, query, status);
  const selected = rows.find((r) => r.id === selectedId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
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
          {hideFinished && base.length !== rows.length ? ' (완료·취소 숨김)' : ''}
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
    </>
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
