import { execFile as execFileCb, spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CallConstraints, WorkspaceGatewayPort } from '@deskpet/contracts';

const execFileAsync = promisify(execFileCb);

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage']);
const DEFAULT_MAX_LINES = 200;
const HARD_MAX_LINES = 400;
const DEFAULT_MAX_OUTPUT_CHARS = 8_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export interface LocalWorkspaceGatewayOptions {
  /** 기본 작업 워크스페이스 루트 경로 */
  rootDir: string;
  /** runCommand 기본 제한 시간(ms) */
  defaultCommandTimeoutMs?: number;
}

/**
 * 헤드리스 바이브 코딩용 로컬 워크스페이스 게이트웨이.
 *
 * - assign 된 workingDir(기본 rootDir 또는 Worker의 git worktree 경로) 내부로 파일 접근을 제한한다.
 * - 라인 범위 기반 읽기(`readFile`), 정규식/키워드 코드 검색(`searchCode`), 부분 치환(`editFile`),
 *   셸 실행(`runCommand`), Git 상태/Diff 확인을 제공한다.
 */
export class LocalWorkspaceGateway implements WorkspaceGatewayPort {
  readonly defaultRoot: string;
  private readonly defaultCommandTimeoutMs: number;

  constructor(opts: LocalWorkspaceGatewayOptions) {
    this.defaultRoot = path.resolve(opts.rootDir);
    this.defaultCommandTimeoutMs = opts.defaultCommandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  async findFiles(
    query: { pattern?: string; subdir?: string; maxResults?: number; workingDir?: string },
    c?: CallConstraints,
  ): Promise<{ ok: boolean; files: string[]; truncated: boolean; error?: string }> {
    try {
      const root = this.resolveRoot(query.workingDir);
      const startDir = query.subdir ? this.resolveSafeExistingDir(root, query.subdir) : root;
      const maxResults = Math.min(Math.max(query.maxResults ?? 200, 1), 1000);
      const matcher = query.pattern ? globToRegExp(query.pattern) : undefined;
      const results: string[] = [];
      let truncated = false;

      const walk = async (dir: string): Promise<void> => {
        if (truncated || c?.signal?.aborted) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (truncated || c?.signal?.aborted) break;
          if (IGNORED_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          const rel = path.relative(root, full).split(path.sep).join('/');
          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.isFile()) {
            if (!matcher || matcher.test(rel) || matcher.test(entry.name)) {
              if (results.length >= maxResults) {
                truncated = true;
                break;
              }
              results.push(rel);
            }
          }
        }
      };

      await walk(startDir);
      results.sort();
      return { ok: true, files: results, truncated };
    } catch (e) {
      return { ok: false, files: [], truncated: false, error: errMessage(e) };
    }
  }

  async searchCode(
    query: {
      query: string;
      subdir?: string;
      regex?: boolean;
      glob?: string;
      maxMatches?: number;
      workingDir?: string;
    },
    c?: CallConstraints,
  ): Promise<{ ok: boolean; matches: string[]; truncated: boolean; error?: string }> {
    if (!query.query) return { ok: false, matches: [], truncated: false, error: 'query is required' };
    try {
      const root = this.resolveRoot(query.workingDir);
      const startDir = query.subdir ? this.resolveSafeExistingDir(root, query.subdir) : root;
      const maxMatches = Math.min(Math.max(query.maxMatches ?? 80, 1), 300);

      // Prefer ripgrep when available for speed; fall back to Node scanner transparently.
      const rgMatches = await this.tryRipgrep(root, startDir, query, maxMatches, c);
      if (rgMatches !== null) return rgMatches;

      const matcher = query.regex
        ? new RegExp(query.query)
        : new RegExp(escapeRegExp(query.query));
      const globRe = query.glob ? globToRegExp(query.glob) : undefined;
      const found: string[] = [];
      let truncated = false;

      const scan = async (dir: string): Promise<void> => {
        if (truncated || c?.signal?.aborted) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (truncated || c?.signal?.aborted) break;
          if (IGNORED_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          const rel = path.relative(root, full).split(path.sep).join('/');
          if (entry.isDirectory()) {
            await scan(full);
          } else if (entry.isFile()) {
            if (globRe && !globRe.test(rel) && !globRe.test(entry.name)) continue;
            const raw = await fsReadFile(full, 'utf8').catch(() => null);
            if (raw === null || raw.includes('\u0000')) continue;
            const lines = raw.split(/\r?\n/);
            for (let idx = 0; idx < lines.length; idx++) {
              if (matcher.test(lines[idx]!)) {
                found.push(`${rel}:${idx + 1}: ${lines[idx]!.slice(0, 240)}`);
                if (found.length >= maxMatches) {
                  truncated = true;
                  break;
                }
              }
            }
          }
        }
      };

      await scan(startDir);
      return { ok: true, matches: found, truncated };
    } catch (e) {
      return { ok: false, matches: [], truncated: false, error: errMessage(e) };
    }
  }

