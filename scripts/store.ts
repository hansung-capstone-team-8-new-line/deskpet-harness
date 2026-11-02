/* eslint-disable no-console */
/**
 * Harness 저장소(SQLite) 조회 — **읽기 전용**. DB를 readOnly로 열고 재시작 복구도 하지 않는다 (기록을 바꾸지 않음).
 *
 *   pnpm db                       # 요약: 종류별 건수, 결과 확인 필요·판정 대기 작업
 *   pnpm db ops                   # operation 목록 (최근 변경 순)
 *   pnpm db op <operationId>      # operation 하나 전체(JSON)
 *   pnpm db pending               # pending·confirmation 목록
 *   pnpm db dedup                 # 축약된 최소 중복 방지 기록
 *   pnpm db turns                 # 턴 결과(중복 턴 응답용) 목록
 *   pnpm db raw <종류> <키>        # 레코드 원문 (종류: op|pending|conf|dedup|dedupConf|turn|pipe|meta)
 *   옵션: --db <경로>  (기본: .env의 DESKPET_STORE_PATH)
 *
 * 주의: Harness가 실행 중이 아닐 때 본 값은 "마지막 기록 그대로"다. 다음에 Harness가 이 파일을 열면 재시작 복구가
 * 적용된다 (예: ack 뒤 끝난 쓰기 → unknown).
 */
import { existsSync, statSync } from 'node:fs';

try {
  process.loadEnvFile('.env');
} catch {
  /* .env 없음 */
}

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const dbPath = (dbIdx >= 0 ? args[dbIdx + 1] : process.env['DESKPET_STORE_PATH'])?.trim();
const rest = args.filter((_, i) => dbIdx < 0 || (i !== dbIdx && i !== dbIdx + 1));
const [cmd = 'summary', a1, a2] = rest;

if (!dbPath) {
  console.log('DB 경로가 없어요. --db <경로> 또는 .env의 DESKPET_STORE_PATH를 지정하세요.');
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.log(`DB 파일이 없어요: ${dbPath} (아직 DESKPET_STORE_PATH로 demo를 실행하지 않았을 수 있어요)`);
  process.exit(1);
}

const sqlite = process.getBuiltinModule?.('node:sqlite') as
  | { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => { prepare(s: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown }; close(): void } }
  | undefined;
if (!sqlite) {
  console.log('node:sqlite를 쓸 수 없어요. Node.js 22.13 이상이 필요해요.');
  process.exit(1);
}
const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
const rows = (cat: string) => (db.prepare('SELECT key, json FROM records WHERE cat = ?').all(cat) as { key: string; json: string }[]).map((r) => ({ key: r.key, v: JSON.parse(r.json) as Record<string, unknown> }));

type Op = {
  operationId: string;
  requestId: string;
  action: string;
  revision: number;
  executionPhase: string;
  assessment: string;
  recovery: string;
  updatedAt: string;
  target: { kind: string; repository?: { owner: string; name: string }; prNumber?: number; itemId?: string; stageId?: string };
  attempts: { dispatchState: string }[];
  actionResult?: { status: string; dispatchState: string; externalRefs: { kind: string; id: string }[] };
  currentExecutionAuthority?: { holderId: string; kind: string };
};
const tgt = (t: Op['target']) => (t.kind === 'github_pr' ? `${t.repository?.owner}/${t.repository?.name}#${t.prNumber}` : t.itemId ? `eureka ${t.itemId}${t.stageId ? `/${t.stageId}` : ''}` : t.kind);
const opLine = (o: Op) => {
  const ar = o.actionResult;
  const last = o.attempts[o.attempts.length - 1]?.dispatchState ?? '-';
  const refs = ar?.externalRefs?.length ? ` refs=${ar.externalRefs.map((r) => `${r.kind}:${r.id}`).join(',')}` : '';
  const auth = o.currentExecutionAuthority ? ` 권한보유=${o.currentExecutionAuthority.kind}` : '';
  return `  ${o.updatedAt}  ${o.operationId}  ${o.action.padEnd(18)} ${tgt(o.target).padEnd(34)} 결과=${ar?.status ?? '(없음)'} 전송=${last} 단계=${o.executionPhase} 판정=${o.assessment} 복구=${o.recovery}${auth}${refs}  [${o.requestId}]`;
};
const ops = () => rows('op').map((r) => r.v as unknown as Op).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));

