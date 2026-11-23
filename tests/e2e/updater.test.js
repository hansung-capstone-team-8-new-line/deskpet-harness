import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Updater, defaultRunner, findSiblingRepos, redact } from '../../scripts/updater.js';
/**
 * D-49 업데이트 확인 / D-50 웹 업데이트 버튼.
 * 실제 git 저장소 3개(원격 bare, 이 기기, 다른 개발자)로 확인한다. pnpm 단계는 기록만 하는 가짜.
 */
const root = mkdtempSync(join(tmpdir(), 'deskpet-update-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
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
    const push = (file, content, msg) => {
        writeFileSync(join(other, file), content);
        git(other, 'add', '.');
        git(other, 'commit', '-q', '-m', msg);
        git(other, 'push', '-q');
    };
    return { local, other, push };
}
function make(local, o = {}) {
    const pnpm = [];
    const run = (cmd, args, opts) => {
        if (cmd === 'pnpm') {
            pnpm.push(args.join(' '));
            return Promise.resolve(o.failBuild && args[0] === 'web:build' ? { code: 1, stdout: 'vite build\nerror TS1005', stderr: '' } : { code: 0, stdout: '', stderr: '' });
        }
        return defaultRunner(cmd, args, opts);
    };
    const states = [];
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
describe('함께 받는 저장소 (D-58)', () => {
    function withRepos(o = {}) {
        const h = setup();
        const p = setup();
        const pnpm = [];
        const run = (cmd, args, opts) => {
            if (cmd === 'pnpm') {
                pnpm.push(`${opts.cwd === h.local ? 'harness' : 'other'}:${args.join(' ')}`);
                return Promise.resolve({ code: 0, stdout: '', stderr: '' });
            }
            return defaultRunner(cmd, args, opts);
        };
        const u = new Updater({ cwd: h.local, repos: [{ name: 'pipeline', cwd: p.local }], canApply: true, inFlight: () => 0, restart: () => o.restart ?? 'restarting', run });
        return { h, p, u, pnpm };
    }
    it('다른 저장소에만 새 커밋이 있어도 available, 저장소별로 알려 준다', async () => {
        const { p, u } = withRepos();
        p.push('a.txt', 'p2', 'pipeline fix');
        const s = await u.check();
        expect(s.state).toBe('available');
        expect(s.behind).toBe(0);
        expect(s.repos).toEqual([expect.objectContaining({ name: 'pipeline', behind: 1, commits: [expect.objectContaining({ subject: 'pipeline fix' })] })]);
    });
    it('다른 저장소는 코드만 받고, Harness가 최신이면 재시작하지 않는다', async () => {
        const { p, u, pnpm } = withRepos();
        p.push('a.txt', 'p2', 'pipeline fix');
        const r = await u.apply();
        expect(r.ok).toBe(true);
        expect(git(p.local, 'log', '-1', '--format=%s')).toBe('pipeline fix');
        expect(pnpm).toEqual([]);
        expect(u.status.state).toBe('up_to_date');
        expect(u.status.message).toContain('pipeline는 코드만 받았어요');
        expect(u.status.repos[0].updated).toBeTruthy();
    });
    it('둘 다 새 커밋: 다른 저장소 먼저 받고 Harness는 빌드 뒤 재시작', async () => {
        const { h, p, u, pnpm } = withRepos();
        p.push('a.txt', 'p2', 'pipeline fix');
        h.push('a.txt', 'h2', 'harness fix');
        await u.apply();
        expect(git(p.local, 'log', '-1', '--format=%s')).toBe('pipeline fix');
        expect(git(h.local, 'log', '-1', '--format=%s')).toBe('harness fix');
        expect(pnpm).toEqual(['harness:web:build']);
        expect(u.status.state).toBe('restarting');
        expect(u.status.message).toContain('pipeline');
    });
    it('다른 저장소에 수정이 있으면 아무것도 받지 않는다', async () => {
        const { h, p, u } = withRepos();
        h.push('a.txt', 'h2', 'harness fix');
        writeFileSync(join(p.local, 'a.txt'), 'local edit');
        const r = await u.apply();
        expect(r.ok).toBe(false);
        expect(r.message).toContain('pipeline: 커밋하지 않은 변경');
        expect(git(h.local, 'log', '-1', '--format=%s')).toBe('first');
    });
    it('다른 저장소 확인이 실패해도 Harness 확인은 된다', async () => {
        const { h, p, u } = withRepos();
        git(p.local, 'checkout', '-q', '-b', 'mine');
        h.push('a.txt', 'h2', 'harness fix');
        const s = await u.check();
        expect(s.state).toBe('available');
        expect(s.repos[0].error).toContain('mine');
    });
    it('저장소 찾기: 옆 폴더·한 단계 위·홈, 자신과 상위는 제외, off·직접 지정', () => {
        const repos = new Set(['/home/u/deskpet-pipeline', '/home/u/deskpet-hardware', '/home/u/deskpet-harness', '/home/u']);
        const isRepo = (p) => repos.has(p);
        expect(findSiblingRepos('/home/u/deskpet-harness', undefined, '/home/u', isRepo)).toEqual([
            { name: 'pipeline', cwd: '/home/u/deskpet-pipeline' },
            { name: 'hardware', cwd: '/home/u/deskpet-hardware' },
        ]);
        expect(findSiblingRepos('/home/u/deskpet-harness/app', undefined, '/elsewhere', isRepo).map((r) => r.name)).toEqual(['pipeline', 'hardware']);
        expect(findSiblingRepos('/home/u/deskpet-harness', 'off', '/home/u', isRepo)).toEqual([]);
        expect(findSiblingRepos('/home/u/deskpet-harness', 'hw=../deskpet-hardware, /home/u, /home/u/deskpet-harness', '/home/u', isRepo)).toEqual([{ name: 'hw', cwd: '/home/u/deskpet-hardware' }]);
    });
});
