import type { ChecksData, PrBasics, Repository, RequiredChecksSource, RequiredChecksUnknownReason, ReviewItem, ViewerPermission } from '@deskpet/contracts';

/**
 * «port» GitHubTransport — MCP 또는 REST adapter로 교체 가능 (다이어그램, message-contracts §Write).
 * MCP와 REST 선택은 미정. 공식 MCP 승인 도구는 성공 문구만 반환하므로 `mcp_text` 응답으로 표현한다.
 */
export type TransportReadQuery =
  | { kind: 'pr'; repository: Repository; prNumber: number }
  | { kind: 'files'; repository: Repository; prNumber: number; page: number; perPage: number }
  | { kind: 'check_runs'; repository: Repository; prNumber: number; ref: string; page: number; perPage: number }
  | { kind: 'required_checks'; repository: Repository; baseRef: string }
  | { kind: 'reviews'; repository: Repository; prNumber: number; page: number; perPage: number }
  /** 리뷰의 코드 줄 지적 (REST GET /pulls/{n}/comments). reviews의 본문과 별도로 모은다 */
  | { kind: 'review_comments'; repository: Repository; prNumber: number; page: number; perPage: number }
  | { kind: 'viewer'; repository: Repository };

export interface TransportReadResultMap {
  pr: Omit<PrBasics, 'observedAt'>;
  /** headSha/base는 transport가 실제로 확인한 경우에만 */
  files: { files: { path: string; status: string; additions: number; deletions: number }[]; base?: string; headSha?: string; hasMore: boolean };
  /** MCP는 내부에서 현재 head를 조회하므로 ref 지정이 무시될 수 있다 → resolvedHeadSha로 보고 */
  check_runs: { runs: ChecksData['runs']; resolvedHeadSha?: string; hasMore: boolean };
  /** 조회 실패도 오류가 아니라 이유가 있는 결과로 돌려준다 (none_configured와 구분) */
  required_checks:
    | { state: 'configured'; names: string[]; source: RequiredChecksSource; partial?: boolean; githubUnavailableReason?: RequiredChecksUnknownReason }
    | { state: 'none_configured'; source?: RequiredChecksSource }
    | { state: 'unavailable'; reasonCode: RequiredChecksUnknownReason; detail: string };
  reviews: { reviews: Omit<ReviewItem, 'source'>[]; hasMore: boolean };
  review_comments: { comments: { reviewId: string; path: string; line?: number; body: string; commitSha?: string; severity?: string }[]; hasMore: boolean };
  viewer: { login: string; permission: ViewerPermission };
}

export type TransportSubmitResponse =
  | { kind: 'rest'; reviewId: string; state: string; commitId: string; submittedAt: string; user: string }
  | { kind: 'mcp_text'; text: string };

export type TransportErrorKind = 'auth' | 'not_found' | 'transient' | 'unsupported' | 'invalid' | 'not_sent' | 'no_response';

export class GitHubTransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    message: string,
    readonly proof?: string,
  ) {
    super(message);
  }
}

export interface GitHubTransport {
  readonly mode: 'mcp' | 'rest';
  /** false면 Gateway가 DurableAck를 요청하기 전에 쓰기를 차단한다 (전송하지 않았음이 확실) */
  readonly writesEnabled: boolean;
  read<K extends TransportReadQuery['kind']>(
    query: Extract<TransportReadQuery, { kind: K }>,
    constraints: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<TransportReadResultMap[K]>;
  submitApproval(
    command: { repository: Repository; prNumber: number; commitId: string; event: 'APPROVE'; body?: string },
    constraints: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<TransportSubmitResponse>;
}
