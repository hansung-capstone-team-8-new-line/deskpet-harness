import { z } from 'zod';
import { Id, UtcTimestamp } from './common.js';
/**
 * 범용 MCP · IntentTriage · Agent Swarm · PipelinePermissionQueue 개방형 계약.
 * 폐쇄형 enum으로 신규 MCP 도구 사용을 막지 않으며, Guide가 명시하지 않은 임의 제한을 두지 않는다.
 */
export const McpTransportKind = z.enum(['stdio', 'streamable_http']);
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
export const McpToolDescriptor = z.object({
    mcpId: Id,
    name: z.string().min(1),
    /** `<mcpId>::<name>` 형식 또는 단일 식별자 */
    qualifiedName: z.string().min(1),
    description: z.string().optional(),
    inputSchema: z.record(z.unknown()).default({ type: 'object', properties: {} }),
});
export const McpCallRequest = z.object({
    mcpId: Id,
    toolName: z.string().min(1),
    arguments: z.record(z.unknown()).default({}),
    operationId: Id.optional(),
    deadlineAt: UtcTimestamp.optional(),
});
export const McpContentBlock = z
    .object({
    type: z.string().min(1),
    text: z.string().optional(),
})
    .passthrough();
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
// ---------------------------------------------------------------- IntentTriage
/**
 * Router에서 `unclear`가 넘어왔을 때의 분기 결과.
 * - clarify: 의도 파악 불가 → 재질문
 * - reroute_talk: 일상 대화 → 자연스러운 대화 응답 반환 (`facts.reroute = 'talk'`)
 * - direct_eureka: 유레카 프로세스 조작 → Harness의 Eureka 직접 조작 실행
 * - delegate_swarm: 코딩 / MCP / 추론 작업 → 병렬 실행 Worker 합류
 */
export const TriageVerdict = z.enum(['clarify', 'reroute_talk', 'direct_eureka', 'delegate_swarm']);
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
/**
 * 긴 실행 결과/코드 요약 문자열을 음성 TTS 출력용 간결한 문장으로 정제·요약한다.
 * 마크다운 코드 블록·인라인 백틱·URL·불필요한 공백을 제거하고 maxChars 안에 맞춰 문장 경계에서 줄인다.
 */
export function condenseTtsText(text, maxChars = 180) {
    const cleaned = text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/^[-*#>]+\s*/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (cleaned.length <= maxChars)
        return cleaned;
    const suffix = ' 자세한 내용은 화면을 확인해 주세요.';
    const budget = Math.max(40, maxChars - suffix.length);
    const head = cleaned.slice(0, budget);
    const lastEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('다.'), head.lastIndexOf('요.'));
    const cut = lastEnd >= Math.floor(budget * 0.45)
        ? head.slice(0, lastEnd + (head[lastEnd] === '.' ? 1 : 2))
        : head.trimEnd();
    return `${cut}${suffix}`;
}
