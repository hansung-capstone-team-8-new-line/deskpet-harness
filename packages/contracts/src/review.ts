import { z } from 'zod';
import { GitSha, Repository, UtcTimestamp } from './common.js';
import { ErrorInfo } from './records.js';

/**
 * 리뷰 조회 계약.
 * 근거: message-contracts §Review Query, Liability §Review Collection, 다이어그램 ReviewContracts.
 */

export const SectionKind = z.enum(['changes', 'checks', 'reviews']);
export type SectionKind = z.infer<typeof SectionKind>;

export const ReviewQuery = z.object({
  repository: Repository,
  prNumber: z.number().int().positive(),
  requestedSections: z.array(SectionKind),
  expectedHeadSha: GitSha.optional(),
  deadlineAt: UtcTimestamp,
  maxPages: z.number().int().positive().default(3),
  maxItemsPerSection: z.number().int().positive().default(100),
});
export type ReviewQuery = z.input<typeof ReviewQuery>;

export const PrBasics = z.object({
  title: z.string(),
  author: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  headSha: GitSha,
  baseRef: z.string(),
  baseSha: GitSha.optional(),
  observedAt: UtcTimestamp,
});
export type PrBasics = z.infer<typeof PrBasics>;

export const ChangesData = z.object({
  /** PR diff 비교 기준. 단일 head 커밋 diff로 대체하지 않는다. */
  comparison: z.object({ base: z.string(), head: z.string(), kind: z.literal('pr_base_to_head') }),
  files: z.array(
    z.object({ path: z.string(), status: z.string(), additions: z.number().int(), deletions: z.number().int() }),
  ),
});
export const RequiredChecksSource = z.enum(['github_branch_protection', 'github_rulesets', 'github_mixed', 'deskpet_config']);
export type RequiredChecksSource = z.infer<typeof RequiredChecksSource>;
/** plan_unsupported: 요금제상 보호 기능 없음, insufficient_permission: 볼 권한 없음, lookup_failed: 일시 오류 */
export const RequiredChecksUnknownReason = z.enum(['plan_unsupported', 'insufficient_permission', 'lookup_failed']);
export type RequiredChecksUnknownReason = z.infer<typeof RequiredChecksUnknownReason>;

export const ChecksData = z.object({
  runs: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['queued', 'in_progress', 'completed']),
      conclusion: z.enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required']).nullable(),
      headSha: GitSha.optional(),
      /** 같은 이름의 실행이 여러 개일 때 최신 실행을 고르기 위한 근거 (GitHub check run id·시각) */
      id: z.string().optional(),
      startedAt: UtcTimestamp.optional(),
      completedAt: UtcTimestamp.optional(),
    }),
  ),
  /**
   * 필수 검사 설정. 결과 목록만 보고 추정하지 않는다: 없다고 확인 vs 조회 불가 구분.
   * source: 어디서 확인했는지. deskpet_config는 GitHub가 요금제상 보호 기능을 제공하지 않을 때만 쓰는 대체 설정 (README D-13).
   * partial: 일부 출처만 확인됨(예: rulesets는 읽었지만 classic protection은 권한 부족) → 승인 차단.
   */
  requiredChecks: z.discriminatedUnion('state', [
    z.object({
      state: z.literal('configured'),
      names: z.array(z.string()),
      source: RequiredChecksSource.optional(),
      partial: z.boolean().optional(),
      githubUnavailableReason: RequiredChecksUnknownReason.optional(),
    }),
    z.object({ state: z.literal('none_configured'), source: RequiredChecksSource.optional() }),
    z.object({ state: z.literal('unknown'), reasonCode: RequiredChecksUnknownReason.optional(), reason: z.string() }),
  ]),
});
export type ChecksData = z.infer<typeof ChecksData>;

export const ReviewItem = z.object({
  reviewId: z.string(),
  author: z.string(),
  source: z.enum(['copilot', 'human', 'unknown']),
  state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']),
  commitSha: GitSha.optional(),
  submittedAt: UtcTimestamp.optional(),
  comments: z.array(
    z.object({
      path: z.string().optional(),
      line: z.number().int().optional(),
      severity: z.string().optional(),
      body: z.string(),
      /** summary: 리뷰 본문, inline: 코드 줄에 단 지적 (감사 F-06) */
      kind: z.enum(['summary', 'inline']).optional(),
    }),
  ),
});
export type ReviewItem = z.infer<typeof ReviewItem>;
export const ReviewsData = z.object({ reviews: z.array(ReviewItem) });

export const VersionEvidence = z.object({
  /** 실제 응답으로 확인한 SHA. 시작 SHA를 임의 복사하지 않는다. */
  headSha: GitSha.optional(),
  comparisonBase: z.string().optional(),
  source: z.string(),
});
export type VersionEvidence = z.infer<typeof VersionEvidence>;

const sectionBase = {
  availability: z.enum(['available', 'not_requested', 'unavailable', 'unsupported']),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  versionEvidence: VersionEvidence.optional(),
  observedAt: UtcTimestamp.optional(),
  pagination: z.object({ hasMore: z.boolean(), pagesRead: z.number().int().nonnegative() }).optional(),
  truncation: z.object({ truncated: z.boolean(), limit: z.number().int().optional() }).optional(),
  error: ErrorInfo.optional(),
  /**
   * 섹션 안 세부 자료의 수집 범위 (감사 F-06). 목록 페이지 완전성(completeness)과 따로 표시한다.
   * - patches: 변경 줄 내용(diff). MVP는 파일·증감 줄 수만 모으고 내용은 모으지 않는다(not_collected).
   * - inlineComments: 리뷰의 코드 줄 지적. complete | partial(페이지 상한) | unavailable(조회 실패)
   */
  detailCoverage: z
    .object({
      patches: z.enum(['complete', 'partial', 'unavailable', 'not_collected']).optional(),
      inlineComments: z.enum(['complete', 'partial', 'unavailable', 'not_collected']).optional(),
    })
    .optional(),
};

export const ReviewSection = z.discriminatedUnion('sectionKind', [
  z.object({ sectionKind: z.literal('changes'), data: ChangesData.optional(), ...sectionBase }),
  z.object({ sectionKind: z.literal('checks'), data: ChecksData.optional(), ...sectionBase }),
  z.object({ sectionKind: z.literal('reviews'), data: ReviewsData.optional(), ...sectionBase }),
]);
export type ReviewSection = z.infer<typeof ReviewSection>;

export const Consistency = z.enum(['verified', 'changed', 'unverified']);
export type Consistency = z.infer<typeof Consistency>;

export const ReviewContext = z.object({
  repository: Repository,
  prNumber: z.number().int().positive(),
  prBasics: PrBasics.optional(),
  requestedHeadSha: GitSha.optional(),
  initialHeadSha: GitSha.optional(),
  observedHeadSha: GitSha.optional(),
  diffComparisonBase: z.string().optional(),
  /** verified = 확보 자료의 선언된 코드 버전 일치. 동일 시점 스냅샷이나 전체 확보를 뜻하지 않는다. */
  consistency: Consistency,
  /** expectedHeadSha와 최초 SHA가 달라 상세 조회 전에 반환했는지 */
  stoppedBeforeDetails: z.boolean(),
  sections: z.array(ReviewSection),
  /** 승인 가능 판단용 조회자 정보 (checks 요청 시). 조회 불가면 생략 → 권한 미확인 */
  viewer: z.object({ login: z.string(), permission: z.string() }).optional(),
  error: ErrorInfo.optional(),
});
export type ReviewContext = z.infer<typeof ReviewContext>;
