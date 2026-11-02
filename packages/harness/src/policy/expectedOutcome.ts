import type { ActionName, ExpectedOutcome, SectionKind, Target } from '@deskpet/contracts';

/**
 * 행위별 고정 검사 규칙 (guide-sensor §Expected Outcome).
 * 가이드가 제안한 기준은 참고만 하고 이 규칙으로 대체한다. LLM이 성공 증거 요구사항을 낮출 수 없다.
 */
export function expectedOutcomeFor(action: ActionName, target: Target, opts: { headSha?: string; sections?: SectionKind[] } = {}): ExpectedOutcome {
  const v = opts.headSha ? { expectedVersion: { headSha: opts.headSha } } : {};
  switch (action) {
    case 'get_review_context':
      return {
        action,
        target,
        ...v,
        postconditions: ['review.requested_sections_present', 'review.sections_version_consistent'],
        requiredEvidence: ['read_payload', 'version_evidence'],
        completenessRequirement: { sections: opts.sections ?? [], allowTruncation: false },
      };
    case 'submit_approval':
      return {
        action,
        target,
        ...v,
        postconditions: ['approval.review_state_approved', 'approval.commit_matches_expected_sha', 'approval.linked_to_this_submission'],
        requiredEvidence: ['review_id', 'review_state', 'review_commit_sha'],
        completenessRequirement: { sections: [], allowTruncation: false },
      };
    case 'complete_stage':
      return {
        action,
        target,
        postconditions: ['eureka.stage_status_done', 'eureka.linked_to_this_change'],
        requiredEvidence: ['stage_status', 'change_response'],
        completenessRequirement: { sections: [], allowTruncation: false },
      };
    case 'register_item':
    case 'postpone_item':
    case 'complete_item':
      // 직접 Eureka 경로 (파이프라인 Eureka 모듈 소유). 멱등키가 없어 응답 유실 시 인과 연결은 후보 수준 (README C-09)
      return {
        action,
        target,
        postconditions: ['eureka.linked_to_this_change'],
        requiredEvidence: ['change_response'],
        completenessRequirement: { sections: [], allowTruncation: false },
      };
    default:
      return {
        action,
        target,
        postconditions: ['eureka.read_complete'],
        requiredEvidence: ['read_payload'],
        completenessRequirement: { sections: [], allowTruncation: false },
      };
  }
}
