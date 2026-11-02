/* eslint-disable no-console */
/**
 * Eureka 응답 필드 확인 (읽기 전용, GET만). G-01 시작부(리마인더 → PR 연결)에 쓸 만한 필드가 있는지 본다.
 *
 *   pnpm eureka:fields               # 업무 목록의 필드 이름·종류 요약
 *   pnpm eureka:fields 1000020       # + 그 업무의 목록·단건·상태 응답 원문(긴 값은 자름)
 *   pnpm eureka:fields --objects     # 표 없이 객체·배열 필드(note$$, task$$, tool$ 등)의 채워진 첫 예시만
 *   pnpm eureka:fields 1000020 --objects   # 위와 같되 그 업무 안에서만
 *   pnpm eureka:fields 1000020 --notes     # 그 업무 단계 기록(note)의 본문을 찾는다. 문서에 없는 경로를 GET으로만 시도
 *   pnpm eureka:fields --notes 1000196     # 단계의 기록(note) 본문을 읽는 경로를 찾는다 (후보 GET 경로를 차례로 시도)
 *
 * - 개발 환경(flw-d1)만 허용한다. 키 값은 출력하지 않는다.
 * - 조회: GET items/0/list?detail=true, GET items/{id}, GET items/{id}/status, GET processes/0/list?detail=true
 */
try {
  process.loadEnvFile('.env');
} catch {
  console.log('! .env 파일을 찾지 못했어요. app 폴더에서 실행했는지 확인하세요.');
}
const key = process.env['EUREKA_API_KEY'];
const base = (process.env['EUREKA_BASE_URL'] || 'https://api.eureka.codes/flw-d1').replace(/\/$/, '');
if (!key) {
  console.log('✗ EUREKA_API_KEY가 비어 있어요');
  process.exit(1);
}
if (!base.endsWith('/flw-d1')) {
  console.log(`✗ 개발 환경(flw-d1)에서만 실행해요. 지금 base URL: ${base}`);
  process.exit(1);
}
const itemId = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--notes');
const objectsOnly = process.argv.includes('--objects');
const notesProbe = process.argv.includes('--notes');
const notesStage = (() => {
  const i = process.argv.indexOf('--notes');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { headers: { 'x-api-key': key! }, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** 객체 배열의 키 → 종류·채워진 개수·예시. --objects면 표 대신 객체·배열 필드의 채워진 첫 예시만 보여 준다 */
function summarize(label: string, rows: Record<string, unknown>[]) {
  const m = new Map<string, { kinds: Set<string>; filled: number; sample?: string }>();
  for (const r of rows)
    for (const [k, v] of Object.entries(r)) {
      const e = m.get(k) ?? { kinds: new Set<string>(), filled: 0 };
      e.kinds.add(kind(v));
      if (v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)) {
        e.filled += 1;
        if (!e.sample && typeof v !== 'object') e.sample = String(v).slice(0, 40);
      }
      m.set(k, e);
    }
  if (objectsOnly) {
    let shown = 0;
    for (const k of [...m.keys()].sort()) {
      if (k === 'stage$$') continue; // 단계는 따로 필드별로 보여 준다
      const v = rows.map((r) => r[k]).find((x) => x && typeof x === 'object' && (!Array.isArray(x) || x.length > 0));
      if (!v) continue;
      show(`${label} · ${k} 예시`, Array.isArray(v) ? v.slice(0, 2) : v);
      shown += 1;
    }
    if (!shown) console.log(`\n── ${label}: 채워진 객체·배열 필드 없음 ──`);
    return;
  }
  console.log(`\n── ${label} (${rows.length}건) ──`);
  for (const [k, e] of [...m].sort((a, b) => a[0].localeCompare(b[0])))
    console.log(`  ${k.padEnd(22)} ${[...e.kinds].join('|').padEnd(14)} 채워짐 ${String(e.filled).padStart(3)}/${rows.length}${e.sample ? `  예: ${e.sample}` : ''}`);
}

function show(label: string, v: unknown) {
  const cut = (x: unknown): unknown =>
    typeof x === 'string' ? (x.length > 200 ? `${x.slice(0, 200)}…(${x.length}자)` : x) : Array.isArray(x) ? x.map(cut) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, cut(y)])) : x;
  console.log(`\n── ${label} ──`);
  console.log(JSON.stringify(cut(v), null, 2));
}

