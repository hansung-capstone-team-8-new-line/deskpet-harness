import type { ChecksData, PrBasics } from './review.js';

/**
 * PR 승인 가능 조건 (순수 함수). Harness의 확인 질문 전 검사와 Gateway의 실행 직전 재검증이 같은 규칙을 쓴다.
 * 근거: Liability §Confirmation and Execution 1 — 필수 검사 실패·진행 중·판정 불가, SHA 변경, 권한·정책 미확인은 차단.
 *       "필수 검사가 없다고 확인한 경우와 설정을 조회하지 못한 경우를 구분한다."
 */
export type ViewerPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none' | 'unknown';

export interface ApprovalCheckInput {
  pr?: PrBasics;
  checks?: ChecksData;
  expectedHeadSha: string;
  viewerLogin?: string;
  viewerPermission: ViewerPermission;
}

type CheckRun = ChecksData['runs'][number];

/**
 * 같은 이름의 검사 실행이 여러 개면(같은 커밋에 PR을 다시 열거나 Re-run) 최신 실행 하나로 판정한다.
 * 최신 판단 근거: startedAt → completedAt → 숫자 id 순. 근거가 없으면 보수적으로 가장 나쁜 결과를 고른다.
 * (docs/connection-test-issues.md #4)
 */
export function latestRunsByName(runs: CheckRun[]): { runs: CheckRun[]; duplicates: number } {
  const groups = new Map<string, CheckRun[]>();
  for (const r of runs) groups.set(r.name, [...(groups.get(r.name) ?? []), r]);
  const out: CheckRun[] = [];
  for (const g of groups.values()) out.push(g.length === 1 ? g[0]! : pickLatest(g));
  return { runs: out, duplicates: runs.length - out.length };
}

function pickLatest(g: CheckRun[]): CheckRun {
  const keyOf = (r: CheckRun): number | undefined => {
    const t = r.startedAt ?? r.completedAt;
    if (t) return Date.parse(t);
    return undefined;
  };
  if (g.every((r) => keyOf(r) !== undefined)) return g.reduce((a, b) => (keyOf(b)! > keyOf(a)! ? b : a));
  if (g.every((r) => r.id !== undefined && /^\d+$/.test(r.id))) return g.reduce((a, b) => (BigInt(b.id!) > BigInt(a.id!) ? b : a));
  // 순서 근거 없음 → 진행 중 > 실패 > 성공 순으로 나쁜 쪽
  const rank = (r: CheckRun) => (r.status !== 'completed' ? 2 : ['success', 'skipped', 'neutral'].includes(r.conclusion ?? '') ? 0 : 1);
  return g.reduce((a, b) => (rank(b) > rank(a) ? b : a));
}

export function approvalBlockers(i: ApprovalCheckInput): string[] {
  const out: string[] = [];
  if (!i.pr) return ['pr_basics_unavailable'];
  if (i.pr.state !== 'open') out.push(`pr_${i.pr.state}`);
  if (i.pr.draft) out.push('pr_draft');
  if (i.pr.headSha !== i.expectedHeadSha) out.push('sha_changed');
  if (i.viewerPermission === 'unknown') out.push('permission_unverified');
  else if (!['admin', 'maintain', 'write'].includes(i.viewerPermission)) out.push('permission_insufficient');
  if (i.viewerLogin && i.viewerLogin === i.pr.author) out.push('cannot_approve_own_pr');
  if (!i.checks) {
    out.push('checks_unavailable');
    return out;
  }
  const req = i.checks.requiredChecks;
  const runs = latestRunsByName(i.checks.runs).runs;
  if (req.state === 'unknown') out.push('required_checks_unverified');
  if (req.state === 'configured' && req.partial) out.push('required_checks_partially_verified');
  if (req.state === 'configured') {
    for (const name of req.names) {
      const run = runs.find((r) => r.name === name);
      if (!run) out.push(`required_check_missing:${name}`);
      else if (run.headSha && run.headSha !== i.expectedHeadSha) out.push(`required_check_other_sha:${name}`);
      else if (run.status !== 'completed') out.push(`required_check_pending:${name}`);
      else if (!['success', 'skipped', 'neutral'].includes(run.conclusion ?? '')) out.push(`required_check_failed:${name}`);
    }
  }
  return out;
}

/**
 * 필수가 아닌 검사의 실패·진행 중은 차단하지 않고 경고로만 알린다 (사용자 결정 2026-10-05, README D-14).
 * 필수 검사 설정을 확인하지 못한 경우는 이미 차단되므로 경고를 만들지 않는다.
 */
export function approvalWarnings(checks: ChecksData | undefined): string[] {
  if (!checks || checks.requiredChecks.state === 'unknown') return [];
  const required = new Set(checks.requiredChecks.state === 'configured' ? checks.requiredChecks.names : []);
  const out: string[] = [];
  for (const r of latestRunsByName(checks.runs).runs) {
    if (required.has(r.name)) continue;
    if (r.status !== 'completed') out.push(`non_required_check_pending:${r.name}`);
    else if (!['success', 'skipped', 'neutral'].includes(r.conclusion ?? '')) out.push(`non_required_check_failed:${r.name}`);
  }
  return out;
}
