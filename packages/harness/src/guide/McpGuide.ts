import type {
  ActionResult,
  CallConstraints,
  ContextPacket,
  CurrentTurnInput,
  ExecutionConstraints,
  McpCallResult,
  McpToolDescriptor,
  PendingView,
  PermissionSpec,
  SourceRef,
  WorkerExecutionSummary,
} from '@deskpet/contracts';

/**
 * GitHub Guide에서 추상화한 범용 MCP Guide 인터페이스.
 *
 * 핵심 원칙:
 * - 신뢰도 기준, 사전 조건, 사용자 허가 필요 여부, 출력 형식 등 모든 제약은
 *   오직 각 MCP의 Guide에 명시된 것만 적용한다.
 * - Guide에 명시되지 않은 임의 제한이나 폐쇄형 도구 목록을 코어가 강제하지 않는다.
 */
export interface GuidePromptContext {
  goal: string;
  mcpId: string;
  turn: CurrentTurnInput;
  context: ContextPacket;
  availableTools: McpToolDescriptor[];
  fastPathTools: FastPathToolDescriptor[];
  wikiExcerpts?: { text: string; ref: string }[];
  workerId: string;
  /** Worker에 할당된 작업 디렉토리 (git worktree 격리 경로 등) */
  workingDir?: string;
}

export interface GuardContext {
  mcpId: string;
  goal: string;
  turn: CurrentTurnInput;
  context: ContextPacket;
  constraints: ExecutionConstraints;
  plannedCall?: PlannedToolCall;
  observations?: Record<string, unknown>;
}

export interface GuardResult {
  allowed: boolean;
  reasons: string[];
  clarifyPrompt?: string;
  clarifyPurpose?: string;
  clarifySlots?: string[];
}

export interface PlannedToolCall {
  mcpId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface WorkerContext {
  requestId: string;
  conversationId: string;
  workerId: string;
  turn: CurrentTurnInput;
  context: ContextPacket;
  constraints: ExecutionConstraints;
  observations: Record<string, unknown>;
  /** Worker에 할당된 작업 디렉토리 (git worktree 격리 경로 등) */
  workingDir?: string;
}

export interface FastPathToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 언제 직접 MCP 도구 호출 대신 이 어댑터를 쓰면 유리한지 설명 */
  efficiencyHint?: string;
}

export interface FastPathToolHandler {
  readonly descriptor: FastPathToolDescriptor;
  execute(
    args: Record<string, unknown>,
    ctx: WorkerContext,
    c: CallConstraints,
  ): Promise<{
    result: McpCallResult;
    facts?: Record<string, unknown>;
    sources?: SourceRef[];
    actionResults?: ActionResult[];
    pending?: PendingView;
  }>;
}

export interface FormattedOutcome {
  summary: string;
  facts?: Record<string, unknown>;
  sources?: SourceRef[];
}

export interface McpGuide {
  readonly mcpId: string;
  readonly version: string;
  readonly description?: string;

  /** 특정 mcpId를 이 Guide가 처리할지 판정 (없으면 mcpId 정확 일치) */
  matches?(mcpId: string): boolean;

  /** Worker/LLM에게 주입할 도메인 지침·도구 사용 전략 템플릿 */
  buildInstructions(ctx: GuidePromptContext): string;

  /** (선택) Guide가 명시한 사전 조건/신뢰도 검사. 미구현 시 제한 없이 통과 */
  evaluateGuards?(ctx: GuardContext): GuardResult;

  /** (선택) Guide가 명시한 사용자 허가 필요 여부. null/미구현 시 Worker가 즉시 실행 */
  requiresPermission?(call: PlannedToolCall, ctx: WorkerContext): PermissionSpec | null;

  /** (선택) 직접 다중 MCP 호출보다 효율적인 경우에만 제공하는 최적화 어댑터 */
  readonly fastPathAdapters?: Record<string, FastPathToolHandler>;

  /** (선택) Worker 실행 결과 포맷팅 힌트 */
  formatOutcome?(result: WorkerExecutionSummary): FormattedOutcome;
}
