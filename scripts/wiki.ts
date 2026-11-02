/* eslint-disable no-console */
/**
 * LLM Wiki 검색 확인 (읽기 전용). Harness가 Guide 참고 자료로 넘길 발췌를 그대로 보여 준다 (D-19 / L-10).
 *
 *   pnpm wiki "질의"                       # .env의 DESKPET_WIKI_DIR (vault 루트: wiki/, projects/가 있는 폴더)
 *   pnpm wiki "질의" --dir <vault 경로>
 */
import { FileWikiReader } from '@deskpet/harness';

try {
  process.loadEnvFile('.env');
} catch {
  /* .env 없이 --dir만 써도 된다 */
}
const args = process.argv.slice(2);
const di = args.indexOf('--dir');
const dir = (di >= 0 ? args[di + 1] : undefined) ?? process.env['DESKPET_WIKI_DIR']?.trim();
// --dir가 없을 때(di=-1) 첫 인자를 빼지 않도록 한다
const query = args.filter((_, i) => di < 0 || (i !== di && i !== di + 1)).join(' ').trim();
if (!dir) {
  console.log('✗ vault 경로가 필요해요: .env의 DESKPET_WIKI_DIR 또는 --dir <경로>');
  process.exit(1);
}
if (!query) {
  console.log('✗ 질의가 필요해요: pnpm wiki "PR 승인 확인 절차"');
  process.exit(1);
}

const reader = new FileWikiReader({ root: dir });
const t0 = Date.now();
const r = await reader.search(query, 'all', { deadlineAt: new Date(Date.now() + 10_000).toISOString() });
const ms = Date.now() - t0;
if (r.outcome === 'failed') {
  console.log(`✗ 검색 실패 — 경로를 확인하세요: ${dir}`);
  process.exit(1);
}
const st = await reader.stats();
console.log(`색인: 문서 ${st.documents}개 / 구간 ${st.sections}개  ·  ${ms}ms  ·  결과: ${r.outcome}`);
let total = 0;
for (const e of r.excerpts) {
  total += e.text.length;
  console.log(`\n[${e.source.ref}] (${e.text.length}자)\n${e.text}`);
}
if (r.excerpts.length) console.log(`\n합계 ${total}자 (상한 1,500자)`);
