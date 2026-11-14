import { execFile as execFileCb, spawn } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorktreeHandle, WorktreeIsolatorPort, WorktreeMergeResult } from '@deskpet/contracts';

const execFileAsync = promisify(execFileCb);

export interface GitWorktreeManagerOptions {
  /** 워크트리 격리를 적용할 저장소 경로 */
  workspaceRoot: string;
  /** 임시 워크트리 상위 디렉토리 (기본값: os.tmpdir()/deskpet-worktrees) */
  worktreeBaseDir?: string;
}

/**
 * Agent Swarm Worker별 `git worktree` 격리 및 병합 관리자.
 *
 * 동작:
 * 1. `createWorkerWorktree`: detached HEAD 기반 임시 worktree를 생성하고, 현재 workspaceRoot의
 *    미커밋 변경분(dirty working tree + untracked)을 해당 worktree에 스냅샷 커밋으로 복제한다.
 *    따라서 Worker의 `git status`/`git diff`는 오직 자신이 수정한 delta만 보게 된다.
 * 2. `mergeAndCleanup`: Worker 완료 시 baseCommitSha 대비 delta 패치만 추출해
 *    직렬화된 merge lock 아래 `workspaceRoot`에 `git apply --3way`로 반영하고 worktree를 정리한다.
 */
export class GitWorktreeManager implements WorktreeIsolatorPort {
  private readonly workspaceRoot: string;
  private readonly worktreeBaseDir: string;
  private mergeQueue: Promise<void> = Promise.resolve();

