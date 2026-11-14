import { ExternalLinkIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { HarnessConnection } from '@/lib/connection';
import { ITEM_STATE_LABEL, PR_STATE_LABEL, STAGE_LABEL, dDay, formatDateTime, pickFocus, type Overview } from '@/lib/server-info';

/**
 * 웹 현황 (D-51). 위: 현재 진행 중 업무 카드 / 아래: 리마인더·링크.
 * 서버가 시작 때와 주기적으로 Eureka·GitHub를 읽어 보낸다. 고른 업무는 이 브라우저에만 기억한다.
 */
const FOCUS_KEY = 'deskpet.focusItem';
function loadFocus(): string | undefined {
  try {
    return localStorage.getItem(FOCUS_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function saveFocus(id: string | undefined) {
  try {
    if (id) localStorage.setItem(FOCUS_KEY, id);
    else localStorage.removeItem(FOCUS_KEY);
  } catch {
    /* 이 탭에서만 */
  }
}

const AUTO = '__auto__';
/** D-day는 서버가 읽은 시각 기준 (리마인더의 '지남' 판정과 맞춘다) */
const nowOf = (o: Overview) => (o.observedAt ? Date.parse(o.observedAt) : Date.now());

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      {children}
      <ExternalLinkIcon className="size-3 text-muted-foreground" aria-hidden />
    </a>
  );
}

export function CurrentWorkCard({ conn, overview }: { conn: HarnessConnection; overview?: Overview }) {
  const [chosen, setChosen] = useState<string | undefined>(loadFocus);
  if (!overview) return null;
  const item = pickFocus(overview, chosen);
  const isAuto = !chosen || !overview.items.some((i) => i.itemId === chosen);

  return (
    <section aria-labelledby="current-work" className="mt-5 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="current-work" className="text-base font-semibold">
          현재 업무
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {overview.items.length > 1 && (
            <Select
              value={isAuto ? AUTO : chosen}
              onValueChange={(v) => {
                const id = v === AUTO ? undefined : v;
                saveFocus(id);
                setChosen(id);
              }}
            >
              <SelectTrigger className="w-60" aria-label="보여 줄 업무">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>자동 선택</SelectItem>
                {overview.items.map((i) => (
                  <SelectItem key={i.itemId} value={i.itemId}>
                    {i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button variant="ghost" size="sm" disabled={overview.refreshing} onClick={() => conn.refreshOverview()} aria-label="현황 다시 읽기">
            <RefreshCwIcon aria-hidden />
            {overview.refreshing ? '읽는 중' : '새로 고침'}
          </Button>
        </div>
      </div>

      {overview.state === 'loading' ? (
        <p className="mt-3 text-sm text-muted-foreground">Eureka에서 업무를 읽는 중이에요.</p>
      ) : !item ? (
        <p className="mt-3 text-sm text-muted-foreground">{overview.state === 'failed' ? 'Eureka 업무를 읽지 못했어요.' : '진행 중인 업무가 없어요.'}</p>
      ) : (
        <div className="mt-3 grid gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-lg font-medium">{item.name}</span>
            <Badge variant={item.state === 'doing' ? 'outline' : 'neutral'}>{ITEM_STATE_LABEL[item.state] ?? item.state}</Badge>
            {item.dueAt && (
              <span className="text-sm text-muted-foreground">
                마감 {formatDateTime(item.dueAt)} · <span className="font-medium text-foreground">{dDay(item.dueAt, nowOf(overview))}</span>
              </span>
            )}
            {item.priority && <span className="text-sm text-muted-foreground">우선순위 {item.priority}</span>}
          </div>
          {item.description && <p className="text-sm whitespace-pre-line text-muted-foreground">{item.description}</p>}

          {item.stages.length > 0 && (
            <div>
              <p className="text-sm">
                단계 {item.doneStages}/{item.stages.length}
                {item.currentStage ? <span className="text-muted-foreground"> · 지금: {item.currentStage}</span> : null}
              </p>
              <ol className="mt-1.5 flex flex-wrap gap-1.5" aria-label="단계">
                {item.stages.map((s, i) => (
                  <li
                    key={s.stageId}
                    className={`rounded-md border px-2 py-0.5 text-xs ${s.status === 'doing' ? 'border-foreground font-medium' : s.status === 'done' || s.status === 'skip' ? 'bg-muted text-muted-foreground' : ''}`}
                  >
                    {i + 1}. {s.name} <span className="text-muted-foreground">· {STAGE_LABEL[s.status] ?? s.status}{s.dueAt && s.status !== 'done' && s.status !== 'skip' ? ` · ${dDay(s.dueAt, nowOf(overview))}` : ''}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div>
            <p className="text-sm font-medium">연결된 PR</p>
            {item.prs.length === 0 ? (
              <p className="text-sm text-muted-foreground">단계 기록에 적힌 PR 주소가 없어요.</p>
            ) : (
              <ul className="mt-1 grid gap-1 text-sm">
                {item.prs.map((p) => (
                  <li key={`${p.owner}/${p.name}#${p.prNumber}`} className="flex flex-wrap items-center gap-2">
                    <A href={p.url}>
                      {p.owner}/{p.name} #{p.prNumber}
                    </A>
                    {p.title && <span className="text-muted-foreground">{p.title}</span>}
                    {p.state && <Badge variant={p.state === 'open' ? 'outline' : 'neutral'}>{p.draft && p.state === 'open' ? '초안' : PR_STATE_LABEL[p.state]}</Badge>}
                    {p.stageName && <span className="text-xs text-muted-foreground">({p.stageName} 단계 기록)</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      <Footnote overview={overview} />
    </section>
  );
}

function Footnote({ overview }: { overview: Overview }) {
  if (!overview.observedAt && !overview.problems.length) return null;
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      {overview.observedAt ? `${formatDateTime(overview.observedAt)}에 읽음` : ''}
      {overview.problems.length ? ` · ${overview.problems.join(' · ')}` : ''}
    </p>
  );
}

/** 아래: 마감 임박 리마인더 + Eureka·GitHub 링크와 열린 PR */
export function RemindersAndLinks({ overview }: { overview?: Overview }) {
  if (!overview || overview.state === 'loading') return null;
  const { reminders, links } = overview;
  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      <section aria-labelledby="reminders" className="rounded-md border p-4">
        <h2 id="reminders" className="text-base font-semibold">
          리마인더
        </h2>
        {reminders.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">가까운 마감이 없어요.</p>
        ) : (
          <ul className="mt-2 divide-y text-sm">
            {reminders.map((r) => (
              <li key={`${r.itemId}/${r.stageName ?? ''}`} className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate">
                  {r.stageName ? (
                    <>
                      {r.stageName} <span className="text-muted-foreground">· {r.name}</span>
                    </>
                  ) : (
                    r.name
                  )}
                </span>
                <span className="shrink-0 tabular-nums">
                  <span className={r.overdue ? 'font-medium text-destructive' : r.daysLeft <= 1 ? 'font-medium' : ''}>{dDay(r.dueAt, nowOf(overview))}</span>
                  <span className="ml-2 text-muted-foreground">{formatDateTime(r.dueAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="links" className="rounded-md border p-4">
        <h2 id="links" className="text-base font-semibold">
          링크
        </h2>
        <ul className="mt-2 grid gap-3 text-sm">
          {links.eurekaWebUrl ? (
            <li>
              <A href={links.eurekaWebUrl}>Eureka 홈</A>
            </li>
          ) : (
            <li className="text-muted-foreground">Eureka 링크 없음</li>
          )}
          {links.repos.map((r) => (
            <li key={`${r.owner}/${r.name}`}>
              <A href={r.url}>
                {r.owner}/{r.name}
              </A>
              {r.error ? (
                <p className="text-xs text-muted-foreground">{r.error}</p>
              ) : r.openPrs ? (
                r.openPrs.length === 0 ? (
                  <p className="text-xs text-muted-foreground">열린 PR 없음</p>
                ) : (
                  <ul className="mt-1 ml-1 grid gap-1 border-l pl-3">
                    {r.openPrs.slice(0, 8).map((p) => (
                      <li key={p.number} className="flex flex-wrap items-center gap-x-2 text-xs">
                        <A href={p.url}>#{p.number}</A>
                        <span className="min-w-0 truncate">{p.title}</span>
                        <span className="text-muted-foreground">
                          {p.author}
                          {p.draft ? ' · 초안' : ''}
                          {p.reviewRequested ? ' · 리뷰 요청됨' : ''}
                        </span>
                      </li>
                    ))}
                    {(r.openPrs.length > 8 || r.hasMore) && (
                      <li className="text-xs">
                        <A href={`${r.url}/pulls`}>열린 PR 모두 보기</A>
                      </li>
                    )}
                  </ul>
                )
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