/** 기록(note) 본문 경로 찾기. API 문서에 note 조회가 없어서 후보 GET 경로를 시도한다 (모두 읽기) */
async function probeStageNotes(stageId: string) {
  const list = (await get('/_api_/items/0/list?sites&detail=true&limit=100')) as { list?: Record<string, unknown>[] };
  const stage = (list.list ?? []).flatMap((i) => (Array.isArray(i['stage$$']) ? (i['stage$$'] as Record<string, unknown>[]) : [])).find((x) => String(x['id']) === stageId);
  if (!stage) return console.log(`✗ 단계 ${stageId}를 목록에서 찾지 못했어요`);
  const noteIds = (Array.isArray(stage['noteIds']) ? stage['noteIds'] : []).map(String);
  console.log(`단계 ${stageId} (${String(stage['name'])}) 기록 ID: ${noteIds.join(', ') || '(없음)'}`);
  const n = encodeURIComponent(noteIds[0] ?? '0');
  const st = encodeURIComponent(stageId);
  const candidates = [
    `/_api_/notes/${n}`,
    `/_api_/notes/0/list?sites&stageId=${st}`,
    `/_api_/notes/0/list?stageId=${st}&detail=true`,
    `/_api_/stages/${st}`,
    `/_api_/stages/${st}?detail=true`,
    `/_api_/stages/${st}/notes`,
    `/_api_/stages/0/list?sites&detail=true&itemId=${encodeURIComponent(String(stage['itemId'] ?? ''))}`,
  ];
  for (const path of candidates) {
    try {
      show(`✓ GET ${path}`, await get(path));
    } catch (e) {
      console.log(`\n  - GET ${path} → ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  }
}

/** 업무 단위: 기록이 있는 단계마다 후보 경로를 GET으로만 시도한다 */
async function probeNotes(items: Record<string, unknown>[]) {
  const item = items.find((i) => String(i['id']) === itemId);
  if (!item) return console.log(`  - 업무 ${itemId}가 목록에 없어요`);
  const stages = (Array.isArray(item['stage$$']) ? item['stage$$'] : []) as Record<string, unknown>[];
  const withNotes = stages.filter((st) => Array.isArray(st['noteIds']) && (st['noteIds'] as unknown[]).length);
  if (!withNotes.length) return console.log(`  - 업무 ${itemId}에 기록이 있는 단계가 없어요`);
  for (const st of withNotes) {
    const sid = encodeURIComponent(String(st['id']));
    const noteId = encodeURIComponent(String((st['noteIds'] as unknown[])[0]));
    console.log(`\n=== 단계 ${st['id']} (${st['name']}) — 기록 ${(st['noteIds'] as unknown[]).join(', ')} ===`);
    for (const path of [
      `/_api_/notes/${noteId}`,
      `/_api_/notes/0/list?sites&detail=true&stageId=${sid}`,
      `/_api_/stages/${sid}`,
      `/_api_/stages/${sid}/notes`,
      `/_api_/items/0/list?sites&detail=true&limit=100&with=notes`,
    ]) {
      try {
        const v = await get(path);
        const text = JSON.stringify(v);
        console.log(`  ✓ GET ${path} — ${text.length}자, 본문 후보 필드: ${[...new Set(text.match(/"(text|content|body|comment|message|memo|desc[a-z]*)"/g) ?? [])].join(' ') || '없음'}`);
        if (!path.includes('items/0/list')) show(`GET ${path}`, v);
      } catch (e) {
        console.log(`  ✗ GET ${path} — ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      }
    }
  }
}

async function main() {
  console.log(`Eureka 필드 확인 — ${base} (읽기 전용)`);
  if (notesStage) return probeStageNotes(notesStage);
  const list = (await get('/_api_/items/0/list?sites&detail=true&limit=100')) as { list?: Record<string, unknown>[] };
  const all = list.list ?? [];
  if (notesProbe) {
    if (!itemId) return console.log('✗ --notes는 업무 번호가 필요해요 (예: pnpm eureka:fields 1000020 --notes)');
    return probeNotes(all);
  }
  // --objects + 업무 번호: 그 업무의 예시만 본다
  const items = objectsOnly && itemId ? all.filter((i) => String(i['id']) === itemId) : all;
  if (objectsOnly && itemId && !items.length) console.log(`  - 업무 ${itemId}가 목록에 없어요`);
  if (objectsOnly) console.log(`객체·배열 필드 예시만 표시${itemId ? ` (업무 ${itemId})` : ''}. 단계 목록(stage$$)은 아래 단계 항목에서 필드별로 보여 줘요`);
  summarize('업무(item) 필드', items);
  summarize('단계(stage$$) 필드', items.flatMap((i) => (Array.isArray(i['stage$$']) ? (i['stage$$'] as Record<string, unknown>[]) : [])));
  if (!(objectsOnly && itemId)) try {
    const procs = (await get('/_api_/processes/0/list?sites&detail=true&limit=50')) as { list?: Record<string, unknown>[] };
    summarize('프로세스(process) 필드', procs.list ?? []);
  } catch (e) {
    console.log(`\n  - 프로세스 목록 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (itemId && !objectsOnly) {
    show(`목록 응답의 업무 ${itemId}`, items.find((i) => String(i['id']) === itemId) ?? '(목록에 없음)');
    for (const [label, path] of [
      ['단건 GET items/{id}', `/_api_/items/${encodeURIComponent(itemId)}`],
      ['상태 GET items/{id}/status', `/_api_/items/${encodeURIComponent(itemId)}/status`],
    ] as const) {
      try {
        show(label, await get(path));
      } catch (e) {
        console.log(`\n  - ${label} 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

main().catch((e: unknown) => {
  console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
