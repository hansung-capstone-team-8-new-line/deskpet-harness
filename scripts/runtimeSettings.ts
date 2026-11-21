import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 웹 설정에서 바꾸는 서버 설정 (D-52, 2026-11-14 사용자 결정). 접속한 화면 누구나 바꾼다.
 * 파일(기본: 저장소 옆 settings.json)에 두고, 파일이 없으면 .env 값을 처음 값으로 쓴다.
 * 항목: 승인 허용 저장소 (D-36, 비어 있으면 제한 없음), Guide 사용자 규칙 (D-61, mcpId → 규칙 문장, '*'는 공통)
 */
export interface RuntimeSettings {
  allowedRepositories: string[];
  guideRules?: Record<string, string[]>;
  updatedAt?: string;
}

/** Guide 규칙 정리: 문자열만, 앞뒤 공백 제거, 빈 줄·빈 Guide 제거 */
export function cleanGuideRules(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    const rules = v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    if (rules.length) out[k] = rules;
  }
  return out;
}

export function loadRuntimeSettings(path: string | undefined, fallback: RuntimeSettings): { settings: RuntimeSettings; source: 'file' | 'env'; error?: string } {
  if (!path || !existsSync(path)) return { settings: fallback, source: 'env' };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeSettings>;
    const repos = Array.isArray(raw.allowedRepositories) ? raw.allowedRepositories.filter((x): x is string => typeof x === 'string') : fallback.allowedRepositories;
    const guideRules = cleanGuideRules(raw.guideRules);
    return { settings: { allowedRepositories: repos, ...(Object.keys(guideRules).length ? { guideRules } : {}), ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}) }, source: 'file' };
  } catch (e) {
    return { settings: fallback, source: 'env', error: `설정 파일을 읽지 못했어요 (${e instanceof Error ? e.message : String(e)}) — .env 값으로 시작해요` };
  }
}

/** 쓰다 꺼져도 깨지지 않게 임시 파일에 쓰고 바꾼다 */
export function saveRuntimeSettings(path: string, s: RuntimeSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  renameSync(tmp, path);
}
