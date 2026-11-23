import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
};
export const WEB_SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};
export function createStaticHandler(o) {
    const root = resolve(o.root);
    let realRoot;
    const getRealRoot = () => (realRoot ??= realpath(root).catch(() => root));
    return async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return plain(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
        }
        let pathname;
        try {
            pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname);
        }
        catch {
            return plain(res, 400, 'bad request');
        }
        if (pathname.includes('\0'))
            return plain(res, 400, 'bad request');
        const base = await getRealRoot();
        const wantsFile = extname(pathname) !== '';
        const target = pathname === '/' || !wantsFile ? 'index.html' : pathname.replace(/^\/+/, '');
        const file = await safeFile(base, target);
        if (!file) {
            if (wantsFile)
                return plain(res, 404, 'not found');
            return plain(res, 503, '웹 화면 빌드가 없어요. app 폴더에서 pnpm web:build 를 실행하세요.');
        }
        const name = file.path.slice(base.length);
        const immutable = /[\\/]assets[\\/]/.test(name);
        res.writeHead(200, {
            ...WEB_SECURITY_HEADERS,
            'Content-Type': MIME[extname(file.path).toLowerCase()] ?? 'application/octet-stream',
            'Content-Length': String(file.size),
            'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        });
        if (req.method === 'HEAD')
            return void res.end();
        await new Promise((done) => {
            const s = createReadStream(file.path);
            s.on('error', () => {
                res.destroy();
                done();
            });
            s.on('end', () => done());
            s.pipe(res);
        });
    };
}
/** root 안의 일반 파일만 돌려준다. 심볼릭 링크를 따라간 실제 경로도 root 안이어야 한다 */
async function safeFile(base, rel) {
    const candidate = resolve(base, rel);
    if (!inside(base, candidate))
        return undefined;
    try {
        const real = await realpath(candidate);
        if (!inside(base, real))
            return undefined;
        const st = await stat(real);
        if (!st.isFile())
            return undefined;
        return { path: real, size: st.size };
    }
    catch {
        return undefined;
    }
}
function inside(base, p) {
    const r = relative(base, p);
    return r !== '' && !r.startsWith('..') && !isAbsolute(r) && !r.split(sep).includes('..');
}
function plain(res, status, body, extra = {}) {
    res.writeHead(status, { ...WEB_SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(body);
}
/**
 * 같은 출처 판정 (D-42): 웹 화면을 이 서버가 내보낼 때, 그 화면의 Origin은 따로 허용 목록에 넣지 않아도 된다.
 * Origin이 `<scheme>://<Host 헤더>`와 같고 Host가 IP 주소 또는 localhost일 때만 같은 출처로 본다.
 * (도메인 이름은 DNS rebinding으로 Host·Origin을 함께 맞출 수 있어 제외 — 도메인으로 열 때는 HARNESS_WS_ALLOWED_ORIGINS에 넣는다)
 */
export function isSameOriginLiteral(origin, hostHeader, secure) {
    if (!hostHeader)
        return false;
    let o;
    let h;
    try {
        o = new URL(origin);
        h = new URL(`${secure ? 'https' : 'http'}://${hostHeader}`);
    }
    catch {
        return false;
    }
    if (o.protocol !== h.protocol || o.host !== h.host)
        return false;
    const name = h.hostname.replace(/^\[|\]$/g, '');
    return name === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':');
}
