import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * 업데이트 확인·적용 (D-49, D-50). app 폴더(git 저장소)의 현재 브랜치를 upstream(예: origin/app)과 비교한다.
 *
 * 확인 (모든 웹 화면에 알림)
 * - 주기적으로 git fetch → 뒤처진 커밋 수·제목 (최대 10개)
 * - 인증을 묻는 창이 뜨지 않게 GIT_TERMINAL_PROMPT=0. 실패하면 확인 실패로만 표시
 *
 * 적용 (관리 토큰이 있는 웹 화면에서만 — 서버가 확인)
 * 1. 처리 중인 요청이 있으면 하지 않는다
 * 2. 커밋하지 않은 변경(추적 중인 파일)이 있으면 하지 않는다 — 로컬 수정을 덮지 않게
 * 3. git merge --ff-only (빨리 감기만. 갈라졌으면 하지 않음)
 * 4. package.json·pnpm-lock.yaml이 바뀌었으면 pnpm install --frozen-lockfile
 * 5. pnpm web:build
 * 6. 재시작: pnpm start(감시 프로세스)로 켰으면 자동, 아니면 "다시 실행 필요"
 * 중간에 실패하면 멈추고 단계·출력 끝부분을 보여 준다 (자동 되돌리기는 하지 않음 — 이전 커밋을 알려 줌)
 *
 * 함께 받는 저장소 (D-58, 2026-11-16 사용자 결정 — 팀 조직의 product·pipeline·hardware)
 * - Harness 폴더와 같은 위치의 deskpet-product·deskpet-pipeline·deskpet-hardware를 같이 확인한다
 * - 적용하면 그 저장소들은 빨리 감기로 코드만 받는다 (설치·빌드·재시작은 하지 않음 — 실행 방법이 저장소마다 다름)
 * - Harness보다 먼저 받는다 (Harness는 받은 뒤 재시작하므로). 어느 저장소든 로컬 수정이 있으면 아무것도 받지 않는다
 */
export type UpdateState = 'disabled' | 'idle' | 'checking' | 'up_to_date' | 'available' | 'check_failed' | 'updating' | 'restarting' | 'restart_required' | 'failed';

/** 함께 받는 저장소 하나의 상태 (D-58) */
export interface RepoUpdateStatus {
  name: string;
  path: string;
  branch?: string;
  commit?: string;
  upstream?: string;
  behind: number;
  ahead: number;
  commits: { sha: string; subject: string }[];
  /** 확인·받기 실패 이유 */
  error?: string;
  /** 마지막 적용에서 받은 커밋 (이전 → 이후) */
  updated?: { from: string; to: string };
}

export interface UpdateStatus {
  state: UpdateState;
  /** 함께 받는 저장소 (D-58). behind·commits는 Harness 것만 */
  repos?: RepoUpdateStatus[];
  /** 관리 토큰이 설정돼 웹에서 업데이트할 수 있는지 */
  canApply: boolean;
  current?: { commit: string; subject: string; branch: string };
  upstream?: string;
  behind?: number;
  ahead?: number;
  commits?: { sha: string; subject: string }[];
  checkedAt?: string;
  /** 업데이트 중인 단계 */
  step?: string;
  message?: string;
  /** 실패한 명령 출력 끝부분 (주소 안의 인증 정보는 가림) */
  log?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>;

export interface UpdaterOptions {
  cwd: string;
  /** 함께 받는 저장소 (D-58) — 코드만 받는다 */
  repos?: { name: string; cwd: string }[];
  canApply: boolean;
  /** 처리 중인 요청 수 */
  inFlight: () => number;
  /** 빌드까지 끝난 뒤 부른다. 'restarting'(자동 재시작) 또는 'manual'(다시 실행 필요) */
  restart: () => 'restarting' | 'manual';
  onChange?: (s: UpdateStatus) => void;
  run?: Runner;
  now?: () => number;
  log?: (line: string) => void;
}

const STEP = { pull: '새 코드 받기', install: '패키지 설치', build: '웹 화면 빌드', restart: '재시작' } as const;

export class Updater {
  private s: UpdateStatus;
  private timer?: ReturnType<typeof setInterval>;
  private readonly run: Runner;

