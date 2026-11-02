import type { GitHubPrTarget, GuideDecision, GuideInput } from '@deskpet/contracts';
import { writeInputBlockers } from '../policy/inputPolicy.js';
import type { PolicyConfig } from '../policy/config.js';
import type { ReviewFacts } from '../facts.js';

/**
 * 규칙 기반 Guide (guide-sensor §Guide Interface). 행동 제안만 하고 실행·상태 변경을 하지 않는다.
 * 제안은 실행 권한이 아니다. Harness가 revision·정책을 검증한 뒤 적용한다.
 *
 * 지원 의도 (inference: 라우터 intention 값은 미정이므로 잠정 이름)
 * - pr.review  : 리뷰 자료 조회 → 사실 반환
 * - pr.approve : 승인 가능 조건 조회 → 확인 질문(ask_user confirmation) 또는 차단
 */
export interface Guide {
  /** 규칙 Guide는 동기, LLM 보조 Guide는 비동기로 답한다. Harness는 둘 다 await한다 */
  proposeNext(input: GuideInput): GuideDecision | Promise<GuideDecision>;
}

/** 규칙 Guide가 처리하는 의도. 그 밖의 의도만 LLM 보조 Guide로 넘긴다 */
export const RULE_INTENTS: ReadonlySet<string> = new Set(['pr.review', 'pr.approve']);

export interface GuideFacts {
  review?: ReviewFacts;
  /** 같은 대화에서 사용자가 들은 리뷰의 SHA (Harness 기록에서) */
  lastReviewedSha?: string;
  reviewError?: string;
  /** Wiki 검색을 했으면 그 결과 상태 (같은 요청에서 다시 검색하지 않는다) */
  wikiSearched?: 'found' | 'empty' | 'failed' | 'not_queried';
  /** 출력 모델에 넘길 Wiki 발췌 (최대 3개·1,500자, 출처). 배경 설명 참고용 (D-19 갱신) */
  wikiExcerpts?: { text: string; ref: string }[];
  /** Guide가 고른 단계 기록 (예: rule:..., llm:search_wiki). 진단·데모 표시용 */
  guideSteps?: string[];
}

export class RuleBasedGuide implements Guide {
  private n = 0;
  constructor(private readonly cfg: PolicyConfig) {}

  proposeNext(input: GuideInput): GuideDecision {
    const base = { decisionId: `dec-${++this.n}`, basedOnRevision: input.stateRevision, reasonRefs: [] as string[], unknowns: [] as string[] };
    const facts = input.facts as GuideFacts;
    const intent = input.goal.intent;
    const target = input.context.packet.target;

    if (intent !== 'pr.review' && intent !== 'pr.approve') {
      return { ...base, kind: 'blocked', payload: { unmetConditions: [`unsupported_intent:${intent}`], unknownEvidence: [], requiredUserOrSystemAction: 'none' } };
    }

    // 대상 미확정: 추측하지 않고 필요한 슬롯만 묻는다 (S-01, S-02)
    if (!target || target.kind !== 'github_pr') {
      const multi = input.context.packet.candidates.filter((c) => c.kind === 'github_pr').length > 1;
      return {
        ...base,
        kind: 'ask_user',
        reasonRefs: [multi ? 'multiple_candidates' : 'target_missing'],
        payload: { purpose: multi ? 'select_pr_candidate' : 'identify_pr', questionKind: 'clarification', requiredSlots: ['repository', 'prNumber'] },
      };
    }
    const pr = target as GitHubPrTarget;

    if (facts.reviewError) {
      return { ...base, kind: 'blocked', reasonRefs: ['review_read_failed'], payload: { unmetConditions: [facts.reviewError], unknownEvidence: [], requiredUserOrSystemAction: 'none' } };
    }

    if (intent === 'pr.review') {
      if (!facts.review) {
        return {
          ...base,
          kind: 'propose_action',
          payload: {
            action: 'get_review_context',
            typedArguments: { action: 'get_review_context', repository: pr.repository, prNumber: pr.prNumber, requestedSections: ['changes', 'checks', 'reviews'] },
            target: pr,
            prerequisites: [],
          },
        };
      }
      return { ...base, kind: 'finish', payload: { reason: 'review_collected', outputFactRefs: ['review'] } };
    }

    // ---- pr.approve
    const inputBlockers = writeInputBlockers(input.goal.currentTurn, this.cfg);
    if (inputBlockers.length > 0) {
      // S-04: 낮은/확인 불가 신뢰도에서 승인 차단, 대상과 행위를 다시 말하도록 요청
      return {
        ...base,
        kind: 'ask_user',
        reasonRefs: inputBlockers,
        payload: { purpose: 'restate_write_command', questionKind: 'clarification', requiredSlots: ['explicit_approve_command'] },
      };
    }
    if (!facts.review) {
      return {
        ...base,
        kind: 'propose_action',
        reasonRefs: ['approval_precheck'],
        payload: {
          action: 'get_review_context',
          typedArguments: {
            action: 'get_review_context',
            repository: pr.repository,
            prNumber: pr.prNumber,
            requestedSections: ['checks'],
            ...(facts.lastReviewedSha ? { expectedHeadSha: facts.lastReviewedSha } : {}),
          },
          target: pr,
          ...(facts.lastReviewedSha ? { expectedVersion: { headSha: facts.lastReviewedSha } } : {}),
          prerequisites: [],
        },
      };
    }
    const r = facts.review;
    if (r.approvalBlockers.length > 0 || !r.headSha) {
      return {
        ...base,
        kind: 'blocked',
        reasonRefs: ['approval_precheck_failed'],
        payload: { unmetConditions: r.approvalBlockers.length ? r.approvalBlockers : ['head_sha_unknown'], unknownEvidence: [], requiredUserOrSystemAction: 'user' },
      };
    }
    return {
      ...base,
      kind: 'ask_user',
      reasonRefs: ['approval_preconditions_met'],
      payload: { purpose: 'confirm_pr_approval', questionKind: 'confirmation', requiredSlots: [], targetActionVersion: { action: 'submit_approval', target: pr, headSha: r.headSha } },
    };
  }
}
