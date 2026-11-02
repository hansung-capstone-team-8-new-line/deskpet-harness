import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import type { PersistedRow, StoreCategory, StorePersistence } from './persistence.js';

/**
 * SQLite 저널 (Node 내장 `node:sqlite`, 네이티브 빌드 불필요 — Windows·Jetson 공통).
 * - WAL + synchronous=FULL: commit이 끝나면 전원이 꺼져도 남는다.
 * - 한 파일은 한 Harness 프로세스만 쓴다 (단일 기록자, 감사 F-04). `<path>.lock` 파일로 강제한다.
 *   같은 컴퓨터에서 잠금을 잡은 프로세스가 이미 끝났으면(비정상 종료) 잠금을 넘겨받는다. 읽기 전용 조회(pnpm db)는 잠그지 않는다.
 * - Node 22.13 이상 필요 (그 이전은 --experimental-sqlite 플래그 필요).
 */
const SCHEMA_VERSION = 1;

interface Stmt {
  run(...a: unknown[]): unknown;
  all(...a: unknown[]): unknown[];
  get(...a: unknown[]): unknown;
}
interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}

export class StoreLockedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holder: string,
  ) {
    super(`store is already in use by another process (${holder}). lock file: ${lockPath}`);
    this.name = 'StoreLockedError';
  }
}

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

/** 단일 기록자 잠금. 성공하면 해제 함수를 돌려준다 */
export function acquireStoreLock(dbPath: string): () => void {
  const lockPath = `${dbPath}.lock`;
  const me: LockInfo = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, JSON.stringify(me));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const cur = JSON.parse(readFileSync(lockPath, 'utf8')) as LockInfo;
          if (cur.pid === me.pid && cur.host === me.host && cur.startedAt === me.startedAt) unlinkSync(lockPath);
        } catch {
          /* 이미 없음 */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let cur: LockInfo | undefined;
      try {
        cur = JSON.parse(readFileSync(lockPath, 'utf8')) as LockInfo;
      } catch {
        cur = undefined;
      }
      // 같은 컴퓨터에서 이미 끝난 프로세스의 잠금만 넘겨받는다. 다른 컴퓨터·확인 불가 잠금은 사람이 지워야 한다
      if (cur && cur.host === me.host && cur.pid !== me.pid && !processAlive(cur.pid)) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* 다른 프로세스가 먼저 지움 */
        }
        continue;
      }
      throw new StoreLockedError(lockPath, cur ? `pid ${cur.pid} on ${cur.host} since ${cur.startedAt}` : 'unreadable lock file');
    }
  }
  throw new StoreLockedError(lockPath, 'lock contention');
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class SqlitePersistence implements StorePersistence {
  private readonly db: Db;
  private readonly releaseLock: () => void;
  private readonly upsert: Stmt;
  private readonly del: Stmt;

  constructor(readonly path: string) {
    const mod = process.getBuiltinModule?.('node:sqlite') as { DatabaseSync: new (p: string) => Db } | undefined;
    if (!mod) throw new Error('node:sqlite is not available. Use Node.js 22.13 or later.');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.releaseLock = path === ':memory:' ? () => undefined : acquireStoreLock(path);
    try {
      this.db = new mod.DatabaseSync(path);
    } catch (e) {
      this.releaseLock();
      throw e;
    }
    try {
      // 지운 레코드의 공간을 파일에서 돌려받는다 (임베디드 저장 공간). 기존 파일이 꺼져 있으면 한 번 변환한다
      const av = (this.db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum;
      if (av !== 2) this.db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;');
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 2000;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS records (cat TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (cat, key)) WITHOUT ROWID;
                    CREATE TABLE IF NOT EXISTS schema_info (version INTEGER NOT NULL);`);
      const v = this.db.prepare('SELECT version FROM schema_info').get() as { version: number } | undefined;
      if (!v) this.db.prepare('INSERT INTO schema_info (version) VALUES (?)').run(SCHEMA_VERSION);
      else if (v.version !== SCHEMA_VERSION) throw new Error(`store schema version ${v.version} is not supported (expected ${SCHEMA_VERSION})`);
      this.upsert = this.db.prepare('INSERT INTO records (cat, key, json) VALUES (?, ?, ?) ON CONFLICT (cat, key) DO UPDATE SET json = excluded.json');
      this.del = this.db.prepare('DELETE FROM records WHERE cat = ? AND key = ?');
    } catch (e) {
      this.db.close();
      this.releaseLock();
      throw e;
    }
  }

  loadAll(): PersistedRow[] {
    return this.db.prepare('SELECT cat, key, json FROM records').all() as PersistedRow[];
  }

  commit(upserts: PersistedRow[], deletes: { cat: StoreCategory; key: string }[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of upserts) this.upsert.run(r.cat, r.key, r.json);
      for (const d of deletes) this.del.run(d.cat, d.key);
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 이미 롤백됨 */
      }
      throw e;
    }
    if (deletes.length) {
      try {
        this.db.exec('PRAGMA incremental_vacuum');
      } catch {
        /* 공간 회수 실패는 기록 성공과 무관 */
      }
    }
  }

  /** 진단용: 파일 크기 관련 정보 */
  stats(): { pages: number; freePages: number; pageSize: number; rows: number } {
    const g = (sql: string) => Object.values(this.db.prepare(sql).get() as Record<string, number>)[0]!;
    return { pages: g('PRAGMA page_count'), freePages: g('PRAGMA freelist_count'), pageSize: g('PRAGMA page_size'), rows: g('SELECT COUNT(*) FROM records') };
  }

  close(): void {
    try {
      this.db.close();
    } finally {
      this.releaseLock();
    }
  }
}
