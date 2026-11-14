import { z } from 'zod';
import { Id, UtcTimestamp } from './common.js';
import type { ConfirmationScope } from './records.js';

/**
 * 범용 MCP · IntentTriage · Agent Swarm · PipelinePermissionQueue 개방형 계약.
 * 폐쇄형 enum으로 신규 MCP 도구 사용을 막지 않으며, Guide가 명시하지 않은 임의 제한을 두지 않는다.
 */

export const McpTransportKind = z.enum(['stdio', 'streamable_http']);
export type McpTransportKind = z.infer<typeof McpTransportKind>;

export const McpServerConfig = z.object({
  mcpId: Id,
  transport: McpTransportKind,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const McpToolDescriptor = z.object({
  mcpId: Id,
  name: z.string().min(1),
  /** `<mcpId>::<name>` 형식 또는 단일 식별자 */
  qualifiedName: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).default({ type: 'object', properties: {} }),
});
export type McpToolDescriptor = z.infer<typeof McpToolDescriptor>;

export const McpCallRequest = z.object({
  mcpId: Id,
  toolName: z.string().min(1),
  arguments: z.record(z.unknown()).default({}),
  operationId: Id.optional(),
  deadlineAt: UtcTimestamp.optional(),
});
export type McpCallRequest = z.infer<typeof McpCallRequest>;

export const McpContentBlock = z
  .object({
    type: z.string().min(1),
    text: z.string().optional(),
  })
  .passthrough();
export type McpContentBlock = z.infer<typeof McpContentBlock>;

export const McpCallResult = z.object({
  mcpId: Id,
  toolName: z.string().min(1),
  ok: z.boolean(),
  content: z.array(McpContentBlock).default([]),
  structuredContent: z.record(z.unknown()).optional(),
  isError: z.boolean().optional(),
  error: z.string().optional(),
  observedAt: UtcTimestamp,
  usedFastPath: z.boolean().optional(),
});
export type McpCallResult = z.infer<typeof McpCallResult>;

// ---------------------------------------------------------------- IntentTriage
/**
 * Router에서 `unclear`가 넘어왔을 때의 분기 결과.
 * - clarify: 의도 파악 불가 → 재질문
 * - reroute_talk: 일상 대화 → 자연스러운 대화 응답 반환 (`facts.reroute = 'talk'`)
 * - direct_eureka: 유레카 프로세스 조작 → Harness의 Eureka 직접 조작 실행
 * - delegate_swarm: 코딩 / MCP / 추론 작업 → 병렬 실행 Worker 합류
 */
export const TriageVerdict = z.enum(['clarify', 'reroute_talk', 'direct_eureka', 'delegate_swarm']);
export type TriageVerdict = z.infer<typeof TriageVerdict>;

export const DirectEurekaOperation = z.enum([
  'list_tasks',
  'get_task_state',
  'list_processes',
  'check_session',
  'register_item',
  'postpone_item',
  'complete_item',
  'delete_item',
  'hold_item',
  'resume_item',
  'set_item_priority',
  'rename_item',
  'set_stage_status',
  'add_stage',
  'delete_stage',
  'move_stage_up',
  'move_stage_down',
  'add_stage_note',
]);
export type DirectEurekaOperation = z.infer<typeof DirectEurekaOperation>;

export const TriageResult = z.object({
  verdict: TriageVerdict,
  rationale: z.string().default(''),
  clarifyQuestion: z.string().optional(),
  talkReply: z.string().optional(),
  missingSlots: z.array(z.string()).default([]),
  eurekaOperation: DirectEurekaOperation.optional(),
  eurekaArgs: z.record(z.unknown()).optional(),
  swarmGoal: z.string().optional(),
});
export type TriageResult = z.infer<typeof TriageResult>;

// ------------------------------------------------------ Agent Swarm & Queue
export interface PermissionSpec {
  kind: 'clarification' | 'confirmation';
  purpose: string;
  questionText: string;
  requiredSlots?: string[];
  /** confirmation인 경우 확인 범위 (없으면 McpTarget 기반 기본 범위 생성) */
  scope?: ConfirmationScope;
  /** Guide가 명시한 확인 문구 포함 토큰 (명시 없으면 questionText 기준) */
  tokens?: string[];
  /** 질문 시 출력 체인에 함께 넘길 보조 사실 (예: review 경고 등) */
  facts?: Record<string, unknown>;
}

export interface PermissionRequest {
  workerId: string;
  mcpId: string;
  toolName: string;
  spec: PermissionSpec;
}

export interface PermissionResolution {
  approved: boolean;
  verdict: 'approved' | 'rejected' | 'unclear' | 'clarified' | 'expired' | 'revoked';
  answerText: string;
  turnId: string;
  rationale: string;
  resolvedAt: string;
  updatedContext?: import('./harness.js').ContextPacket;
  updatedTurn?: import('./harness.js').CurrentTurnInput;
}

export interface SwarmTask {
  taskId: string;
  goal: string;
  mcpId?: string;
  dependsOn?: string[];
  hints?: Record<string, unknown>;
}

export interface WorkerExecutionSummary {
  workerId: string;
  taskId: string;
  mcpId: string;
  status: 'completed' | 'awaiting_permission' | 'failed' | 'blocked';
  /** TTS 출력에 바로 쓰기 적합한 간결한 요약문 */
  summary: string;
  /** 화면/웹 UI용 상세 요약 (선택) */
  displaySummary?: string;
  toolCalls: {
    toolName: string;
    arguments: Record<string, unknown>;
    ok: boolean;
    usedFastPath?: boolean;
    summary?: string;
  }[];
  changedFiles?: string[];
  worktreeConflicts?: string[];
  data?: unknown;
  error?: string;
  interrupted?: boolean;
  lastActivity?: string;
  blockedReasons?: string[];
}

/**
 * 긴 실행 결과/코드 요약 문자열을 음성 TTS 출력용 간결한 문장으로 정제·요약한다.
 * 마크다운 코드 블록·인라인 백틱·URL·불필요한 공백을 제거하고 maxChars 안에 맞춰 문장 경계에서 줄인다.
 */
export function condenseTtsText(text: string, maxChars = 180): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^[-*#>]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  const suffix = ' 자세한 내용은 화면을 확인해 주세요.';
  const budget = Math.max(40, maxChars - suffix.length);
  const head = cleaned.slice(0, budget);
  const lastEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('다.'), head.lastIndexOf('요.'));
  const cut =
    lastEnd >= Math.floor(budget * 0.45)
      ? head.slice(0, lastEnd + (head[lastEnd] === '.' ? 1 : 2))
      : head.trimEnd();
  return `${cut}${suffix}`;
}