  async readFile(
    query: { path: string; startLine?: number; endLine?: number; workingDir?: string },
    _c?: CallConstraints,
  ): Promise<{
    ok: boolean;
    path: string;
    content: string;
    startLine: number;
    endLine: number;
    totalLines: number;
    truncated: boolean;
    error?: string;
  }> {
    try {
      const root = this.resolveRoot(query.workingDir);
      const { full, rel } = this.resolveSafeFile(root, query.path, { mustExist: true });
      const raw = await fsReadFile(full, 'utf8');
      const lines = raw.split(/\r?\n/);
      const totalLines = lines.length;
      const start = Math.max(1, Math.min(query.startLine ?? 1, Math.max(1, totalLines)));
      const requestedEnd = query.endLine ?? start + DEFAULT_MAX_LINES - 1;
      const cappedEnd = Math.min(totalLines, start + HARD_MAX_LINES - 1, Math.max(start, requestedEnd));
      const slice = lines.slice(start - 1, cappedEnd);
      const numbered = slice.map((l, idx) => `${start + idx}: ${l}`).join('\n');
      return {
        ok: true,
        path: rel,
        content: numbered,
        startLine: start,
        endLine: cappedEnd,
        totalLines,
        truncated: cappedEnd < totalLines,
      };
    } catch (e) {
      return {
        ok: false,
        path: query.path,
        content: '',
        startLine: 0,
        endLine: 0,
        totalLines: 0,
        truncated: false,
        error: errMessage(e),
      };
    }
  }

  async editFile(
    cmd: { path: string; target: string; replacement: string; replaceAll?: boolean; workingDir?: string },
    _c?: CallConstraints,
  ): Promise<{ ok: boolean; path: string; replacements: number; snippet?: string; error?: string }> {
    if (!cmd.target) {
      return { ok: false, path: cmd.path, replacements: 0, error: 'target string must be non-empty' };
    }
    try {
      const root = this.resolveRoot(cmd.workingDir);
      const { full, rel } = this.resolveSafeFile(root, cmd.path, { mustExist: true });
      const raw = await fsReadFile(full, 'utf8');
      const count = countOccurrences(raw, cmd.target);
      if (count === 0) {
        return {
          ok: false,
          path: rel,
          replacements: 0,
          error: 'target string not found in file; read_file around the lines before retrying',
        };
      }
      if (count > 1 && !cmd.replaceAll) {
        return {
          ok: false,
          path: rel,
          replacements: 0,
          error: `found ${count} occurrences of target; provide more surrounding context or set replaceAll=true`,
        };
      }
      const next = cmd.replaceAll ? raw.split(cmd.target).join(cmd.replacement) : raw.replace(cmd.target, cmd.replacement);
      await fsWriteFile(full, next, 'utf8');

      const firstIdx = next.indexOf(cmd.replacement);
      const startLine = firstIdx >= 0 ? next.slice(0, firstIdx).split(/\r?\n/).length : 1;
      const lines = next.split(/\r?\n/);
      const from = Math.max(0, startLine - 3);
      const to = Math.min(lines.length, startLine + cmd.replacement.split(/\r?\n/).length + 2);
      const snippet = lines
        .slice(from, to)
        .map((l, idx) => `${from + idx + 1}: ${l}`)
        .join('\n');
      return { ok: true, path: rel, replacements: cmd.replaceAll ? count : 1, snippet };
    } catch (e) {
      return { ok: false, path: cmd.path, replacements: 0, error: errMessage(e) };
    }
  }

