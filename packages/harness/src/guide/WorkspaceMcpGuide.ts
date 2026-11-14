import type {
  CallConstraints,
  PermissionSpec,
  WorkspaceGatewayPort,
  WorkerExecutionSummary,
} from '@deskpet/contracts';
import { BaseMcpGuide } from './BaseMcpGuide.js';
import type {
  FastPathToolHandler,
  FormattedOutcome,
  GuardContext,
  GuardResult,
  GuidePromptContext,
  PlannedToolCall,
  WorkerContext,
} from './McpGuide.js';

export interface WorkspaceMcpGuideOptions {
  workspace: WorkspaceGatewayPort;
  /** true이면 격리된 worktree 내 파일 수정/생성도 매번 사용자 확인을 요청한다 (기본 false) */
  confirmFileWrites?: boolean;
}

const MATCHED_MCP_IDS = new Set(['workspace', 'filesystem', 'coding', 'code', 'local', 'git']);

const DESTRUCTIVE_COMMAND_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|\s)rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s/i, reason: '재귀 삭제(rm -r, rm -rf)' },
  { pattern: /\bsudo\b/i, reason: '관리자 권한 명령(sudo)' },
  { pattern: /\bgit\s+push\s+(--force|-f)\b/i, reason: '강제 원격 푸시(git push --force)' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: '강제 작업 트리 초기화(git reset --hard)' },
  { pattern: /\b(mkfs|dd\s+if=|shutdown|reboot|chmod\s+-R\s+777)\b/i, reason: '고위험 시스템 명령' },
];

const DESTRUCTIVE_COMMAND_PATTERN = new RegExp(
  DESTRUCTIVE_COMMAND_PATTERNS.map((p) => p.pattern.source).join('|'),
  'i',
);

const WRITE_FILE_TOOL_NAMES = new Set([
  'workspace_edit_file',
  'workspace_write_file',
  'edit_file',
  'write_file',
]);

const RUN_COMMAND_TOOL_NAMES = new Set(['workspace_run_command', 'run_command']);

/**
 * 헤드리스 바이브 코딩용 로컬 워크스페이스 Guide 템플릿 (`workspace`).
 *
 * - 읽기·검색·Diff 확인은 제한 없이 즉시 실행한다.
 * - 파일 수정(`workspace_edit_file`, `workspace_write_file`)과 명령 실행(`workspace_run_command`)은
 *   Coordinator가 할당한 `git worktree`(또는 워크스페이스 루트) 안에서 수행하며,
 *   이 Guide에 명시된 조건(파괴적 셸 명령 등)에 한해서만 사용자 허가를 요구한다.
 */
export class WorkspaceMcpGuide extends BaseMcpGuide {
  readonly mcpId = 'workspace';
  readonly version = 'workspace-1.0';
  override readonly description = '코드베이스 탐색·파일 읽기·부분 수정·테스트/빌드 실행을 수행하는 헤드리스 바이브 코딩 Guide';
  override readonly fastPathAdapters: Record<string, FastPathToolHandler>;

  constructor(private readonly opts: WorkspaceMcpGuideOptions) {
    super();
    this.fastPathAdapters = buildWorkspaceFastPaths(opts.workspace);
  }

  override matches(mcpId: string): boolean {
    return MATCHED_MCP_IDS.has(mcpId.toLowerCase());
  }

  protected override domainRules(ctx: GuidePromptContext): string[] {
    const dirLabel = ctx.workingDir ?? this.opts.workspace.defaultRoot;
    return [
      `작업 디렉토리: ${dirLabel} (모든 상대 경로는 이 디렉토리 기준)`,
      '수정 전에 먼저 `workspace_find_files` 또는 `workspace_search_code`로 위치를 찾고 `workspace_read_file`로 필요한 줄 범위만 읽으세요.',
      '파일 수정은 가급적 전체 덮어쓰기 대신 정확한 `target` → `replacement` 부분 치환(`workspace_edit_file`)을 사용하세요.',
      '코드 수정 후에는 가능한 경우 `workspace_run_command`로 타입체크·린트·관련 테스트를 실행해 검증하세요.',
      '최종 `summary`는 음성 TTS 출력용으로 1~2문장 이내의 간결한 한국어로 요약하고, 긴 코드·diff·로그 원문을 그대로 넣지 마세요.',
    ];
  }

