import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Updater, defaultRunner, redact, type Runner } from '../../scripts/updater.js';

/**
 * D-49 업데이트 확인 / D-50 웹 업데이트 버튼.
 * 실제 git 저장소 3개(원격 bare, 이 기기, 다른 개발자)로 확인한다. pnpm 단계는 기록만 하는 가짜.
 */
const root = mkdtempSync(join(tmpdir(), 'deskpet-update-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

function setup() {
  const dir = join(root, `case${++n}`);
  const remote = join(dir, 'remote.git');
  const local = join(dir, 'local');
  const other = join(dir, 'other');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'app', remote], { stdio: 'pipe' });
  execFileSync('git', ['clone', '-q', remote, other], { stdio: 'pipe' });
  git(other, 'checkout', '-q', '-b', 'app');
  writeFileSync(join(other, 'a.txt'), '1');
  writeFileSync(join(other, 'package.json'), '{}');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'first');
  git(other, 'push', '-q', '-u', 'origin', 'app');
  execFileSync('git', ['clone', '-q', '-b', 'app', remote, local], { stdio: 'pipe' });
  const push = (file: string, content: string, msg: string) => {
    writeFileSync(join(other, file), content);
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', msg);
    git(other, 'push', '-q');
  };
  return { local, other, push };
}

function make(local: string, o: { canApply?: boolean; inFlight?: number; restart?: 'restarting' | 'manual'; failBuild?: boolean } = {}) {
  const pnpm: string[] = [];
  const run: Runner = (cmd, args, opts) => {
    if (cmd === 'pnpm') {
      pnpm.push(args.join(' '));
      return Promise.resolve(o.failBuild && args[0] === 'web:build' ? { code: 1, stdout: 'vite build\nerror TS1005', stderr: '' } : { code: 0, stdout: '', stderr: '' });
    }
    return defaultRunner(cmd, args, opts);
  };
  const states: string[] = [];
  const u = new Updater({ cwd: local, canApply: o.canApply ?? true, inFlight: () => o.inFlight ?? 0, restart: () => o.restart ?? 'restarting', run, onChange: (s) => states.push(s.state) });
  return { u, pnpm, states };
}

describe('업데이트 확인 (D-49)', () => {
  it('원격에 새 커밋이 있으면 available, 커밋 수·제목을 알려 준다', async () => {
    const { local, push } = setup();
    const { u } = make(local);
    expect((await u.check()).state).toBe('up_to_date');
    push('a.txt', '2', 'fix: 두 번째');
    push('a.txt', '3', 'feat: 세 번째');
    const s = await u.check();
    expect(s).toMatchObject({ state: 'available', behind: 2, ahead: 0, upstream: 'origin/app' });
    expect(s.commits?.map((c) => c.subject)).toEqual(['feat: 세 번째', 'fix: 두 번째']);
    expect(s.current?.subject).toBe('first');
  });

  it('upstream이 없으면 확인 실패로 표시한다', async () => {
    const { local } = setup();
    git(local, 'checkout', '-q', '-b', 'mine');
    const { u } = make(local);
    const s = await u.check();
    expect(s.state).toBe('check_failed');
    expect(s.message).toContain('mine');
  });
});

describe('업데이트 적용 (D-50)', () => {
  it('빨리 감기로 받고, package.json이 바뀌면 설치, 빌드 뒤 재시작', async () => {
    const { local, push } = setup();
    push('package.json', '{"a":1}', 'deps');
    const { u, pnpm, states } = make(local);
    const r = await u.apply();
    expect(r.ok).toBe(true);
    expect(pnpm).toEqual(['install --frozen-lockfile', 'web:build']);
    expect(git(local, 'log', '-1', '--format=%s')).toBe('deps');
    expect(u.status.state).toBe('restarting');
    expect(states).toContain('updating');
  });

  it('패키지가 안 바뀌면 설치를 건너뛴다. 재시작을 못 하면 다시 실행 필요', async () => {
    const { local, push } = setup();
    push('a.txt', 'x', 'code only');
    const { u, pnpm } = make(local, { restart: 'manual' });
    await u.apply();
    expect(pnpm).toEqual(['web:build']);
    expect(u.status.state).toBe('restart_required');
    // 확인을 다시 해도 '다시 실행 필요'는 지우지 않는다
    expect((await u.check()).state).toBe('restart_required');
  });

  it('커밋하지 않은 변경이 있으면 하지 않는다 (로컬 수정 보호)', async () => {
    const { local, push } = setup();
    push('a.txt', 'x', 'new');
    writeFileSync(join(local, 'package.json'), '{"packageManager":"pnpm@12"}');
    const { u, pnpm } = make(local);
    const r = await u.apply();
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain('package.json');
    expect(pnpm).toEqual([]);
    expect(git(local, 'log', '-1', '--format=%s')).toBe('first');
  });

  it('이 기기에만 있는 커밋이 있으면(갈라짐) 받지 않는다', async () => {
    const { local, push } = setup();
    push('a.txt', 'remote', 'remote change');
    writeFileSync(join(local, 'b.txt'), 'local');
    git(local, 'add', '.');
    git(local, 'commit', '-q', '-m', 'local only');
    const { u } = make(local);
    const r = await u.apply();
    expect(r.ok).toBe(false);
    expect(u.status).toMatchObject({ state: 'failed', step: '새 코드 받기' });
    expect(u.status.message).toContain('이 기기에만 있는 커밋 1개');
  });

  it('처리 중인 요청이 있거나 관리 토큰이 없으면 하지 않는다', async () => {
    const { local, push } = setup();
    push('a.txt', 'x', 'new');
    expect((await make(local, { inFlight: 2 }).u.apply()).message).toContain('처리 중인 요청 2건');
    expect((await make(local, { canApply: false }).u.apply()).ok).toBe(false);
    expect(git(local, 'log', '-1', '--format=%s')).toBe('first');
  });

  it('빌드 실패: 멈추고 이전 커밋과 출력 끝부분을 알려 준다', async () => {
    const { local, push } = setup();
    const before = git(local, 'log', '-1', '--format=%h');
    push('a.txt', 'x', 'broken');
    const { u } = make(local, { failBuild: true });
    const r = await u.apply();
    expect(r.ok).toBe(false);
    expect(u.status).toMatchObject({ state: 'failed', step: '웹 화면 빌드' });
    expect(u.status.message).toContain(before);
    expect(u.status.log).toContain('error TS1005');
  });

  it('최신이면 아무것도 하지 않는다', async () => {
    const { local } = setup();
    const { u, pnpm } = make(local);
    expect(await u.apply()).toEqual({ ok: true, message: '이미 최신 버전이에요' });
    expect(pnpm).toEqual([]);
  });
});

describe('출력 가리기', () => {
  it('주소 안의 인증 정보와 GitHub 토큰은 가린다', () => {
    expect(redact('fatal: unable to access https://user:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x/y.git')).toBe('fatal: unable to access https://***@github.com/x/y.git');
    expect(redact('token github_pat_11ABCDEFGHIJKLMNOPQRSTUV_xyz')).toBe('token ***');
  });
});