  async writeFile(
    cmd: { path: string; content: string; overwrite?: boolean; workingDir?: string },
    _c?: CallConstraints,
  ): Promise<{ ok: boolean; path: string; bytesWritten: number; error?: string }> {
    try {
      const root = this.resolveRoot(cmd.workingDir);
      const { full, rel } = this.resolveSafeFile(root, cmd.path, { mustExist: false });
      if (existsSync(full) && cmd.overwrite === false) {
        return {
          ok: false,
          path: rel,
          bytesWritten: 0,
          error: 'file already exists and overwrite=false',
        };
      }
      await mkdir(path.dirname(full), { recursive: true });
      await fsWriteFile(full, cmd.content, 'utf8');
      return { ok: true, path: rel, bytesWritten: Buffer.byteLength(cmd.content, 'utf8') };
    } catch (e) {
      return { ok: false, path: cmd.path, bytesWritten: 0, error: errMessage(e) };
    }
  }

  async gitStatus(
    query?: { workingDir?: string },
    c?: CallConstraints,
  ): Promise<{ ok: boolean; isGitRepo: boolean; summary: string; changedFiles: string[]; error?: string }> {
    try {
      const root = this.resolveRoot(query?.workingDir);
      const inside = await execGit(['rev-parse', '--is-inside-work-tree'], root, c?.signal);
      if (!inside.ok) return { ok: true, isGitRepo: false, summary: 'not a git repository', changedFiles: [] };
      const st = await execGit(['status', '--porcelain=v1'], root, c?.signal);
      if (!st.ok) return { ok: false, isGitRepo: true, summary: '', changedFiles: [], error: st.stderr || st.error };
      const lines = st.stdout.split(/\r?\n/).filter(Boolean);
      const changedFiles = lines.map((l) => l.slice(3).trim()).filter(Boolean);
      return {
        ok: true,
        isGitRepo: true,
        summary: lines.length ? lines.join('\n') : 'working tree clean',
        changedFiles,
      };
    } catch (e) {
      return { ok: false, isGitRepo: false, summary: '', changedFiles: [], error: errMessage(e) };
    }
  }

  async gitDiff(
    query?: { staged?: boolean; path?: string; workingDir?: string },
    c?: CallConstraints,
  ): Promise<{ ok: boolean; diff: string; truncated: boolean; error?: string }> {
    try {
      const root = this.resolveRoot(query?.workingDir);
      const args = ['diff'];
      if (query?.staged) args.push('--cached');
      if (query?.path) {
        const { rel } = this.resolveSafeFile(root, query.path, { mustExist: false });
        args.push('--', rel);
      }
      const res = await execGit(args, root, c?.signal);
      if (!res.ok) return { ok: false, diff: '', truncated: false, error: res.stderr || res.error };
      const truncated = res.stdout.length > DEFAULT_MAX_OUTPUT_CHARS;
      return {
        ok: true,
        diff: truncated ? `${res.stdout.slice(0, DEFAULT_MAX_OUTPUT_CHARS)}\n...[diff truncated]` : res.stdout,
        truncated,
      };
    } catch (e) {
      return { ok: false, diff: '', truncated: false, error: errMessage(e) };
    }
  }

