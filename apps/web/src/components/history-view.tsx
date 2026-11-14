import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ConnView, HarnessConnection } from '@/lib/connection';
import { formatTime } from '@/lib/model';
import { ACTION_LABEL, HISTORY_STATUS_LABEL, filterHistory, formatDateTime, groupBySession, kindLabel, type HistoryEntry, type HistoryStatus } from '@/lib/server-info';

const STATUS_VARIANT: Record<HistoryStatus, 'neutral' | 'outline' | 'destructive' | 'warning'> = {
  succeeded: 'neutral',
  question: 'outline',
  cancelled: 'neutral',
  failed: 'destructive',
  rejected: 'destructive',
  unknown: 'warning',
};
const STATUS_FILTER: HistoryStatus[] = ['question', 'succeeded', 'failed', 'unknown', 'cancelled', 'rejected'];

/** 세션 기록 (D-47): 서버 실행(세션)별로 발화 → 결과를 최신 순으로 */
export function HistoryView({ conn, view }: { conn: HarnessConnection; view: ConnView }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<HistoryStatus | 'all'>('all');
  const [openId, setOpenId] = useState<string>();
  const h = view.history;

  useEffect(() => {
    if (!h.loaded && !h.loading && view.state === 'connected') conn.loadHistory();
  }, [conn, h.loaded, h.loading, view.state]);

  const visible = filterHistory(h.entries, query, status);
  const sessions = groupBySession(visible);
  const persistent = view.info?.history?.persistent;

  if (view.info && view.info.history === null) {
    return <p className="mt-5 rounded-md border border-dashed p-4 text-sm text-muted-foreground">이 서버는 세션 기록을 남기지 않아요 (DESKPET_HISTORY_PATH=off).</p>;
  }

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label="기록 검색" placeholder="발화·의도·답변 검색" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as HistoryStatus | 'all')}>
          <SelectTrigger className="w-36" aria-label="결과 필터">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">모든 결과</SelectItem>
            {STATUS_FILTER.map((s) => (
              <SelectItem key={s} value={s}>
                {HISTORY_STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={() => conn.loadHistory()} disabled={h.loading || view.state !== 'connected'}>
          새로 고침
        </Button>
        <span className="ml-auto text-sm text-muted-foreground" aria-live="polite">
          {visible.length}건{visible.length !== h.entries.length ? ` / 불러온 ${h.entries.length}건` : ''}
        </span>
      </div>
      {persistent === false && <p className="mt-2 text-xs text-muted-foreground">서버가 메모리에만 기록하고 있어요. 서버를 끄면 이 기록은 사라져요 (DESKPET_STORE_PATH 설정 시 파일에 남음).</p>}

      {!h.loaded ? (
        <p className="mt-4 text-sm text-muted-foreground">기록을 불러오는 중이에요.</p>
      ) : sessions.length === 0 ? (
        <p className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">{h.entries.length === 0 ? '아직 기록이 없어요. DeskPet에 말을 걸면 여기에 쌓여요.' : '조건에 맞는 기록이 없어요.'}</p>
      ) : (
        sessions.map((s) => (
          <section key={s.sessionId} className="mt-5" aria-label={`세션 ${formatDateTime(s.sessionId)}`}>
            <h2 className="flex flex-wrap items-baseline gap-x-2 border-b pb-1.5 text-sm font-semibold">
              {formatDateTime(s.sessionId)} 시작
              <span className="font-normal text-muted-foreground">
                {s.entries.length}건{s.sessionId === h.sessionId ? ' · 현재 실행 중인 세션' : ''}
              </span>
            </h2>
            <ol className="divide-y">
              {s.entries.map((e) => (
                <HistoryItem key={e.id} e={e} open={openId === e.id} onToggle={() => setOpenId(openId === e.id ? undefined : e.id)} />
              ))}
            </ol>
          </section>
        ))
      )}

      {h.hasMore && (
        <div className="mt-4">
          <Button variant="outline" size="sm" disabled={h.loading} onClick={() => conn.loadHistory(h.entries[h.entries.length - 1]?.id)}>
            {h.loading ? '불러오는 중' : '이전 기록 더 보기'}
          </Button>
        </div>
      )}
    </div>
  );
}

function HistoryItem({ e, open, onToggle }: { e: HistoryEntry; open: boolean; onToggle: () => void }) {
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} className="grid w-full grid-cols-[4.5rem_1fr_auto] items-start gap-3 px-1 py-2.5 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <span className="pt-0.5 text-muted-foreground tabular-nums">{formatTime(e.at).split(' ').pop()}</span>
        <span className="min-w-0">
          <span className="block">
            {e.input ? <span className="font-medium">“{e.input}”</span> : <span className="text-muted-foreground">{kindLabel(e.kind)}</span>}
            {e.route && <span className="ml-2 text-xs text-muted-foreground">{e.route}</span>}
          </span>
          {e.resultText && <span className="mt-0.5 block text-muted-foreground">→ {e.resultText}</span>}
        </span>
        <span className="flex items-center gap-1.5">
          <Badge variant={STATUS_VARIANT[e.status]}>{HISTORY_STATUS_LABEL[e.status]}</Badge>
          {open ? <ChevronDownIcon className="size-4 text-muted-foreground" aria-hidden /> : <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />}
        </span>
      </button>
      {open && (
        <dl className="mb-3 ml-[5.25rem] grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 rounded-md border bg-muted/40 p-3 text-xs">
          <dt className="text-muted-foreground">종류</dt>
          <dd>{kindLabel(e.kind)} ({e.kind})</dd>
          {e.actions?.length ? (
            <>
              <dt className="text-muted-foreground">실행한 동작</dt>
              <dd>{e.actions.map((a) => `${ACTION_LABEL[a.action] ?? a.action}: ${a.status}`).join(', ')}</dd>
            </>
          ) : null}
          {e.errorCode && (
            <>
              <dt className="text-muted-foreground">오류 코드</dt>
              <dd className="font-mono">{e.errorCode}</dd>
            </>
          )}
          {e.sttConfidence !== undefined && (
            <>
              <dt className="text-muted-foreground">STT 신뢰도</dt>
              <dd className="tabular-nums">{e.sttConfidence.toFixed(2)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">처리 시간</dt>
          <dd className="tabular-nums">{(e.ms / 1000).toFixed(1)}초</dd>
          <dt className="text-muted-foreground">요청 ID</dt>
          <dd className="font-mono break-all">{e.requestId}</dd>
          {e.conversationId && (
            <>
              <dt className="text-muted-foreground">대화 ID</dt>
              <dd className="font-mono break-all">{e.conversationId}</dd>
            </>
          )}
        </dl>
      )}
    </li>
  );
}