  constructor(private readonly o: UpdaterOptions) {
    this.run = o.run ?? defaultRunner;
    this.s = { state: 'idle', canApply: o.canApply, ...(o.repos?.length ? { repos: o.repos.map((r) => ({ name: r.name, path: r.cwd, behind: 0, ahead: 0, commits: [] })) } : {}) };
  }

  get status(): UpdateStatus {
    return this.s;
  }

  private set(p: Partial<UpdateStatus>, replace = false) {
    this.s = replace ? ({ canApply: this.o.canApply, ...(this.s.repos ? { repos: this.s.repos } : {}), ...p } as UpdateStatus) : { ...this.s, ...p };
    this.o.onChange?.(this.s);
  }

  private git(args: string[], timeoutMs = 30_000, cwd = this.o.cwd) {
    return this.run('git', args, { cwd, timeoutMs });
  }

  /** 주기 확인 시작. 첫 확인은 firstDelayMs 뒤 */
  start(intervalMs: number, firstDelayMs = 5_000) {
    const tick = () => {
      if (this.s.state !== 'updating' && this.s.state !== 'restarting') void this.check();
    };
    setTimeout(tick, firstDelayMs).unref?.();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 현재 커밋만 읽는다 (fetch 없음). 시작할 때 화면에 버전을 보여 주기 위해 */
  async readCurrent(): Promise<void> {
    const cur = await this.current();
    if (cur) this.set({ current: cur });
    else this.set({ state: 'disabled', message: 'git 저장소가 아니라 업데이트를 확인할 수 없어요' }, true);
  }

  private async current(cwd = this.o.cwd): Promise<UpdateStatus['current'] | undefined> {
    const head = await this.git(['log', '-1', '--format=%h%x09%s'], 30_000, cwd);
    const br = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], 30_000, cwd);
    if (head.code !== 0) return undefined;
    const [commit = '', subject = ''] = head.stdout.trim().split('\t');
    return { commit, subject, branch: br.stdout.trim() };
  }

  async check(): Promise<UpdateStatus> {
    if (this.s.state === 'updating' || this.s.state === 'restarting') return this.s;
    if (this.s.state === 'disabled') return this.s;
    const prev = this.s;
    this.set({ state: 'checking' });
    const r = await this.compare(true);
    const repos = await this.checkRepos(prev.repos);
    if (!r.ok) {
      this.set({ state: 'check_failed', message: r.message, checkedAt: this.iso(), ...(repos ? { repos } : {}) });
      return this.s;
    }
    // 업데이트 뒤 '다시 실행 필요' 상태는 확인으로 지우지 않는다
    const keep = prev.state === 'restart_required' || prev.state === 'failed' ? { state: prev.state, message: prev.message, ...(prev.log ? { log: prev.log } : {}) } : { message: undefined, log: undefined };
    const any = r.behind > 0 || (repos ?? []).some((x) => x.behind > 0);
    this.set({ state: any ? 'available' : 'up_to_date', current: r.current, upstream: r.upstream, behind: r.behind, ahead: r.ahead, commits: r.commits, checkedAt: this.iso(), step: undefined, ...(repos ? { repos } : {}), ...keep });
    return this.s;
  }

  /** 함께 받는 저장소를 확인한다. 하나가 실패해도 나머지는 계속 (그 저장소에 이유만 남김) */
  private async checkRepos(prev?: RepoUpdateStatus[]): Promise<RepoUpdateStatus[] | undefined> {
    if (!this.o.repos?.length) return undefined;
    const out: RepoUpdateStatus[] = [];
    for (const repo of this.o.repos) {
      const r = await this.compare(true, repo.cwd);
      const was = prev?.find((x) => x.path === repo.cwd)?.updated;
      out.push(
        r.ok
          ? { name: repo.name, path: repo.cwd, branch: r.current.branch, commit: r.current.commit, upstream: r.upstream, behind: r.behind, ahead: r.ahead, commits: r.commits, ...(was ? { updated: was } : {}) }
          : { name: repo.name, path: repo.cwd, behind: 0, ahead: 0, commits: [], error: r.message },
      );
    }
    return out;
  }

