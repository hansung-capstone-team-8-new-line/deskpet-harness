import type { ConfirmationScope } from './records.js';

/**
 * 확인 질문의 고정 범위 문구 (감사 F-01·F-02).
 *
 * - 대상·행위·버전은 코드가 만든 이 문구로만 전달한다. 출력 모델은 앞뒤 말투만 바꿀 수 있고, 이 문구는 글자 그대로 들어가야 한다.
 * - Harness는 파이프라인이 보고한 실제 전달 문장(deliveredText)에 이 문구가 있고 다른 저장소·PR·커밋이 섞여 있지 않을 때만
 *   질문 전달을 인정한다. 다른 대상을 물은 뒤 받은 "네"로 이 범위를 실행하지 않기 위해서다.
 * - 문구는 golden-scenario 출력 예시 문장의 일부와 같다.
 */
export function confirmationTokens(scope: ConfirmationScope): string[] {
  const t = scope.target;
  if (t.kind === 'github_pr') {
    return [`${t.repository.owner}/${t.repository.name} PR ${t.prNumber}번, 현재 커밋 ${shortSha(scope.headSha)}`, '승인'];
  }
  if (t.kind === 'eureka_stage') {
    const name = scope.exactChange?.['stageName'];
    const label = typeof name === 'string' && name ? `'${name}' 단계` : `'${t.stageId}' 단계`;
    return [`Eureka의 ${label}를 완료로 반영`];
  }
  return [scope.action];
}

/** 문장 안에 나온 식별자. 허용 목록 밖의 저장소·PR 번호·커밋이 섞였는지 검사할 때 쓴다 */
export interface MentionedIdentifiers {
  repositories: string[];
  prNumbers: number[];
  shas: string[];
}

const REPO_RE = /(?<![\w.-])[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\w.-]*\/)/g;
const PR_RE = /(?:PR|pr|풀\s*리퀘스트)\s*#?\s*(\d+)|#(\d+)/g;
/** 16진수 7~40자 중 숫자와 a-f 문자를 모두 포함한 것만 커밋으로 본다 (날짜·수량 오인 방지) */
const SHA_RE = /(?<![0-9A-Za-z])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![0-9A-Za-z])/g;

export function mentionedIdentifiers(text: string): MentionedIdentifiers {
  return {
    repositories: [...text.matchAll(REPO_RE)].map((m) => m[0].toLowerCase()),
    prNumbers: [...text.matchAll(PR_RE)].map((m) => Number(m[1] ?? m[2])),
    shas: [...text.matchAll(SHA_RE)].map((m) => m[0]),
  };
}

export interface AllowedIdentifiers {
  repositories: Set<string>;
  prNumbers: Set<number>;
  /** 전체 또는 앞부분 SHA. 문장에 나온 SHA는 이 중 하나의 앞부분이어야 한다 */
  shas: Set<string>;
}

export function emptyAllowed(): AllowedIdentifiers {
  return { repositories: new Set(), prNumbers: new Set(), shas: new Set() };
}

/** 허용 목록 밖 식별자. 빈 배열이면 통과 */
export function foreignIdentifiers(text: string, allowed: AllowedIdentifiers): string[] {
  const m = mentionedIdentifiers(text);
  const out: string[] = [];
  for (const r of m.repositories) if (!allowed.repositories.has(r)) out.push(`repository:${r}`);
  for (const n of m.prNumbers) if (!allowed.prNumbers.has(n)) out.push(`pr:${n}`);
  for (const s of m.shas) if (![...allowed.shas].some((a) => a.startsWith(s) || s.startsWith(a))) out.push(`sha:${s}`);
  return out;
}

export function allowedFromScope(scope: ConfirmationScope, into: AllowedIdentifiers = emptyAllowed()): AllowedIdentifiers {
  const t = scope.target;
  if (t.kind === 'github_pr') {
    into.repositories.add(`${t.repository.owner}/${t.repository.name}`.toLowerCase());
    into.prNumbers.add(t.prNumber);
  }
  if (scope.headSha) into.shas.add(scope.headSha);
  // 후속 완료 질문은 앞서 승인한 PR을 함께 말한다
  const x = scope.exactChange ?? {};
  if (typeof x['linkedRepository'] === 'string') into.repositories.add(x['linkedRepository'].toLowerCase());
  if (typeof x['linkedPrNumber'] === 'number') into.prNumbers.add(x['linkedPrNumber']);
  if (typeof x['approvedSha'] === 'string' && x['approvedSha']) into.shas.add(x['approvedSha']);
  return into;
}

/**
 * 실제 전달 문장이 확인 범위와 맞는지. 고정 문구가 모두 있고 다른 대상 식별자가 없어야 한다.
 * 전달 문장이 없으면 확인할 수 없으므로 false.
 */
export function deliveredQuestionMatches(scope: ConfirmationScope, deliveredText: string | undefined): boolean {
  if (!deliveredText) return false;
  if (!confirmationTokens(scope).every((tok) => deliveredText.includes(tok))) return false;
  return foreignIdentifiers(deliveredText, allowedFromScope(scope)).length === 0;
}

export function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 7) : '알 수 없음';
}
