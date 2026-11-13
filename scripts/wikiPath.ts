import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** app 폴더 (이 저장소의 루트). 실행 위치와 상관없이 같은 값 */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 기본 vault 위치: 저장소들을 한 폴더에 나란히 받았을 때의 knowledge (D-43) */
export const DEFAULT_WIKI_DIR = '../knowledge';

export type WikiDir =
  | { enabled: true; dir: string; raw: string; source: 'env' | 'default' }
  | { enabled: false; reason: string };

/**
 * LLM Wiki vault 경로 (D-43). DESKPET_WIKI_DIR 상대경로는 실행 위치가 아니라 app 폴더 기준으로 해석한다.
 * - 비우면 ../knowledge (app 폴더 옆의 knowledge 저장소). 그 폴더에 wiki/가 없으면 Wiki를 끈다
 * - off면 끈다
 * - 절대경로는 그대로
 */
export function resolveWikiDir(value: string | undefined): WikiDir {
  const v = value?.trim();
  if (v && v.toLowerCase() === 'off') return { enabled: false, reason: 'DESKPET_WIKI_DIR=off' };
  const raw = v || DEFAULT_WIKI_DIR;
  const dir = isAbsolute(raw) ? raw : resolve(APP_ROOT, raw);
  if (!existsSync(resolve(dir, 'wiki'))) {
    return { enabled: false, reason: `${raw} 에 wiki/ 폴더가 없음 (${v ? 'DESKPET_WIKI_DIR' : '기본값'}, app 폴더 기준 ${dir})` };
  }
  return { enabled: true, dir, raw, source: v ? 'env' : 'default' };
}