  constructor(opts: GitWorktreeManagerOptions) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.worktreeBaseDir = opts.worktreeBaseDir ?? path.join(tmpdir(), 'deskpet-worktrees');
  }

  async createWorkerWorktree(requestId: string, workerId: string): Promise<WorktreeHandle | null> {
    const top = await gitOutput(['rev-parse', '--show-toplevel'], this.workspaceRoot);
    if (!top.ok) return null;
    const repoRoot = top.stdout.trim();
    if (!repoRoot) return null;

    const headRes = await gitOutput(['rev-parse', '--verify', 'HEAD'], repoRoot);
    if (!headRes.ok) {
      // Initial empty repo without HEAD cannot create detached worktree yet
      return null;
    }

    await mkdir(this.worktreeBaseDir, { recursive: true });
    const safeId = sanitizeSegment(`${requestId}-${workerId}-${Date.now().toString(36)}`);
    const worktreePath = path.join(this.worktreeBaseDir, safeId);

    const addRes = await gitOutput(['worktree', 'add', '--detach', worktreePath, 'HEAD'], repoRoot);
    if (!addRes.ok) return null;

    try {
      await this.syncDirtyWorkingTree(repoRoot, worktreePath);

      const baseShaRes = await gitOutput(['rev-parse', 'HEAD'], worktreePath);
      const baseCommitSha = baseShaRes.ok ? baseShaRes.stdout.trim() : headRes.stdout.trim();

      return {
        id: safeId,
        requestId,
        workerId,
        repoRoot,
        worktreePath,
        baseCommitSha,
      };
    } catch {
      await this.forceRemoveWorktree(repoRoot, worktreePath);
      return null;
    }
  }

  async mergeAndCleanup(handle: WorktreeHandle): Promise<WorktreeMergeResult> {
    return this.withMergeLock(async () => {
      try {
        const add = await gitOutput(['add', '-A'], handle.worktreePath);
        if (!add.ok) {
          return {
            merged: false,
            changedFiles: [],
            conflicts: [],
            error: add.stderr || add.error || 'failed to stage worktree changes',
          };
        }

        const namesRes = await gitOutput(['diff', '--cached', '--name-only', handle.baseCommitSha], handle.worktreePath);
        const changedFiles = namesRes.ok ? namesRes.stdout.split(/\r?\n/).filter(Boolean) : [];
        if (changedFiles.length === 0) {
          return { merged: true, changedFiles: [], conflicts: [] };
        }

        const patchRes = await gitBuffer(['diff', '--cached', '--binary', handle.baseCommitSha], handle.worktreePath);
        if (!patchRes.ok || !patchRes.stdout.length) {
          return {
            merged: false,
            changedFiles,
            conflicts: [],
            error: patchRes.stderr || patchRes.error || 'failed to generate patch from worktree',
          };
        }

        const applyRes = await applyPatchBuffer(handle.repoRoot, patchRes.stdout);
        if (!applyRes.ok) {
          const conflicts = extractConflictPaths(applyRes.stderr, changedFiles);
          return {
            merged: false,
            changedFiles,
            conflicts,
            error: applyRes.stderr.trim() || applyRes.error || 'patch apply conflict',
          };
        }

        return { merged: true, changedFiles, conflicts: [] };
      } finally {
        await this.forceRemoveWorktree(handle.repoRoot, handle.worktreePath);
      }
    });
  }

  async cleanupWorktree(handle: WorktreeHandle): Promise<void> {
    await this.forceRemoveWorktree(handle.repoRoot, handle.worktreePath);
  }

  private async syncDirtyWorkingTree(repoRoot: string, worktreePath: string): Promise<void> {
    const trackedPatch = await gitBuffer(['diff', '--binary', 'HEAD'], repoRoot);
    if (trackedPatch.ok && trackedPatch.stdout.length > 0) {
      await applyPatchBuffer(worktreePath, trackedPatch.stdout);
    }

    const untracked = await gitOutput(['ls-files', '--others', '--exclude-standard'], repoRoot);
    if (untracked.ok) {
      const files = untracked.stdout.split(/\r?\n/).filter(Boolean);
      for (const rel of files) {
        const src = path.join(repoRoot, rel);
        const dst = path.join(worktreePath, rel);
        await mkdir(path.dirname(dst), { recursive: true });
        await copyFile(src, dst).catch(() => undefined);
      }
    }

    const status = await gitOutput(['status', '--porcelain=v1'], worktreePath);
    if (status.ok && status.stdout.trim()) {
      await gitOutput(['add', '-A'], worktreePath);
      await gitOutput(
        ['-c', 'user.name=DeskPet', '-c', 'user.email=deskpet@local', 'commit', '--no-verify', '-m', 'deskpet-worktree-base'],
        worktreePath,
      );
    }
  }

  private async forceRemoveWorktree(repoRoot: string, worktreePath: string): Promise<void> {
    await gitOutput(['worktree', 'remove', '--force', worktreePath], repoRoot);
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    await gitOutput(['worktree', 'prune'], repoRoot);
  }

  private async withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mergeQueue;
    let release!: () => void;
    this.mergeQueue = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

async function gitOutput(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '', error: err.message };
  }
}

async function gitBuffer(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: Buffer; stderr: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: stderr.toString('utf8') };
  } catch (e) {
    const err = e as Error & { stderr?: Buffer | string };
    return {
      ok: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : (err.stderr ?? ''),
      error: err.message,
    };
  }
}

function applyPatchBuffer(
  cwd: string,
  patch: Buffer,
): Promise<{ ok: boolean; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', ['apply', '--3way', '--whitespace=nowarn'], {
      cwd,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.once('error', (err) => {
      resolve({ ok: false, stderr, error: err.message });
    });
    child.once('close', (code) => {
      resolve({ ok: code === 0, stderr, ...(code === 0 ? {} : { error: `git apply exited with ${String(code)}` }) });
    });
    child.stdin.write(patch);
    child.stdin.end();
  });
}

function extractConflictPaths(stderr: string, fallbackFiles: string[]): string[] {
  const hits: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = /error: (?:patch failed: )?([^:\s]+)/.exec(line);
    if (m?.[1]) hits.push(m[1]);
  }
  return hits.length > 0 ? [...new Set(hits)] : fallbackFiles;
}

function sanitizeSegment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}
