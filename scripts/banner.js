/** 터미널 표시 너비 (한글·전각 2칸) */
export function displayWidth(s) {
    let w = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0);
        w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ? 2 : 1;
    }
    return w;
}
export function padEnd(s, width) {
    return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}
export function renderBanner(o) {
    const titleW = Math.max(...o.sections.map((s) => displayWidth(s.title)));
    const keyW = Math.max(0, ...o.sections.flatMap((s) => s.rows.map(([k]) => displayWidth(k))));
    const lines = [];
    for (const s of o.sections) {
        s.rows.forEach(([k, v], i) => {
            const head = padEnd(i === 0 ? s.title : '', titleW);
            lines.push(`  ${head}  ${k ? `${padEnd(k, keyW)}  ` : ''}${v}`);
        });
    }
    const width = Math.min(100, Math.max(displayWidth(o.title) + 4, ...lines.map(displayWidth)));
    const rule = '─'.repeat(width);
    return [rule, `  ${o.title}`, rule, ...lines, rule, ...o.warnings.map((w) => `  ! ${w}`), ...o.footer.map((f) => `  ${f}`)].join('\n');
}
