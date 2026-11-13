import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ConnView, HarnessConnection } from '@/lib/connection';
import { formatDateTime } from '@/lib/server-info';
import type { SavedConnection, Settings } from '@/lib/settings';

const UPDATE_STATE_LABEL: Record<string, string> = {
  disabled: '확인 안 함',
  idle: '아직 확인 전',
  checking: '확인 중',
  up_to_date: '최신',
  available: '새 버전 있음',
  check_failed: '확인 실패',
  updating: '업데이트 중',
  restarting: '다시 시작 중',
  restart_required: '다시 실행 필요',
  failed: '업데이트 실패',
};

const ADMIN_MESSAGE: Record<string, string> = {
  admin_disabled: '서버에 관리 토큰(HARNESS_WEB_ADMIN_TOKEN)이 설정되지 않았어요.',
  admin_unauthorized: '관리 토큰이 맞지 않아요.',
  not_connected: '서버에 연결된 뒤 다시 시도하세요.',
  timeout: '응답이 없어요.',
  internal: '서버에서 처리하지 못했어요. 서버 콘솔을 확인하세요.',
};
export function adminMessage(m: string): string {
  return ADMIN_MESSAGE[m] ?? m;
}

/** 설정 (D-48): 연결(서버 주소·관리 토큰), 표시, 서버 정보 */
export function SettingsView({
  conn,
  view,
  connection,
  settings,
  onSettings,
  onReconnect,
  adminToken,
  onAdminToken,
}: {
  conn: HarnessConnection;
  view: ConnView;
  connection: SavedConnection;
  settings: Settings;
  onSettings: (p: Partial<Settings>) => void;
  onReconnect: (c: SavedConnection) => void;
  adminToken: string;
  onAdminToken: (t: string) => void;
}) {
  const [url, setUrl] = useState(connection.url);
  const [admin, setAdmin] = useState(adminToken);
  const [msg, setMsg] = useState<string>();
  const [checking, setChecking] = useState(false);
  const info = view.info;
  const u = info?.update;
  const urlChanged = url.trim() !== connection.url;
  const changed = urlChanged || admin.trim() !== adminToken;

  return (
    <div className="mt-5 grid max-w-3xl gap-6">
      <Section title="연결" desc="서버 주소와 관리 토큰. 주소를 바꾸면 다시 연결합니다.">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!url.trim()) return;
            onAdminToken(admin.trim());
            setMsg(admin.trim() !== adminToken ? (admin.trim() ? '관리 토큰을 넣었어요.' : '관리 토큰을 지웠어요.') : undefined);
            // 보기 전용 토큰(서버가 요구할 때 연결 화면에서 넣은 값)은 그대로 둔다
            if (urlChanged) onReconnect({ ...connection, url: url.trim() });
          }}
        >
          <Field id="set-url" label="서버 주소">
            <Input id="set-url" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <Field
            id="set-admin"
            label="관리 토큰"
            help={info?.admin ? '서버 .env의 HARNESS_WEB_ADMIN_TOKEN과 같은 값을 넣으면 업데이트 버튼을 쓸 수 있어요. 이 탭에만 두고, 탭을 닫으면 지워집니다.' : '이 서버는 관리 토큰(HARNESS_WEB_ADMIN_TOKEN)이 설정되지 않아 웹에서 업데이트할 수 없어요. 새 버전 알림만 보여요.'}
          >
            <Input id="set-admin" type="password" value={admin} onChange={(e) => setAdmin(e.target.value)} autoComplete="off" disabled={!info?.admin} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={!url.trim() || !changed}>
              {urlChanged ? '저장하고 다시 연결' : '저장'}
            </Button>
            {info?.admin && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!admin.trim() || checking || view.state !== 'connected'}
                onClick={() => {
                  // 입력한 값을 저장하고 그 값으로 확인한다 (토큰이 맞는지도 함께 확인됨)
                  const t = admin.trim();
                  onAdminToken(t);
                  setChecking(true);
                  void conn
                    .admin(t, 'update.check')
                    .then((r) => setMsg(r.ok ? '관리 토큰이 맞아요. 새 버전도 확인했어요.' : adminMessage(r.message)))
                    .finally(() => setChecking(false));
                }}
              >
                {checking ? '확인 중' : '지금 새 버전 확인'}
              </Button>
            )}
          </div>
          {msg && (
            <p role="status" className="text-sm text-muted-foreground">
              {msg}
            </p>
          )}
        </form>
      </Section>

      <Section title="표시" desc="이 브라우저에만 저장됩니다.">
        <div className="space-y-3">
          <Check id="set-hide" checked={settings.hideFinished} onChange={(v) => onSettings({ hideFinished: v })} label="작업 목록에서 완료·취소된 작업 숨기기" />
          <Check id="set-reload" checked={settings.autoReload} onChange={(v) => onSettings({ autoReload: v })} label="웹에서 업데이트한 뒤 화면 자동 새로 고침" />
        </div>
      </Section>

      <Section title="서버 정보">
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-sm">
          <Row label="버전">{info?.version ? `${info.version.commit} ${info.version.subject} (${info.version.branch})` : '-'}</Row>
          <Row label="서버 시작">{info?.startedAt ? formatDateTime(info.startedAt) : '-'}</Row>
          <Row label="업데이트">
            {u ? UPDATE_STATE_LABEL[u.state] ?? u.state : '-'}
            {u?.checkedAt ? <span className="text-muted-foreground"> · {formatDateTime(u.checkedAt)} 확인</span> : null}
            {u?.state === 'check_failed' && u.message ? <span className="block text-muted-foreground">{u.message}</span> : null}
          </Row>
          <Row label="자동 재시작">{info ? (info.supervised ? '켜짐 (pnpm start)' : '꺼짐 — 업데이트 뒤 직접 다시 실행') : '-'}</Row>
          <Row label="세션 기록">{info ? (info.history ? (info.history.persistent ? '파일에 저장' : '메모리 (서버를 끄면 사라짐)') : '꺼짐') : '-'}</Row>
        </dl>
      </Section>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {desc && <p className="mt-0.5 text-sm text-muted-foreground">{desc}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function Check({ id, checked, onChange, label, help }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; help?: string }) {
  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-primary" />
        {label}
      </label>
      {help && <p className="mt-0.5 ml-6 text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
