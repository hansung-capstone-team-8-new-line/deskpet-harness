import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ConnView, HarnessConnection } from '@/lib/connection';
import { WIFI_STATE_LABEL, checkResultText, formatDateTime, type WifiNetwork } from '@/lib/server-info';
import type { SavedConnection, Settings } from '@/lib/settings';

const CHECK_OK = '__check_ok__';

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
  admin_disabled: '웹 업데이트 미지원 서버',
  admin_unauthorized: '관리 토큰 요구 (이전 버전 서버)',
  not_connected: '서버 연결 후 재시도',
  timeout: '응답 없음',
  internal: '서버 처리 실패. 서버 콘솔 확인',
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
}: {
  conn: HarnessConnection;
  view: ConnView;
  connection: SavedConnection;
  settings: Settings;
  onSettings: (p: Partial<Settings>) => void;
  onReconnect: (c: SavedConnection) => void;
}) {
  const [url, setUrl] = useState(connection.url);
  const [msg, setMsg] = useState<string>();
  const [checking, setChecking] = useState(false);
  const info = view.info;
  const u = info?.update;
  const urlChanged = url.trim() !== connection.url;

  return (
    <div className="mt-5 grid max-w-3xl gap-6">
      <Section title="연결" desc="서버 주소. 변경 시 재연결">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!url.trim()) return;
            setMsg(undefined);
            // 보기 전용 토큰(서버가 요구할 때 연결 화면에서 넣은 값)은 그대로 둔다
            if (urlChanged) onReconnect({ ...connection, url: url.trim() });
          }}
        >
          <Field id="set-url" label="서버 주소">
            <Input id="set-url" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={!url.trim() || !urlChanged}>
              저장하고 다시 연결
            </Button>
            {info?.admin && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={checking || view.state !== 'connected'}
                onClick={() => {
                  // 관리 토큰 없이 (D-60)
                  setChecking(true);
                  void conn
                    .admin('', 'update.check')
                    .then((r) => setMsg(r.ok ? CHECK_OK : adminMessage(r.message)))
                    .finally(() => setChecking(false));
                }}
              >
                {checking ? '확인 중' : '지금 새 버전 확인'}
              </Button>
            )}
          </div>
          {msg && (
            <p role="status" className="text-sm text-muted-foreground">
              {/* 확인 결과는 서버가 보낸 최신 상태로 그린다 */}
              {msg === CHECK_OK ? checkResultText(u) : msg}
            </p>
          )}
        </form>
      </Section>

      <RepoSettings conn={conn} view={view} />

      <WifiSettings conn={conn} view={view} />


      <Section title="표시" desc="이 브라우저에만 저장">
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
          {u?.repos && u.repos.length > 0 && (
            <Row label="함께 받는 저장소">
              <ul className="grid gap-0.5">
                {u.repos.map((r) => (
                  <li key={r.path}>
                    {r.name} <span className="text-muted-foreground">· {r.error ? r.error : r.behind > 0 ? `커밋 ${r.behind}개 뒤처짐` : r.commit ? `최신 (${r.commit})` : '확인 전'}{r.updated ? ` · ${r.updated.from} → ${r.updated.to} 받음` : ''}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{r.path}</span>
                  </li>
                ))}
              </ul>
            </Row>
          )}
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

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** 승인 허용 저장소 (D-36·D-52). 사용자가 직접 관리한다 (관리 토큰 없이) */
function RepoSettings({ conn, view }: { conn: HarnessConnection; view: ConnView }) {
  const server = view.info?.settings;
  const [draft, setDraft] = useState<string[] | null>(null);
  const [input, setInput] = useState('');
  const [msg, setMsg] = useState<string>();
  const [saving, setSaving] = useState(false);
  const list = draft ?? server?.allowedRepositories ?? [];
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(server?.allowedRepositories ?? []);

  const add = () => {
    const v = input.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    if (!REPO_RE.test(v)) return setMsg('owner/name 형식 (예: hansung-capstone-team-8-new-line/deskpet-harness)');
    if (list.some((r) => r.toLowerCase() === v.toLowerCase())) return setMsg('이미 있음');
    setDraft([...list, v]);
    setInput('');
    setMsg(undefined);
  };

  return (
    <Section title="승인 허용 저장소" desc="이 저장소 PR만 승인 가능. 현황 링크·열린 PR도 이 목록 사용. 비우면 제한 없음">
      {!server ? (
        <p className="text-sm text-muted-foreground">서버 정보 받는 중</p>
      ) : (
        <div className="space-y-3">
          {list.length === 0 ? (
            <p className="text-sm">제한 없음</p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {list.map((r) => (
                <li key={r} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <a href={`https://github.com/${r}`} target="_blank" rel="noreferrer noopener" className="underline-offset-2 hover:underline">
                    {r}
                  </a>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(list.filter((x) => x !== r))} aria-label={`${r} 빼기`}>
                    빼기
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Input aria-label="추가할 저장소" placeholder="owner/name 또는 GitHub 주소" value={input} onChange={(e) => setInput(e.target.value)} autoComplete="off" spellCheck={false} />
            <Button type="submit" size="sm" variant="outline" disabled={!input.trim()}>
              추가
            </Button>
          </form>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!dirty || saving || view.state !== 'connected'}
              onClick={() => {
                setSaving(true);
                void conn
                  .saveSettings({ allowedRepositories: list })
                  .then((r) => {
                    setMsg(r.ok ? r.message : adminMessage(r.message));
                    if (r.ok) setDraft(null);
                  })
                  .finally(() => setSaving(false));
              }}
            >
              {saving ? '저장 중' : '저장'}
            </Button>
            {dirty && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
                되돌리기
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {server.source === 'file' ? `웹 설정에서 저장한 목록${server.updatedAt ? ` (${formatDateTime(server.updatedAt)})` : ''}` : '.env DESKPET_ALLOWED_REPOS 값 (웹에서 저장하면 이후 이 목록을 씀)'}
            {server.persistent ? '' : ' · 메모리 저장소. 서버 종료 시 .env 값으로 복귀'}
          </p>
          {msg && (
            <p role="status" className="text-sm text-muted-foreground">
              {msg}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

const WIFI_MESSAGE: Record<string, string> = {
  wifi_disabled: 'Wi-Fi 설정 미지원 서버 (리눅스 전용, DESKPET_WIFI=off면 꺼짐)',
  not_connected: '서버 연결 후 재시도',
  timeout: '응답 없음',
  internal: '서버 처리 실패. 서버 콘솔 확인',
};

/** Wi-Fi (D-59). 관리 토큰 없이 찾기·연결 (사용자 결정 2026-11-20). 비밀번호는 이 화면에 두지 않는다 */
function WifiSettings({ conn, view }: { conn: HarnessConnection; view: ConnView }) {
  const status = view.info?.wifi;
  const [networks, setNetworks] = useState<WifiNetwork[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [target, setTarget] = useState<WifiNetwork | { ssid: string; manual: true } | null>(null);
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [identity, setIdentity] = useState('');
  const [useAccount, setUseAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const online = view.state === 'connected';

  const scan = () => {
    setScanning(true);
    setMsg(undefined);
    void conn
      .wifi('scan')
      .then((r) => {
        const d = r.data as { networks?: WifiNetwork[] } | undefined;
        if (d?.networks) setNetworks(d.networks);
        if (!r.ok) setMsg(WIFI_MESSAGE[r.message] ?? r.message);
      })
      .finally(() => setScanning(false));
  };

  const pick = (n: WifiNetwork | null) => {
    setTarget(n ?? { ssid: '', manual: true });
    setSsid(n?.ssid ?? '');
    setPassword('');
    setIdentity('');
    setUseAccount(!!n?.enterprise);
    setMsg(undefined);
  };

  const connect = () => {
    const name = ssid.trim();
    if (!name) return setMsg('Wi-Fi 이름 필요');
    setBusy(true);
    setMsg(`${name} 연결 중. Wi-Fi로 접속 중이면 잠시 끊길 수 있음`);
    void conn
      .wifi('connect', { ssid: name, ...(password ? { password } : {}), ...(useAccount && identity.trim() ? { identity: identity.trim() } : {}) })
      .then((r) => {
        setMsg(WIFI_MESSAGE[r.message] ?? r.message);
        if (r.ok) {
          setTarget(null);
          setNetworks(null);
        }
      })
      .finally(() => {
        setBusy(false);
        setPassword('');
      });
  };

  const needsPassword = target && !('manual' in target) ? target.security !== '' : true;

  return (
    <Section title="Wi-Fi" desc="젯슨 Wi-Fi 선택. 비밀번호는 젯슨 네트워크 설정에만 저장 (화면·Harness 기록에 남지 않음)">
      {!status ? (
        <p className="text-sm text-muted-foreground">서버 정보 받는 중</p>
      ) : !status.available ? (
        <p className="text-sm text-muted-foreground">{status.reason ?? 'Wi-Fi 설정 불가'}</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            {WIFI_STATE_LABEL[status.state ?? ''] ?? status.state ?? '-'}
            {status.ssid ? <span className="font-medium"> · {status.ssid}</span> : null}
            {status.signal ? <span className="text-muted-foreground"> · 신호 {status.signal}%</span> : null}
            {status.ip ? <span className="text-muted-foreground"> · 주소 {status.ip}</span> : null}
            {status.device ? <span className="text-muted-foreground"> ({status.device})</span> : null}
          </p>

          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={!online || scanning || busy} onClick={scan}>
              {scanning ? '찾는 중' : '주변 Wi-Fi 찾기'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={!online || busy} onClick={() => pick(null)}>
              이름 직접 입력
            </Button>
          </div>

          {networks && networks.length > 0 && (
            <ul className="max-h-64 divide-y overflow-auto rounded-md border text-sm" aria-label="주변 Wi-Fi">
              {networks.map((n) => (
                <li key={n.ssid}>
                  <button
                    type="button"
                    className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${target && target.ssid === n.ssid ? 'bg-muted' : ''}`}
                    onClick={() => pick(n)}
                    disabled={busy}
                  >
                    <span className="min-w-0 truncate">
                      {n.ssid}
                      {n.inUse ? <span className="text-muted-foreground"> · 연결됨</span> : null}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {n.enterprise ? '계정 · ' : n.security ? '잠김 · ' : '개방 · '}
                      {n.signal}%
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {target && (
            <form
              className="space-y-3 rounded-md border p-3"
              onSubmit={(e) => {
                e.preventDefault();
                connect();
              }}
            >
              {'manual' in target ? (
                <Field id="wifi-ssid" label="Wi-Fi 이름 (SSID)">
                  <Input id="wifi-ssid" value={ssid} onChange={(e) => setSsid(e.target.value)} autoComplete="off" spellCheck={false} />
                </Field>
              ) : (
                <p className="text-sm font-medium">{target.ssid}</p>
              )}
              <Check id="wifi-account" checked={useAccount} onChange={setUseAccount} label="학교·회사 계정으로 로그인하는 Wi-Fi (아이디 필요)" />
              {useAccount && (
                <Field id="wifi-identity" label="아이디">
                  <Input id="wifi-identity" value={identity} onChange={(e) => setIdentity(e.target.value)} autoComplete="off" spellCheck={false} />
                </Field>
              )}
              {(needsPassword || useAccount) && (
                <Field id="wifi-password" label="비밀번호">
                  <Input id="wifi-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                </Field>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={!online || busy || !ssid.trim() || (useAccount && !identity.trim())}>
                  {busy ? '연결 중' : '연결'}
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setTarget(null)}>
                  취소
                </Button>
              </div>
            </form>
          )}

          {msg && (
            <p role="status" className="text-sm text-muted-foreground">
              {msg}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

