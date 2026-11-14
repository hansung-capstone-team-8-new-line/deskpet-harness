import { z } from 'zod';
import { Id, UtcTimestamp } from './common.js';

/**
 * Eureka 정규화 타입 (DeskPet 내부 계약).
 * 근거: eureka-desk-pet-guide.pdf §2~§4, eureka-process.md. 서버 원본 JSON과 같다고 가정하지 않는다.
 */

export const StageStatus = z.enum(['todo', 'doing', 'done', 'skip', 'unknown']);
export type StageStatus = z.infer<typeof StageStatus>;

/** item 상태는 서버가 갱신하지 않으므로 stage$$로 계산한다 (PDF §3-(2)). */
export const ItemState = z.enum(['todo', 'doing', 'done', 'hold']);
export type ItemState = z.infer<typeof ItemState>;

export const TaskStage = z.object({
  stageId: Id,
  name: z.string(),
  status: StageStatus,
  order: z.number().int().optional(),
  completedAt: UtcTimestamp.optional(),
  /** 단계 기록(note) ID. 목록 응답에는 본문이 없고 {id, stereo}만 온다 */
  noteIds: z.array(Id).optional(),
});
export type TaskStage = z.infer<typeof TaskStage>;

/** 단계 기록. GET /_api_/notes/0/list?sites&detail=true&stageId= (PDF에 없음, 2026-10-24 Eureka에서 확인) */
export const StageNote = z.object({
  noteId: Id,
  stageId: Id,
  content: z.string(),
  /** 작성자 uid ($.uid). 작성자 제한은 지금 쓰지 않는다 (사용자 결정 2026-10-24) */
  authorUid: z.string().optional(),
  createdAt: UtcTimestamp.optional(),
  isResolved: z.boolean().optional(),
});
export type StageNote = z.infer<typeof StageNote>;

export const StageNoteList = z.object({
  stageId: Id,
  notes: z.array(StageNote),
  total: z.number().int().nonnegative().optional(),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  observedAt: UtcTimestamp,
});
export type StageNoteList = z.infer<typeof StageNoteList>;

/** 단계 기록에서 찾은 PR 연결 (G-01 시작부: 리마인더 업무 → PR) */
export const LinkedPr = z.object({
  repository: z.object({ owner: z.string().min(1), name: z.string().min(1) }),
  prNumber: z.number().int().positive(),
  url: z.string(),
  itemId: Id,
  stageId: Id,
  stageName: z.string(),
  stageStatus: StageStatus,
  noteId: Id,
});
export type LinkedPr = z.infer<typeof LinkedPr>;

/**
 * linked: 서로 다른 (PR, 단계) 조합이 정확히 하나. ambiguous: 둘 이상이라 추측하지 않는다.
 * none: 기록에 PR 주소 없음. partial: 일부 기록을 읽지 못해 확정하지 않음. failed: 업무 조회 실패. not_found: 업무 없음
 */
export const PrLinkStatus = z.enum(['linked', 'ambiguous', 'none', 'partial', 'failed', 'not_found']);
export type PrLinkStatus = z.infer<typeof PrLinkStatus>;

export const PrLinkLookup = z.object({
  itemId: Id,
  itemName: z.string().optional(),
  status: PrLinkStatus,
  /** linked면 1개. ambiguous면 후보 전체 */
  links: z.array(LinkedPr),
  /** 허용 저장소 목록(D-36)에 없어 뺀 PR 주소 수. 0이면 생략 */
  excludedCount: z.number().int().positive().optional(),
  observedAt: UtcTimestamp,
});
export type PrLinkLookup = z.infer<typeof PrLinkLookup>;

const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?![\w/])/g;

/**
 * 허용 저장소 목록 (D-36). `owner/name` 형식, 대소문자 무시. 목록이 없거나 비어 있으면 제한하지 않는다.
 */
export function isRepositoryAllowed(allowed: readonly string[] | undefined, owner: string, name: string): boolean {
  if (!allowed || allowed.length === 0) return true;
  const key = `${owner}/${name}`.toLowerCase();
  return allowed.some((r) => r.trim().toLowerCase() === key);
}