  private async compare(fetch: boolean, cwd = this.o.cwd): Promise<
    | { ok: true; current: NonNullable<UpdateStatus['current']>; upstream: string; behind: number; ahead: number; commits: { sha: string; subject: string }[] }
    | { ok: false; message: string; log?: string }
  > {
    const current = await this.current(cwd);
    if (!current) return { ok: false, message: 'git 저장소가 아니에요' };
    const up = await this.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 30_000, cwd);
    const upstream = up.stdout.trim();
    if (up.code !== 0 || !upstream) return { ok: false, message: `현재 브랜치(${current.branch})에 연결된 원격 브랜치가 없어요 (git branch -u origin/${current.branch})` };
    if (fetch) {
      const remote = upstream.split('/')[0]!;
      const f = await this.git(['fetch', '--quiet', remote], 60_000, cwd);
      if (f.code !== 0) return { ok: false, message: '원격 저장소에서 새 버전을 확인하지 못했어요 (네트워크·인증)', log: tail(f) };
    }
    const counts = await this.git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], 30_000, cwd);
    const [ahead = 0, behind = 0] = counts.stdout.trim().split(/\s+/).map(Number);
    const log = behind > 0 ? await this.git(['log', '--format=%h%x09%s', '-n', '10', `HEAD..${upstream}`], 30_000, cwd) : { stdout: '' };
    const commits = log.stdout.split('\n').filter(Boolean).map((l) => {
      const [sha = '', subject = ''] = l.split('\t');
      return { sha, subject };
    });
    return { ok: true, current, upstream, behind, ahead, commits };
  }

  async apply(): Promise<{ ok: boolean; message: string }> {
    if (!this.o.canApply) return { ok: false, message: '관리 토큰이 설정되지 않아 웹에서 업데이트할 수 없어요' };
    if (this.s.state === 'updating' || this.s.state === 'restarting') return { ok: false, message: '이미 업데이트하고 있어요' };
    if (this.s.state === 'disabled') return { ok: false, message: this.s.message ?? '업데이트할 수 없어요' };
    const busy = this.o.inFlight();
    if (busy > 0) return { ok: false, message: `처리 중인 요청 ${busy}건이 끝난 뒤 다시 눌러 주세요` };

    // 로컬 수정은 모든 저장소에서 먼저 확인한다 (하나라도 있으면 아무것도 받지 않음)
    for (const [name, cwd] of [['harness', this.o.cwd], ...(this.o.repos ?? []).map((r) => [r.name, r.cwd])] as [string, string][]) {
      const dirty = await this.git(['status', '--porcelain', '--untracked-files=no'], 30_000, cwd);
      const files = dirty.stdout.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
      if (dirty.code !== 0 || files.length) {
        const where = this.o.repos?.length ? `${name}: ` : '';
        const msg = dirty.code !== 0 ? `${where}git 상태를 읽지 못했어요` : `${where}커밋하지 않은 변경이 있어 업데이트하지 않았어요: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` 외 ${files.length - 5}개` : ''}`;
        this.set({ message: msg });
        return { ok: false, message: msg };
      }
    }

    this.set({ state: 'updating', step: STEP.pull, message: undefined, log: undefined });
    // 함께 받는 저장소 먼저 (코드만)
    const pulled: string[] = [];
    const repos: RepoUpdateStatus[] = [];
    for (const repo of this.o.repos ?? []) {
      const step = `${repo.name} 받기`;
      this.set({ step });
      const c = await this.compare(true, repo.cwd);
      if (!c.ok) {
        repos.push({ name: repo.name, path: repo.cwd, behind: 0, ahead: 0, commits: [], error: c.message });
        this.set({ repos: [...repos, ...this.restRepos(repos)] });
        return this.failed(step, `${repo.name}: ${c.message}${pulled.length ? ` (먼저 받은 저장소: ${pulled.join(', ')})` : ''}`, c.log);
      }
      const base = { name: repo.name, path: repo.cwd, branch: c.current.branch, upstream: c.upstream, ahead: c.ahead };
      if (c.behind === 0) {
        repos.push({ ...base, commit: c.current.commit, behind: 0, commits: [] });
        continue;
      }
      const m = await this.git(['merge', '--ff-only', c.upstream], 60_000, repo.cwd);
      if (m.code !== 0) {
        repos.push({ ...base, commit: c.current.commit, behind: c.behind, commits: c.commits, error: '빨리 감기로 받지 못했어요' });
        this.set({ repos: [...repos, ...this.restRepos(repos)] });
        return this.failed(step, `${repo.name}: ${c.ahead > 0 ? `이 기기에만 있는 커밋 ${c.ahead}개가 있어 빨리 감기로 받을 수 없어요. 터미널에서 정리해 주세요` : '새 코드를 받지 못했어요'}${pulled.length ? ` (먼저 받은 저장소: ${pulled.join(', ')})` : ''}`, tail(m));
      }
      const after = (await this.current(repo.cwd))?.commit ?? '';
      repos.push({ ...base, commit: after, behind: 0, commits: [], updated: { from: c.current.commit, to: after } });
      pulled.push(repo.name);
    }
    if (repos.length) this.set({ repos });
    const others = pulled.length ? ` ${pulled.join('·')}는 코드만 받았어요 — 켜져 있으면 직접 다시 실행하세요` : '';

    this.set({ step: STEP.pull });
    const cmp = await this.compare(true);
    if (!cmp.ok) return this.failed(STEP.pull, cmp.message, cmp.log);
    if (cmp.behind === 0) {
      const message = pulled.length ? `Harness는 이미 최신이에요.${others}` : '이미 최신 버전이에요';
      this.set({ state: 'up_to_date', step: undefined, current: cmp.current, upstream: cmp.upstream, behind: 0, ahead: cmp.ahead, commits: [], checkedAt: this.iso(), ...(pulled.length ? { message } : {}) });
      if (pulled.length) this.o.log?.(message);
      return { ok: true, message };
    }
    const before = cmp.current.commit;
    const merge = await this.git(['merge', '--ff-only', cmp.upstream], 60_000);
    if (merge.code !== 0) return this.failed(STEP.pull, cmp.ahead > 0 ? `이 기기에만 있는 커밋 ${cmp.ahead}개가 있어 빨리 감기로 받을 수 없어요. 터미널에서 정리해 주세요` : '새 코드를 받지 못했어요', tail(merge));

    const changed = await this.git(['diff', '--name-only', before, 'HEAD']);
    const needInstall = changed.stdout.split('\n').some((f) => /(^|\/)package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$/.test(f.trim()));
    if (needInstall) {
      this.set({ step: STEP.install });
      const i = await this.run('pnpm', ['install', '--frozen-lockfile'], { cwd: this.o.cwd, timeoutMs: 10 * 60_000 });
      if (i.code !== 0) return this.failed(STEP.install, `패키지 설치에 실패했어요 (이전 버전 ${before})`, tail(i));
    }
    this.set({ step: STEP.build });
    const b = await this.run('pnpm', ['web:build'], { cwd: this.o.cwd, timeoutMs: 10 * 60_000 });
    if (b.code !== 0) return this.failed(STEP.build, `웹 화면 빌드에 실패했어요 (이전 버전 ${before})`, tail(b));

    const cur = await this.current();
    this.set({ step: STEP.restart, ...(cur ? { current: cur } : {}), behind: 0, commits: [] });
    const how = this.o.restart();
    const message = (how === 'restarting' ? `${cur?.commit ?? ''}로 업데이트했어요. 서버를 다시 시작합니다` : `${cur?.commit ?? ''}로 업데이트했어요. 서버를 다시 실행해야 적용돼요 (pnpm start로 켜면 다음부터 자동 재시작)`) + (others ? `.${others}` : '');
    this.set({ state: how === 'restarting' ? 'restarting' : 'restart_required', step: undefined, message });
    this.o.log?.(message);
    return { ok: true, message };
  }

  /** 실패로 멈췄을 때 아직 손대지 않은 저장소의 이전 상태 */
  private restRepos(done: RepoUpdateStatus[]): RepoUpdateStatus[] {
    return (this.s.repos ?? []).filter((r) => !done.some((d) => d.path === r.path));
  }

  private failed(step: string, message: string, log?: string) {
    this.set({ state: 'failed', step, message, ...(log ? { log } : {}) });
    this.o.log?.(`업데이트 실패 (${step}): ${message}`);
    return { ok: false, message };
  }

  private iso() {
    return new Date((this.o.now ?? Date.now)()).toISOString();
  }
}

