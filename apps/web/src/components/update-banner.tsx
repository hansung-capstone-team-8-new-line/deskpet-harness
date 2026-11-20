import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ConnView } from '@/lib/connection';
import { pendingUpdates } from '@/lib/server-info';

/**
 * 업데이트 알림 (D-49) + 업데이트 버튼 (D-50).
 * - 새 커밋이 있으면 모든 화면에 알림과 업데이트 버튼 (관리 토큰 없이, D-60)
 * - 서버가 새 버전으로 다시 켜졌는데 이 화면이 옛 코드면 새로 고침 안내
 */
export function UpdateBanner({ view, onApply }: { view: ConnView; onApply: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const info = view.info;
  const u = info?.update;
  const commit = info?.version?.commit;

  // 1) 서버는 새 버전인데 화면은 옛 버전
  if (view.state === 'connected' && commit && view.firstCommit && commit !== view.firstCommit) {
    return (
      <Notice title={`서버가 새 버전(${commit})으로 다시 시작했어요.`} body="이 화면은 이전 버전이에요. 새로 고치면 새 화면을 받아요.">
        <Button size="sm" onClick={() => location.reload()}>
          새로 고침
        </Button>
      </Notice>
    );
  }
  if (!u) return null;

  if (u.state === 'updating' || u.state === 'restarting') {
    return <Notice title={u.state === 'restarting' ? '업데이트를 마치고 서버를 다시 시작하는 중이에요.' : `업데이트 중이에요 — ${u.step ?? ''}`} body="잠시 연결이 끊겼다가 자동으로 다시 연결돼요." />;
  }
  if (u.state === 'restart_required') {
    return <Notice title="업데이트를 받았어요. 서버를 다시 실행해야 적용돼요." body={`${u.message ?? ''} 터미널에서 서버를 끄고(Ctrl+C) 다시 실행하세요.`} />;
  }
  if (u.state === 'failed') {
    return (
      <Notice tone="error" title={`업데이트 실패${u.step ? ` (${u.step})` : ''}`} body={u.message ?? ''}>
        {u.log && (
          <details className="w-full text-xs">
            <summary className="cursor-pointer text-muted-foreground">출력 보기</summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded border bg-muted/40 p-2 whitespace-pre-wrap">{u.log}</pre>
          </details>
        )}
      </Notice>
    );
  }
  // 함께 받는 저장소만 받은 뒤 (Harness는 최신 → 재시작 없음) 결과 안내 (D-58)
  if (u.state === 'up_to_date' && u.message && (u.repos ?? []).some((r) => r.updated)) {
    return <Notice title="업데이트를 받았어요." body={u.message} />;
  }
  const pending = u.state === 'available' ? pendingUpdates(u) : [];
  if (!pending.length) return null;

  const canApply = u.canApply && info?.admin;
  const total = pending.reduce((n, p) => n + p.behind, 0);
  return (
    <Notice
      title={`새 버전이 있어요 — ${pending.map((p) => p.name).join(', ')} (커밋 ${total}개)`}
      body={
        <>
          {pending.map((p) => (
            <div key={p.name} className="mt-1">
              <p className="text-foreground">
                {p.name} · 커밋 {p.behind}개{p.codeOnly ? ' · 코드만 받음 (다시 실행은 직접)' : ''}
              </p>
              <ul className="list-disc pl-5">
                {p.commits.slice(0, 5).map((c) => (
                  <li key={c.sha}>
                    <span className="font-mono text-xs">{c.sha}</span> {c.subject}
                  </li>
                ))}
                {p.behind > 5 && <li>외 {p.behind - 5}개</li>}
              </ul>
            </div>
          ))}
          {u.message && <p className="mt-1">{u.message}</p>}
          {!canApply && <p className="mt-1">이 서버는 웹 업데이트를 받지 않아요. 터미널에서 git pull 후 다시 실행하세요.</p>}
        </>
      }
    >
      {canApply && (
        <Button
          size="sm"
          disabled={busy || view.state !== 'connected'}
          onClick={() => {
            setBusy(true);
            void onApply().finally(() => setBusy(false));
          }}
        >
          {busy ? '업데이트 중' : '업데이트'}
        </Button>
      )}
    </Notice>
  );
}

function Notice({ title, body, children, tone }: { title: string; body?: React.ReactNode; children?: React.ReactNode; tone?: 'error' }) {
  return (
    <div role="status" className={`mt-4 flex flex-wrap items-start justify-between gap-3 rounded-md border px-4 py-3 text-sm ${tone === 'error' ? 'border-destructive/40' : 'border-input'}`}>
      <div className="min-w-0 flex-1">
        <p className={`font-medium ${tone === 'error' ? 'text-destructive' : ''}`}>{title}</p>
        {body && <div className="text-muted-foreground">{body}</div>}
      </div>
      {children}
    </div>
  );
}