/** `owner/name,owner/name` 문자열을 목록으로. 형식이 틀린 항목은 invalid로 돌려준다 */
export function parseAllowedRepositories(raw: string | undefined): { repos: string[]; invalid: string[] } {
  const items = (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const ok = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
  return { repos: items.filter((x) => ok.test(x)), invalid: items.filter((x) => !ok.test(x)) };
}

/**
 * 기록 본문에서 GitHub PR 주소만 뽑는다. 그 밖의 문장은 버린다 (기록은 데이터, 지시가 아님).
 * 같은 PR은 하나로 합친다. 허용 저장소 걸러내기는 쓰는 쪽에서 isRepositoryAllowed로 한다 (D-36).
 */
export function extractPrLinks(text: string): { owner: string; name: string; prNumber: number; url: string }[] {
  const out = new Map<string, { owner: string; name: string; prNumber: number; url: string }>();
  for (const m of text.matchAll(PR_URL)) {
    const prNumber = Number(m[3]);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) continue;
    const owner = m[1]!;
    const name = m[2]!.replace(/\.git$/, '');
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}#${prNumber}`;
    if (!out.has(key)) out.set(key, { owner, name, prNumber, url: `https://github.com/${owner}/${name}/pull/${prNumber}` });
  }
  return [...out.values()];
}

export const TaskSummary = z.object({
  itemId: Id,
  name: z.string(),
  /** 리마인더 설명. Eureka PDF 응답 예시에는 없음 → 없으면 생략하고 name으로 대체하지 않는다 (README C-08) */
  description: z.string().optional(),
  dueAtMs: z.number().int().optional(),
  dueAt: UtcTimestamp.optional(),
  priority: z.string().optional(),
  /** 마지막 수정 시각. 다른 사용자가 바꾼 업무인지 볼 때 쓴다 (시나리오 "다른 사용자가 수정한 업무", 2026-11-08) */
  updatedAt: UtcTimestamp.optional(),
  computedState: ItemState,
  stages: z.array(TaskStage),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskList = z.object({
  items: z.array(TaskSummary),
  total: z.number().int().nonnegative().optional(),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  observedAt: UtcTimestamp,
});
export type TaskList = z.infer<typeof TaskList>;

export const TaskState = z.object({
  itemId: Id,
  /** GET /items/{id}/status 서버 계산값 */
  itemStatus: ItemState,
  totalStages: z.number().int().nonnegative(),
  doneStages: z.number().int().nonnegative(),
  stage: TaskStage.optional(),
  observedAt: UtcTimestamp,
});
export type TaskState = z.infer<typeof TaskState>;

/**
 * 완료 근거 기록 문구 (D-28). 단계 완료가 성공한 뒤 단계 기록(note)에 남긴다.
 * - 표시(EVIDENCE_NOTE_MARK)와 PR 주소, 승인 커밋 앞 7자리가 모두 있는 기록이 이미 있으면 다시 쓰지 않는다
 * - 이메일·토큰 같은 계정 정보는 넣지 않는다
 */
export const EVIDENCE_NOTE_MARK = '[DeskPet 완료 근거]';

export function evidenceNoteContent(e: { owner: string; name: string; prNumber: number; approvedSha: string; reviewId?: string }): string {
  const url = `https://github.com/${e.owner}/${e.name}/pull/${e.prNumber}`;
  return `${EVIDENCE_NOTE_MARK} ${url} 승인 후 단계 완료 (커밋 ${e.approvedSha.slice(0, 7)}${e.reviewId ? `, 리뷰 ${e.reviewId}` : ''})`;
}

/** 같은 PR·같은 승인 커밋의 완료 근거 기록인지 */
export function isSameEvidenceNote(content: string, e: { owner: string; name: string; prNumber: number; approvedSha: string }): boolean {
  if (!content.includes(EVIDENCE_NOTE_MARK) || !content.includes(e.approvedSha.slice(0, 7))) return false;
  return extractPrLinks(content).some((l) => l.prNumber === e.prNumber && l.owner.toLowerCase() === e.owner.toLowerCase() && l.name.toLowerCase() === e.name.toLowerCase());
}