  override evaluateGuards(ctx: GuardContext): GuardResult {
    const call = ctx.plannedCall;
    if (!call) return { allowed: true, reasons: [] };

    const args = call.arguments;
    if (
      ['workspace_read_file', 'workspace_edit_file', 'workspace_write_file'].includes(call.toolName) &&
      typeof args['path'] !== 'string'
    ) {
      return {
        allowed: false,
        reasons: ['missing_file_path'],
        clarifyPrompt: '확인하거나 수정할 파일 경로를 조금 더 구체적으로 말씀해 주시겠어요?',
      };
    }

    if (call.toolName === 'workspace_run_command' && typeof args['command'] !== 'string') {
      return {
        allowed: false,
        reasons: ['missing_command'],
        clarifyPrompt: '실행할 명령어를 말씀해 주세요.',
      };
    }

    return { allowed: true, reasons: [] };
  }

  override requiresPermission(call: PlannedToolCall, _ctx: WorkerContext): PermissionSpec | null {
    if (RUN_COMMAND_TOOL_NAMES.has(call.toolName)) {
      const command = String(call.arguments['command'] ?? '').trim();
      const matched = DESTRUCTIVE_COMMAND_PATTERNS.find((p) => p.pattern.test(command));
      if (matched || DESTRUCTIVE_COMMAND_PATTERN.test(command)) {
        return {
          kind: 'confirmation',
          purpose: 'confirm_destructive_command',
          questionText: `위험할 수 있는 명령(${matched?.reason ?? '시스템/삭제 명령'})을 실행해야 해요. '${command.slice(0, 80)}'를 실행할까요?`,
          tokens: ['실행할까요'],
        };
      }
      return null;
    }

    if (this.opts.confirmFileWrites && WRITE_FILE_TOOL_NAMES.has(call.toolName)) {
      const filePath = String(call.arguments['path'] ?? '대상 파일');
      return {
        kind: 'confirmation',
        purpose: 'confirm_workspace_write',
        questionText: `${filePath} 파일을 수정할까요?`,
        tokens: [filePath],
      };
    }

    return null;
  }

  override formatOutcome(result: WorkerExecutionSummary): FormattedOutcome {
    const changed = result.changedFiles ?? [];
    const displaySummary =
      result.displaySummary ??
      (changed.length > 0 ? `${result.summary} (변경 파일: ${changed.slice(0, 6).join(', ')})` : result.summary);
    return {
      summary: result.summary,
      facts: {
        workspace: {
          mcpId: result.mcpId,
          displaySummary,
          changedFiles: changed,
          ...(result.worktreeConflicts?.length ? { conflicts: result.worktreeConflicts } : {}),
        },
      },
    };
  }
}