/** 함께 받는 저장소 기본 이름 (D-58): 팀 조직의 deskpet-product·deskpet-pipeline·deskpet-hardware */
export const DEFAULT_SIBLING_REPOS = ['product', 'pipeline', 'hardware'] as const;

/**
 * 함께 받을 저장소 찾기 (D-58).
 * - spec 비움: Harness 폴더(app)와 같은 위치에서 deskpet-<이름> 폴더를 찾는다.
 *   app이 저장소 맨 위(~/deskpet-harness)면 그 옆, app이 그 안(~/deskpet-harness/app)이면 한 단계 위 옆, 그리고 홈 폴더
 * - spec 'off': 끔 / 'name=경로,…' 또는 '경로,…': 그대로 (상대 경로는 app 기준)
 * git 저장소(.git이 있는 폴더)만, Harness 자신과 그 상위 폴더는 뺀다
 */
export function findSiblingRepos(appRoot: string, spec?: string, home = homedir(), isRepo: (p: string) => boolean = (p) => existsSync(join(p, '.git'))): { name: string; cwd: string }[] {
  const raw = spec?.trim() ?? '';
  if (raw.toLowerCase() === 'off') return [];
  const self = resolve(appRoot);
  const ok = (p: string) => p !== self && !(self + sep).startsWith(p + sep) && isRepo(p);
  const out: { name: string; cwd: string }[] = [];
  const add = (name: string, p: string) => {
    if (ok(p) && !out.some((x) => x.cwd === p)) out.push({ name, cwd: p });
  };
  if (raw) {
    for (const part of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
      const eq = part.indexOf('=');
      const p = resolve(self, eq > 0 ? part.slice(eq + 1).trim() : part);
      const name = eq > 0 ? part.slice(0, eq).trim() : (p.split(sep).pop() ?? p).replace(/^deskpet-/, '');
      add(name, p);
    }
    return out;
  }
  const bases = [...new Set([dirname(self), dirname(dirname(self)), resolve(home)])];
  for (const name of DEFAULT_SIBLING_REPOS) {
    const hit = bases.map((b) => join(b, `deskpet-${name}`)).find(ok);
    if (hit) add(name, hit);
  }
  return out;
}

/** 명령 출력 끝부분. URL 안의 인증 정보(https://user:token@…)는 가린다 */
export function tail(r: { stdout?: string; stderr?: string }, lines = 20): string {
  const all = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n').filter((l) => l.trim());
  return redact(all.slice(-lines).join('\n')).slice(-4_000);
}

export function redact(s: string): string {
  return s.replace(/(\w+:\/\/)[^@/\s]+@/g, '$1***@').replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '***');
}

export const defaultRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      // Windows의 pnpm은 .cmd라 셸이 필요하다 (인자는 고정 값만 넘긴다)
      shell: process.platform === 'win32' && cmd !== 'git',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(process.env['GIT_SSH_COMMAND'] ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }) },
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), opts.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (stdout = (stdout + d.toString()).slice(-64_000)));
    child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-64_000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
