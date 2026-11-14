import type {
  ActionName,
  ActionResult,
  CallConstraints,
  DispatchHandle,
  GitHubPrTarget,
  HarnessResult,
  Target,
} from '@deskpet/contracts';
import type { ReviewFacts } from '../facts.js';

/**
 * Worker가 Fast-Path 쓰기 어댑터(예: github_fast_submit_approval)를 실행할 때
 * OperationStore 기반 DispatchHandle 및 Harness 실행 파이프라인(Sensor/FollowUp)에
 * 접근하기 위한 최소 포트.
 */
export interface DispatchAuthoritySource {
  acquireHandle(
    params: {
      requestId: string;
      action: ActionName;
      target: Target;
      actualRequest: Record<string, unknown>;
    },
    c: CallConstraints,
  ): Promise<{ operationId: string; handle: DispatchHandle }>;

  executeGitHubReview?(
    params: {
      requestId: string;
      target: GitHubPrTarget;
      requestedSections: ('changes' | 'checks' | 'reviews')[];
      purpose?: 'review' | 'approval_precheck';
      expectedHeadSha?: string;
    },
    c: CallConstraints,
  ): Promise<{ actionResult?: ActionResult; review?: ReviewFacts; error?: string }>;

  executeGitHubApproval?(
    params: {
      requestId: string;
      target: GitHubPrTarget;
      expectedHeadSha: string;
    },
    c: CallConstraints,
  ): Promise<HarnessResult>;
}