  async runCommand(
    cmd: { command: string; timeoutMs?: number; workingDir?: string },
    c?: CallConstraints,
  ): Promise<{
    ok: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    error?: string;
  }> {
    if (!cmd.command.trim()) {
      return { ok: false, exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, error: 'command is empty' };
    }
    try {
      const root = this.resolveRoot(cmd.workingDir);
      const deadlineRemaining = c?.deadlineAt ? Math.max(500, Date.parse(c.deadlineAt) - Date.now()) : undefined;
      const timeoutMs = Math.min(
        cmd.timeoutMs ?? this.defaultCommandTimeoutMs,
        deadlineRemaining ?? this.defaultCommandTimeoutMs,
      );

      return await new Promise((resolve) => {
        const child = spawn('/bin/sh', ['-c', cmd.command], {
          cwd: root,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let timedOut = false;

        const append = (cur: string, chunk: Buffer): string => {
          const next = cur + chunk.toString('utf8');
          if (next.length > DEFAULT_MAX_OUTPUT_CHARS) {
            truncated = true;
            return next.slice(-DEFAULT_MAX_OUTPUT_CHARS);
          }
          return next;
        };

        child.stdout.on('data', (d: Buffer) => {
          stdout = append(stdout, d);
        });
        child.stderr.on('data', (d: Buffer) => {
          stderr = append(stderr, d);
        });

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 1500).unref();
        }, timeoutMs);

        const onAbort = () => {
          child.kill('SIGTERM');
        };
        c?.signal?.addEventListener('abort', onAbort, { once: true });

        child.once('error', (err) => {
          clearTimeout(timer);
          c?.signal?.removeEventListener('abort', onAbort);
          resolve({ ok: false, exitCode: null, stdout, stderr, timedOut, truncated, error: err.message });
        });

        child.once('close', (code) => {
          clearTimeout(timer);
          c?.signal?.removeEventListener('abort', onAbort);
          resolve({
            ok: !timedOut && code === 0,
            exitCode: code,
            stdout,
            stderr,
            timedOut,
            truncated,
            ...(timedOut ? { error: `command timed out after ${timeoutMs}ms` } : {}),
          });
        });
      });
    } catch (e) {
      return { ok: false, exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, error: errMessage(e) };
    }
  }

  private resolveRoot(overrideDir?: string): string {
    if (!overrideDir) {
      if (!existsSync(this.defaultRoot)) mkdirSync(this.defaultRoot, { recursive: true });
      return realpathSync(this.defaultRoot);
    }
    const candidate = path.resolve(overrideDir);
    return realpathSync(candidate);
  }

  private resolveSafeExistingDir(root: string, targetPath: string): string {
    const { full } = this.resolveSafeFile(root, targetPath, { mustExist: true });
    if (!statSync(full).isDirectory()) throw new Error(`not a directory: ${targetPath}`);
    return full;
  }

  private resolveSafeFile(
    root: string,
    targetPath: string,
    opts: { mustExist: boolean },
  ): { full: string; rel: string } {
    const candidate = path.resolve(root, targetPath);
    if (!isInsideRoot(root, candidate)) {
      throw new Error(`path escapes workspace root: ${targetPath}`);
    }
    if (opts.mustExist) {
      if (!existsSync(candidate)) throw new Error(`path not found: ${targetPath}`);
      const real = realpathSync(candidate);
      if (!isInsideRoot(root, real)) throw new Error(`symlink escapes workspace root: ${targetPath}`);
      return { full: real, rel: path.relative(root, real).split(path.sep).join('/') };
    }
    const existingAncestor = findExistingAncestor(path.dirname(candidate), root);
    const realAncestor = realpathSync(existingAncestor);
    if (!isInsideRoot(root, realAncestor)) {
      throw new Error(`target parent escapes workspace root: ${targetPath}`);
    }
    return { full: candidate, rel: path.relative(root, candidate).split(path.sep).join('/') };
  }

  private async tryRipgrep(
    root: string,
    startDir: string,
    query: { query: string; regex?: boolean; glob?: string },
    maxMatches: number,
    c?: CallConstraints,
  ): Promise<{ ok: boolean; matches: string[]; truncated: boolean } | null> {
    const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', String(maxMatches)];
    if (!query.regex) args.push('--fixed-strings');
    if (query.glob) args.push('--glob', query.glob);
    for (const ig of IGNORED_DIRS) args.push('--glob', `!**/${ig}/**`);
    args.push('--', query.query, startDir);

    try {
      const { stdout } = await execFileAsync('rg', args, {
        cwd: root,
        maxBuffer: 1024 * 1024,
        ...(c?.signal ? { signal: c.signal } : {}),
      });
      const lines = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const normalized = path.isAbsolute(line) || line.startsWith(root)
            ? line.replace(`${root}${path.sep}`, '')
            : line;
          return normalized.slice(0, 260);
        });
      const truncated = lines.length >= maxMatches;
      return { ok: true, matches: lines.slice(0, maxMatches), truncated };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException & { status?: number }).code ?? (e as { status?: number }).status;
      // rg exit code 1 means "no matches", which is a valid result.
      if (code === 1) return { ok: true, matches: [], truncated: false };
      return null;
    }
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function findExistingAncestor(dir: string, fallbackRoot: string): string {
  let cur = dir;
  while (cur && cur !== path.dirname(cur)) {
    if (existsSync(cur)) return cur;
    cur = path.dirname(cur);
  }
  return fallbackRoot;
}

async function execGit(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 2 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '', error: err.message };
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`(^|/)${escaped}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
