import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { APP_ROOT, resolveWikiDir } from '../../scripts/wikiPath.js';

/** D-43: Wiki 경로는 app 폴더 기준, 기본 ../knowledge */
const tmp = mkdtempSync(join(tmpdir(), 'deskpet-vault-'));
mkdirSync(join(tmp, 'wiki'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('LLM Wiki 경로 (D-43)', () => {
  it('app 폴더는 실행 위치와 상관없이 저장소 루트', () => {
    expect(resolve(APP_ROOT, 'package.json')).toBe(resolve(__dirname, '../../package.json'));
  });
  it('비우면 ../knowledge를 app 폴더 기준으로 보고, wiki/가 없으면 끈다', () => {
    const r = resolveWikiDir(undefined);
    const expected = resolve(APP_ROOT, '../knowledge');
    if (r.enabled) expect(r.dir).toBe(expected);
    else expect(r.reason).toContain(expected);
  });
  it('상대경로는 app 폴더 기준, 절대경로는 그대로', () => {
    const rel = relative(APP_ROOT, tmp);
    expect(resolveWikiDir(rel)).toEqual({ enabled: true, dir: tmp, raw: rel, source: 'env' });
    const abs = resolveWikiDir(tmp);
    expect(abs).toEqual({ enabled: true, dir: tmp, raw: tmp, source: 'env' });
    const fromApp = resolveWikiDir('./scripts');
    expect(fromApp.enabled).toBe(false);
    if (!fromApp.enabled) expect(fromApp.reason).toContain(resolve(APP_ROOT, 'scripts'));
  });
  it('off면 끈다', () => {
    expect(resolveWikiDir(' OFF ')).toEqual({ enabled: false, reason: 'DESKPET_WIKI_DIR=off' });
  });
});
