import { z } from 'zod';

/**
 * 공통 원시 타입.
 * 근거: message-contracts §Envelope and Identity, interface-contracts §2.
 */

export const Id = z.string().min(1).max(200);
export type Id = z.infer<typeof Id>;

/** RFC 3339 UTC 시각 (Z). 시각만으로 순서를 결정하지 않는다 (message-contracts §Envelope). */
export const UtcTimestamp = z.string().datetime();
export type UtcTimestamp = z.infer<typeof UtcTimestamp>;

/** 시간대 오프셋을 허용하는 RFC 3339 (예: Eureka dueAt 표시용 +09:00). */
export const OffsetTimestamp = z.string().datetime({ offset: true });

export const Revision = z.number().int().nonnegative();

export const GitSha = z.string().regex(/^[0-9a-f]{7,40}$/, 'git sha (hex 7~40)');

export const Repository = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
});
export type Repository = z.infer<typeof Repository>;

/** 작업 대상. 대상 종류를 명시해 다른 시스템의 ID를 섞지 않는다. */
export const GitHubPrTarget = z.object({
  kind: z.literal('github_pr'),
  repository: Repository,
  prNumber: z.number().int().positive(),
});
export const EurekaItemTarget = z.object({
  kind: z.literal('eureka_item'),
  itemId: Id,
});
export const EurekaStageTarget = z.object({
  kind: z.literal('eureka_stage'),
  itemId: Id,
  stageId: Id,
});
/** 업무 목록처럼 특정 엔티티가 없는 조회 대상. */
export const EurekaWorkspaceTarget = z.object({ kind: z.literal('eureka_workspace') });
/** 범용 MCP 도구 호출 대상 (폐쇄형 화이트리스트 제한 없음). */
export const McpTarget = z.object({
  kind: z.literal('mcp_tool'),
  mcpId: Id,
  toolName: z.string().min(1).optional(),
  resourceUri: z.string().min(1).optional(),
});

export const Target = z.discriminatedUnion('kind', [
  GitHubPrTarget,
  EurekaItemTarget,
  EurekaStageTarget,
  EurekaWorkspaceTarget,
  McpTarget,
]);
export type Target = z.infer<typeof Target>;
export type GitHubPrTarget = z.infer<typeof GitHubPrTarget>;
export type EurekaStageTarget = z.infer<typeof EurekaStageTarget>;
export type McpTarget = z.infer<typeof McpTarget>;

/**
 * Guide가 제안할 수 있는 허용 기능 식별자 (guide-sensor §Guide Interface, 다이어그램 AllowedAction).
 * 임의 URL·셸·MCP 도구명은 허용하지 않는다.
 */
export const AllowedAction = z.enum([
  'get_review_context',
  'submit_approval',
  'get_approval_outcome',
  'list_tasks',
  'get_task_state',
  'complete_stage',
  'get_change_outcome',
  'mcp_tool_call',
]);
export type AllowedAction = z.infer<typeof AllowedAction>;

/**
 * 직접 Eureka 경로 행위. 계약 미정 (다이어그램 EurekaGateway 주석).
 * Harness `unclear → direct_eureka` 경로에서도 EurekaGateway를 직접 호출할 때 사용한다.
 */
export const DirectEurekaAction = z.enum(['register_item', 'postpone_item', 'complete_item', 'delete_item', 'hold_item', 'resume_item', 'set_stage_status', 'set_item_priority', 'rename_item', 'edit_stages', 'add_stage_note', 'list_processes']);
export type DirectEurekaAction = z.infer<typeof DirectEurekaAction>;

export const ActionName = z.union([AllowedAction, DirectEurekaAction]);
export type ActionName = z.infer<typeof ActionName>;

/** 쓰기 행위 여부. 재시도·dispatch 정책 판정에 사용한다. */
export const WRITE_ACTIONS: ReadonlySet<ActionName> = new Set<ActionName>([
  'submit_approval',
  'complete_stage',
  'register_item',
  'postpone_item',
  'complete_item',
  'delete_item',
  'hold_item',
  'resume_item',
  'set_stage_status',
  'set_item_priority',
  'rename_item',
  'edit_stages',
  'add_stage_note',
]);
export const isWriteAction = (a: ActionName): boolean => WRITE_ACTIONS.has(a);

/** 출처 참조. Wiki·외부 조회·MCP·사용자 턴 등 */
export const SourceRef = z.object({
  kind: z.enum(['wiki', 'github', 'eureka', 'mcp', 'user_turn', 'operation', 'fixture']),
  ref: z.string().min(1),
  observedAt: UtcTimestamp.optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

/** 외부 실행 증거. review ID, MCP 호출 결과 등 (message-contracts §ActionResult). */
export const ExternalRef = z.object({
  system: z.enum(['github', 'eureka', 'mcp']),
  kind: z.string().min(1),
  id: z.string().min(1),
  details: z.record(z.unknown()).optional(),
});
export type ExternalRef = z.infer<typeof ExternalRef>;