function buildWorkspaceFastPaths(ws: WorkspaceGatewayPort): Record<string, FastPathToolHandler> {
  const sourceRef = (tool: string, observedAt: string) => ({ kind: 'mcp' as const, ref: `workspace::${tool}`, observedAt });
  const nowIso = () => new Date().toISOString();

  return {
    workspace_find_files: {
      descriptor: {
        name: 'workspace_find_files',
        description: '워크스페이스 내 파일 목록을 글롭(glob) 패턴으로 탐색합니다.',
        efficiencyHint: '경로를 모를 때 전체 탐색 대신 빠르게 관련 파일만 찾습니다.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '예: *.ts, src/**/*.tsx' },
            subdir: { type: 'string', description: '검색 시작 하위 디렉토리' },
            maxResults: { type: 'number' },
          },
        },
      },
      execute: async (args, ctx: WorkerContext, c: CallConstraints) => {
        const res = await ws.findFiles(
          {
            ...(typeof args['pattern'] === 'string' ? { pattern: args['pattern'] } : {}),
            ...(typeof args['subdir'] === 'string' ? { subdir: args['subdir'] } : {}),
            ...(typeof args['maxResults'] === 'number' ? { maxResults: args['maxResults'] } : {}),
            ...(ctx.workingDir ? { workingDir: ctx.workingDir } : {}),
          },
          c,
        );
        const observedAt = nowIso();
        return {
          result: {
            mcpId: 'workspace',
            toolName: 'workspace_find_files',
            ok: res.ok,
            content: [{ type: 'text', text: res.ok ? res.files.join('\n') || '(일치하는 파일 없음)' : (res.error ?? 'find_files failed') }],
            structuredContent: res as unknown as Record<string, unknown>,
            ...(res.error ? { error: res.error, isError: true } : {}),
            observedAt,
            usedFastPath: true,
          },
          sources: [sourceRef('workspace_find_files', observedAt)],
        };
      },
    },

    workspace_search_code: {
      descriptor: {
        name: 'workspace_search_code',
        description: '코드베이스에서 문자열 또는 정규식으로 함수·클래스·심볼 위치를 검색합니다.',
        efficiencyHint: '파일을 통째로 읽지 않고 필요한 줄 번호를 먼저 찾습니다.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            subdir: { type: 'string' },
            regex: { type: 'boolean' },
            glob: { type: 'string' },
            maxMatches: { type: 'number' },
          },
          required: ['query'],
        },
      },
      execute: async (args, ctx: WorkerContext, c: CallConstraints) => {
        const res = await ws.searchCode(
          {
            query: String(args['query'] ?? ''),
            ...(typeof args['subdir'] === 'string' ? { subdir: args['subdir'] } : {}),
            ...(typeof args['regex'] === 'boolean' ? { regex: args['regex'] } : {}),
            ...(typeof args['glob'] === 'string' ? { glob: args['glob'] } : {}),
            ...(typeof args['maxMatches'] === 'number' ? { maxMatches: args['maxMatches'] } : {}),
            ...(ctx.workingDir ? { workingDir: ctx.workingDir } : {}),
          },
          c,
        );
        const observedAt = nowIso();
        return {
          result: {
            mcpId: 'workspace',
            toolName: 'workspace_search_code',
            ok: res.ok,
            content: [{ type: 'text', text: res.ok ? res.matches.join('\n') || '(검색 결과 없음)' : (res.error ?? 'search_code failed') }],
            structuredContent: res as unknown as Record<string, unknown>,
            ...(res.error ? { error: res.error, isError: true } : {}),
            observedAt,
            usedFastPath: true,
          },
          sources: [sourceRef('workspace_search_code', observedAt)],
        };
      },
    },

    workspace_read_file: {
      descriptor: {
        name: 'workspace_read_file',
        description: '파일의 특정 줄 범위(startLine~endLine, 줄 번호 포함)를 읽습니다.',
        efficiencyHint: '큰 파일도 필요한 범위만 읽어 컨텍스트를 절약합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            startLine: { type: 'number' },
            endLine: { type: 'number' },
          },
          required: ['path'],
        },
      },
      execute: async (args, ctx: WorkerContext, c: CallConstraints) => {
        const res = await ws.readFile(
          {
            path: String(args['path'] ?? ''),
            ...(typeof args['startLine'] === 'number' ? { startLine: args['startLine'] } : {}),
            ...(typeof args['endLine'] === 'number' ? { endLine: args['endLine'] } : {}),
            ...(ctx.workingDir ? { workingDir: ctx.workingDir } : {}),
          },
          c,
        );
        const observedAt = nowIso();
        const header = res.ok
          ? `[${res.path} lines ${res.startLine}-${res.endLine} / ${res.totalLines}${res.truncated ? ' (더 있음)' : ''}]\n${res.content}`
          : (res.error ?? 'read_file failed');
        return {
          result: {
            mcpId: 'workspace',
            toolName: 'workspace_read_file',
            ok: res.ok,
            content: [{ type: 'text', text: header }],
            structuredContent: res as unknown as Record<string, unknown>,
            ...(res.error ? { error: res.error, isError: true } : {}),
            observedAt,
            usedFastPath: true,
          },
          sources: [sourceRef('workspace_read_file', observedAt)],
        };
      },
    },

    workspace_edit_file: {
      descriptor: {
        name: 'workspace_edit_file',
        description: '기존 파일에서 정확한 target 문자열을 replacement로 부분 치환합니다.',
        efficiencyHint: '전체 파일을 덮어쓰지 않고 안전하게 변경 구간만 수정합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            target: { type: 'string', description: '공백·줄바꿈 포함 원본 문자열' },
            replacement: { type: 'string' },
            replaceAll: { type: 'boolean' },
          },
          required: ['path', 'target', 'replacement'],
        },
      },
      execute: async (args, ctx: WorkerContext, c: CallConstraints) => {
        const res = await ws.editFile(
          {
            path: String(args['path'] ?? ''),
            target: String(args['target'] ?? ''),
            replacement: String(args['replacement'] ?? ''),
            ...(typeof args['replaceAll'] === 'boolean' ? { replaceAll: args['replaceAll'] } : {}),
            ...(ctx.workingDir ? { workingDir: ctx.workingDir } : {}),
          },
          c,
        );
        const observedAt = nowIso();
        return {
          result: {
            mcpId: 'workspace',
            toolName: 'workspace_edit_file',
            ok: res.ok,
            content: [
              {
                type: 'text',
                text: res.ok
                  ? `수정 완료 (${res.path}, ${res.replacements}건 치환)\n${res.snippet ?? ''}`
                  : (res.error ?? 'edit_file failed'),
              },
            ],
            structuredContent: res as unknown as Record<string, unknown>,
            ...(res.error ? { error: res.error, isError: true } : {}),
            observedAt,
            usedFastPath: true,
          },
          sources: [sourceRef('workspace_edit_file', observedAt)],
        };
      },
    },

    workspace_write_file: {
      descriptor: {
        name: 'workspace_write_file',
        description: '새 파일을 생성하거나 overwrite=true일 때 파일 전체 내용을 기록합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            overwrite: { type: 'boolean' },
          },
          required: ['path', 'content'],
        },
      },
      execute: async (args, ctx: WorkerContext, c: CallConstraints) => {
        const res = await ws.writeFile(
          {
            path: String(args['path'] ?? ''),
            content: String(args['content'] ?? ''),
            ...(typeof args['overwrite'] === 'boolean' ? { overwrite: args['overwrite'] } : {}),
            ...(ctx.workingDir ? { workingDir: ctx.workingDir } : {}),
          },
          c,
        );
        const observedAt = nowIso();
        return {
          result: {
            mcpId: 'workspace',
            toolName: 'workspace_write_file',
            ok: res.ok,
            content: [{ type: 'text', text: res.ok ? `저장 완료 (${res.path}, ${res.bytesWritten}B)` : (res.error ?? 'write_file failed') }],
            structuredContent: res as unknown as Record<string, unknown>,
            ...(res.error ? { error: res.error, isError: true } : {}),
            observedAt,
            usedFastPath: true,
          },
          sources: [sourceRef('workspace_write_file', observedAt)],
        };
      },
    },

    workspace_git_status: {
      descriptor: {
        name: 'workspace_git_status',
        description: '현재 작업 트리(또는 할당된 worktree)의 변경 파일 목록을 확인합니다.',
        inputSchema: { type: 'object', properties: {} },
      },
      execute: async (_args, ctx: WorkerContext, c: CallConstraints) => {
        const res = await ws.gitStatus(ctx.workingDir ? { workingDir: ctx.workingDir } : undefined, c);
        const observedAt = nowIso();
        return {
          result: {
            mcpId: 'workspace',
            toolName: 'workspace_git_status',
            ok: res.ok,
            content: [{ type: 'text', text: res.ok ? res.summary : (res.error ?? 'git_status failed') }],
            structuredContent: res as unknown as Record<string, unknown>,
            ...(res.error ? { error: res.error, isError: true } : {}),
            observedAt,
            usedFastPath: true,
          },
          sources: [sourceRef('workspace_git_status', observedAt)],
        };
      },
    },

    workspace_git_diff: {
      descriptor: {
        name: 'workspace_git_diff',
        description: '현재 작업 트리(또는 할당된 worktree)의 diff를 확인합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            staged: { type: 'boolean' },
            path: { type: 'string' },
          },
        },
      },
      execute: async (args, ctx: WorkerContext, c: CallConstraints) => {
        const res = await ws.gitDiff(
          {
            ...(typeof args['staged'] === 'boolean' ? { staged: args['staged'] } : {}),
            ...(typeof args['path'] === 'string' ? { path: args['path'] } : {}),
            ...(ctx.workingDir ? { workingDir: ctx.workingDir } : {}),
          },
          c,
        );
        const observedAt = nowIso();
        return {
          result: {
            mcpId: 'workspace',
            toolName: 'workspace_git_diff',
            ok: res.ok,
            content: [{ type: 'text', text: res.ok ? res.diff || '(변경 없음)' : (res.error ?? 'git_diff failed') }],
            structuredContent: res as unknown as Record<string, unknown>,
            ...(res.error ? { error: res.error, isError: true } : {}),
            observedAt,
            usedFastPath: true,
          },
          sources: [sourceRef('workspace_git_diff', observedAt)],
        };
      },
    },

    workspace_run_command: {
      descriptor: {
        name: 'workspace_run_command',
        description: '작업 디렉토리 안에서 타입체크·린트·테스트·빌드 등 셸 명령을 실행합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeoutMs: { type: 'number' },
          },
          required: ['command'],
        },
      },
      execute: async (args, ctx: WorkerContext, c: CallConstraints) => {
        const res = await ws.runCommand(
          {
            command: String(args['command'] ?? ''),
            ...(typeof args['timeoutMs'] === 'number' ? { timeoutMs: args['timeoutMs'] } : {}),
            ...(ctx.workingDir ? { workingDir: ctx.workingDir } : {}),
          },
          c,
        );
        const observedAt = nowIso();
        const combined = [
          `exit=${String(res.exitCode)}${res.timedOut ? ' (timeout)' : ''}`,
          res.stdout ? `[stdout]\n${res.stdout}` : '',
          res.stderr ? `[stderr]\n${res.stderr}` : '',
          res.error ? `[error]\n${res.error}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          result: {
            mcpId: 'workspace',
            toolName: 'workspace_run_command',
            ok: res.ok,
            content: [{ type: 'text', text: combined }],
            structuredContent: res as unknown as Record<string, unknown>,
            ...(res.error ? { error: res.error, isError: true } : {}),
            observedAt,
            usedFastPath: true,
          },
          sources: [sourceRef('workspace_run_command', observedAt)],
        };
      },
    },
  };
}
