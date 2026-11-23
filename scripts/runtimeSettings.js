import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export function loadRuntimeSettings(path, fallback) {
    if (!path || !existsSync(path))
        return { settings: fallback, source: 'env' };
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        const repos = Array.isArray(raw.allowedRepositories) ? raw.allowedRepositories.filter((x) => typeof x === 'string') : fallback.allowedRepositories;
        return { settings: { allowedRepositories: repos, ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}) }, source: 'file' };
    }
    catch (e) {
        return { settings: fallback, source: 'env', error: `설정 파일을 읽지 못했어요 (${e instanceof Error ? e.message : String(e)}) — .env 값으로 시작해요` };
    }
}
/** 쓰다 꺼져도 깨지지 않게 임시 파일에 쓰고 바꾼다 */
export function saveRuntimeSettings(path, s) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
    renameSync(tmp, path);
}