switch (cmd) {
  case 'summary': {
    const counts = db.prepare('SELECT cat, COUNT(*) AS n FROM records GROUP BY cat ORDER BY cat').all() as { cat: string; n: number }[];
    const names: Record<string, string> = { op: 'operation', pending: 'pending', conf: 'confirmation', dedup: '축약 기록', dedupConf: '축약 색인', turn: '턴 결과', pipe: '파이프라인 순서', meta: '메타' };
    const size = (p: string) => (existsSync(p) ? statSync(p).size : 0);
    const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;
    console.log(`DB: ${dbPath} (읽기 전용) — 파일 ${kb(size(dbPath))}, WAL ${kb(size(`${dbPath}-wal`))}`);
    for (const c of counts) console.log(`  ${(names[c.cat] ?? c.cat).padEnd(14)} ${c.n}`);
    const all = ops();
    const attention = all.filter((o) => o.recovery !== 'none' || o.assessment === 'pending' || o.actionResult?.status === 'unknown' || o.currentExecutionAuthority);
    console.log(`\n확인이 필요한 operation ${attention.length}건 (결과 불명·복구 필요·판정 대기·실행 권한 남음)`);
    for (const o of attention) console.log(opLine(o));
    if (all.some((o) => o.currentExecutionAuthority)) console.log('  → 실행 권한이 남은 기록은 Harness가 다음에 열 때 재시작 복구로 정리돼요.');
    break;
  }
  case 'ops':
    for (const o of ops()) console.log(opLine(o));
    break;
  case 'op': {
    const r = db.prepare("SELECT json FROM records WHERE cat = 'op' AND key = ?").get(a1 ?? '') as { json: string } | undefined;
    if (!r) {
      const d = db.prepare("SELECT json FROM records WHERE cat = 'dedup' AND key = ?").get(a1 ?? '') as { json: string } | undefined;
      console.log(d ? `(축약된 기록)\n${JSON.stringify(JSON.parse(d.json), null, 2)}` : `operation ${a1 ?? '(id 없음)'}을 찾지 못했어요`);
    } else console.log(JSON.stringify(JSON.parse(r.json), null, 2));
    break;
  }
  case 'pending': {
    const confs = new Map(rows('conf').map((r) => [String(r.v['pendingId']), r.v]));
    for (const { v: p } of rows('pending').sort((x, y) => String(y.v['expiresAt']).localeCompare(String(x.v['expiresAt'])))) {
      const c = confs.get(String(p['pendingId']));
      console.log(
        `  ${p['pendingId']}  ${String(p['kind']).padEnd(13)} ${String(p['purpose']).padEnd(22)} 상태=${p['state']} 전달=${p['questionDeliveryEvidence'] ? '됨' : '안됨'} 만료=${p['expiresAt']}` +
          (c ? `  | 확인 ${c['confirmationId']} 상태=${c['state']}${c['verdict'] ? ` 판정=${c['verdict']}` : ''}${c['operationId'] ? ` → ${c['operationId']}` : ''}` : '') +
          `  [${p['requestId']}]`,
      );
    }
    break;
  }
  case 'dedup':
    for (const { v } of rows('dedup')) console.log(`  ${v['operationId']}  ${v['action']}  결과=${v['result']}  ids=${(v['externalIds'] as string[]).join(',') || '-'}  ${JSON.stringify(v['keyTimestamps'])}`);
    break;
  case 'turns':
    for (const { key, v } of rows('turn')) console.log(`  ${key}  요청=${v['requestId']}  disposition=${v['disposition']}  작업=${(v['actionResults'] as { action: string; status: string }[]).map((x) => `${x.action}:${x.status}`).join(',') || '-'}`);
    break;
  case 'raw': {
    const r = db.prepare('SELECT json FROM records WHERE cat = ? AND key = ?').get(a1 ?? '', a2 ?? '') as { json: string } | undefined;
    console.log(r ? JSON.stringify(JSON.parse(r.json), null, 2) : '레코드가 없어요');
    break;
  }
  default:
    console.log('알 수 없는 명령이에요. summary | ops | op <id> | pending | dedup | turns | raw <종류> <키>');
    process.exitCode = 1;
}
db.close();
