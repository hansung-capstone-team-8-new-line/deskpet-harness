import {
  confirmationTokens,
  type ConfirmationScope,
  type GitHubReviewGatewayPort,
  type McpCallResult,
  type PermissionSpec,
  type Repository,
  type ReviewContext,
  type WorkerExecutionSummary,
} from '@deskpet/contracts';
import { reviewFacts } from '../facts.js';
import { DEFAULT_POLICY, type PolicyConfig } from '../policy/config.js';
import { approvalRequestBlockers } from '../policy/inputPolicy.js';
import type { Clock, IdGen } from '../runtime/clock.js';
import type { DispatchAuthoritySource } from './fastPathDispatch.js';
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

export interface GitHubMcpGuideOptions {
  gateway?: GitHubReviewGatewayPort;
  dispatchSource?: DispatchAuthoritySource;
  config?: PolicyConfig;
  clock?: Clock;
  ids?: IdGen;
}

const GITHUB_WRITE_TOOL_RE = /(submit_approval|create_.*review|approve|merge_pull_request|github_fast_submit_approval)/i;

/**
 * GitHub MCP 연동 레퍼런스 Guide 1호.
 *
 * 기존 GitHub 전용 Guide/Policy/Gateway 로직을 범용 McpGuide 템플릿 구현으로 캡슐화한다:
 * - 신뢰도 검사·승인 확인 토큰 등 GitHub 특유 제약은 오직 이 Guide에 명시된 조건에서만 적용한다.
 * - GitHubReviewGateway의 병렬 PR 묶음 조회·REST 승인 제출을 선택적 Fast-Path 어댑터로 노출한다.
 * - 별도 GitHub MCP 서버의 원시 도구(`tools/list`) 호출도 가로막지 않고 함께 허용한다.
 */
export class GitHubMcpGuide extends BaseMcpGuide {
  readonly mcpId = 'github';
  readonly version = 'github-template-1.0';
  override readonly description = 'GitHub PR 리뷰 조회·승인 및 저장소 작업을 수행하는 레퍼런스 Guide';
  override readonly fastPathAdapters: Record<string, FastPathToolHandler>;

  private readonly cfg: PolicyConfig;

  constructor(private readonly opts: GitHubMcpGuideOptions = {}) {
    super();
    this.cfg = opts.config ?? DEFAULT_POLICY;
    this.fastPathAdapters = buildGitHubFastPaths(opts);
  }

  override matches(mcpId: string): boolean {
    return mcpId.toLowerCase().includes('github');
  }

  protected override domainHeader(): string {
    return '역할: GitHub PR 리뷰 자료 조회, 검토 요약, PR 승인(사용자 확인 시) 및 저장소 MCP 도구를 직접 실행합니다.';
  }

  protected override domainRules(ctx: GuidePromptContext): string[] {
    const rules = [
      '저장소(owner/name)와 PR 번호를 추측하지 마세요. 문맥(context.target 또는 taskRefs)에 없으면 사용자에게 확인을 요청하세요.',
      'PR 리뷰 요약 시 변경 파일 수·증감 줄 수, 필수 검사 상태, Copilot/리뷰어 코멘트, 관찰된 head SHA를 정확히 보고하세요.',
      'PR 승인(submit_approval 등 쓰기)은 반드시 head SHA가 확인된 뒤 Guide 확인 절차(requiresPermission)를 거쳐 실행하세요.',
      'PR 기본+변경+검사+리뷰를 한 번에 읽을 때는 여러 도구를 순차 호출하는 대신 `github_fast_review_context` Fast-Path 도구를 우선 활용하면 효율적입니다.',
    ];
    if (this.cfg.offerApprovalAfterReview) {
      rules.push(
        '리뷰 조회 결과 approvalBlockers가 비어 있으면 리뷰를 마치고 `github_fast_submit_approval`을 호출해 Guide 확인 절차를 통해 사용자에게 승인 여부를 물어보세요.',
      );
    }
    if (ctx.context.target?.kind === 'github_pr') {
      const t = ctx.context.target;
      rules.push(`현재 문맥 PR 대상: ${t.repository.owner}/${t.repository.name}#${t.prNumber}`);
    }
    return rules;
  }

  /**
   * GitHub Guide에 명시된 쓰기 가드:
   * 읽기/조회 작업은 제한 없이 통과시키고, 승인/쓰기 계획일 때만 입력 신뢰도 기준을 검사한다.
   */
  override evaluateGuards(ctx: GuardContext): GuardResult {
    const tool = ctx.plannedCall?.toolName;
    if (!tool || !GITHUB_WRITE_TOOL_RE.test(tool)) {
      return { allowed: true, reasons: [] };
    }
    const blockers = approvalRequestBlockers(ctx.turn, this.cfg);
    if (blockers.length > 0) {
      return {
        allowed: false,
        reasons: blockers,
        clarifyPurpose: 'restate_write_command',
        clarifyPrompt: "승인 명령을 정확히 듣지 못했어요. 승인하려면 '승인해'라고 다시 말해 주세요.",
      };
    }
    const lastErr = ctx.observations?.['lastReviewError'];
    if (typeof lastErr === 'string' && lastErr) {
      return { allowed: false, reasons: [lastErr] };
    }
    const lastFacts = ctx.observations?.['lastReviewFacts'] as { approvalBlockers?: string[] } | undefined;
    if (lastFacts?.approvalBlockers?.length) {
      return {
        allowed: false,
        reasons: lastFacts.approvalBlockers,
      };
    }
    return { allowed: true, reasons: [] };
  }

  /**
   * GitHub Guide에 명시된 사용자 허가 규칙:
   * PR 승인 또는 파괴적 GitHub 쓰기 도구 실행 전에만 사용자 확인을 요구한다.
   */
  override requiresPermission(call: PlannedToolCall, ctx: WorkerContext): PermissionSpec | null {
    if (!GITHUB_WRITE_TOOL_RE.test(call.toolName)) return null;
    const args = call.arguments;
    const repoObj = extractRepo(args, ctx);
    const prNumber = typeof args['prNumber'] === 'number'
      ? args['prNumber']
      : ctx.context.target?.kind === 'github_pr'
        ? ctx.context.target.prNumber
        : undefined;
    const headSha =
      (typeof args['expectedHeadSha'] === 'string' && args['expectedHeadSha']) ||
      (typeof args['commitId'] === 'string' && args['commitId']) ||
      (typeof ctx.observations['lastHeadSha'] === 'string' ? ctx.observations['lastHeadSha'] : undefined);

    if (!repoObj || !prNumber || !headSha) {
      return {
        kind: 'clarification',
        purpose: 'clarify_github_approval_target',
        questionText: '승인할 GitHub 저장소, PR 번호, 현재 커밋 SHA를 정확히 확인해 주세요.',
        requiredSlots: [
          ...(!repoObj ? ['repository'] : []),
          ...(!prNumber ? ['prNumber'] : []),
          ...(!headSha ? ['headSha'] : []),
        ],
      };
    }

    const scope: ConfirmationScope = {
      action: 'submit_approval',
      target: { kind: 'github_pr', repository: repoObj, prNumber },
      headSha,
      exactChange: { event: 'APPROVE', commitId: headSha },
    };
    const tokens = confirmationTokens(scope);
    const lastReview = ctx.observations?.['lastReviewFacts'];
    return {
      kind: 'confirmation',
      purpose: 'confirm_pr_approval',
      questionText: `${tokens[0]}을 승인할까요?`,
      scope,
      tokens,
      ...(lastReview ? { facts: { review: lastReview } } : {}),
    };
  }

  override formatOutcome(result: WorkerExecutionSummary): FormattedOutcome {
    const data = result.data as Record<string, unknown> | undefined;
    return {
      summary: result.summary,
      ...(data?.['review'] ? { facts: { review: data['review'] } } : {}),
    };
  }
}

function buildGitHubFastPaths(opts: GitHubMcpGuideOptions): Record<string, FastPathToolHandler> {
  const gw = opts.gateway;
  if (!gw) return {};
  const nowIso = () => opts.clock?.nowIso() ?? new Date().toISOString();

  return {
    github_fast_review_context: {
      descriptor: {
        name: 'github_fast_review_context',
        description: 'PR 기본 정보, 변경 파일, 필수 검사(checks), 리뷰/Copilot 코멘트를 1회 병렬 호출로 묶어 조회합니다.',
        efficiencyHint: '개별 MCP get_pr/get_files/get_checks/get_reviews 순차 호출 대신 1회로 묶어 지연시간과 토큰을 절약합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string' },
            repo: { type: 'string' },
            prNumber: { type: 'integer' },
            expectedHeadSha: { type: 'string' },
            requestedSections: { type: 'array', items: { type: 'string' } },
          },
          required: ['prNumber'],
        },
      },
      async execute(args, ctx, c) {
        const repo = extractRepo(args, ctx);
        const prNumber =
          typeof args['prNumber'] === 'number'
            ? args['prNumber']
            : ctx.context.target?.kind === 'github_pr'
              ? ctx.context.target.prNumber
              : undefined;
        if (!repo || !prNumber) {
          const failResult: McpCallResult = {
            mcpId: 'github',
            toolName: 'github_fast_review_context',
            ok: false,
            content: [],
            isError: true,
            error: 'owner/repo and prNumber are required',
            observedAt: nowIso(),
            usedFastPath: true,
          };
          return { result: failResult };
        }
        const rawSections = Array.isArray(args['requestedSections'])
          ? args['requestedSections'].filter((s): s is 'changes' | 'checks' | 'reviews' =>
              s === 'changes' || s === 'checks' || s === 'reviews',
            )
          : (['changes', 'checks', 'reviews'] as ('changes' | 'checks' | 'reviews')[]);

        const purpose = /(승인|approve|lgtm|허가)/i.test(ctx.turn.rawText) ? 'approval_precheck' : 'review';
        if (opts.dispatchSource?.executeGitHubReview) {
          const rev = await opts.dispatchSource.executeGitHubReview(
            {
              requestId: ctx.requestId,
              target: { kind: 'github_pr', repository: repo, prNumber },
              requestedSections: rawSections,
              purpose,
              ...(typeof args['expectedHeadSha'] === 'string' ? { expectedHeadSha: args['expectedHeadSha'] } : {}),
            },
            c,
          );
          const facts = rev.review;
          if (facts?.headSha) ctx.observations['lastHeadSha'] = facts.headSha;
          if (facts) {
            ctx.observations['lastReviewFacts'] = facts;
            delete ctx.observations['lastReviewError'];
          } else if (rev.error) {
            ctx.observations['lastReviewError'] = rev.error;
          }
          const ok = Boolean(facts);
          const obsAt = nowIso();
          const result: McpCallResult = {
            mcpId: 'github',
            toolName: 'github_fast_review_context',
            ok,
            content: [
              {
                type: 'text',
                text: facts ? JSON.stringify(facts) : rev.actionResult?.error?.message ?? rev.error ?? 'PR review read failed',
              },
            ],
            ...(facts
              ? {
                  structuredContent: {
                    ...(facts as unknown as Record<string, unknown>),
                    ...(opts.config?.offerApprovalAfterReview ? { offerApprovalAfterReview: true } : {}),
                  },
                }
              : {}),
            isError: !ok,
            ...(!ok && (rev.actionResult?.error?.message ?? rev.error)
              ? { error: rev.actionResult?.error?.message ?? rev.error }
              : {}),
            observedAt: obsAt,
            usedFastPath: true,
          };
          return {
            result,
            ...(facts || rev.error
              ? {
                  facts: {
                    ...(facts ? { review: facts } : {}),
                    ...(rev.error ? { reviewError: rev.error } : {}),
                    ...(opts.config?.offerApprovalAfterReview ? { offerApprovalAfterReview: true } : {}),
                  },
                }
              : {}),
            actionResults: rev.actionResult ? [rev.actionResult] : [],
            sources: [{ kind: 'github', ref: `${repo.owner}/${repo.name}#${prNumber}`, observedAt: obsAt }],
          };
        }

        const reviewCtx: ReviewContext = await gw.getReviewContext(
          {
            repository: repo,
            prNumber,
            requestedSections: rawSections,
            ...(typeof args['expectedHeadSha'] === 'string' ? { expectedHeadSha: args['expectedHeadSha'] } : {}),
            deadlineAt: c.deadlineAt,
          },
          c,
        );
        const facts = reviewCtx.prBasics ? reviewFacts(reviewCtx) : undefined;
        if (facts?.headSha) ctx.observations['lastHeadSha'] = facts.headSha;
        if (facts) ctx.observations['lastReviewFacts'] = facts;
        const ok = Boolean(reviewCtx.prBasics);
        const result: McpCallResult = {
          mcpId: 'github',
          toolName: 'github_fast_review_context',
          ok,
          content: [
            {
              type: 'text',
              text: facts ? JSON.stringify(facts) : reviewCtx.error?.message ?? 'PR review read failed',
            },
          ],
          ...(facts
            ? {
                structuredContent: {
                  ...(facts as unknown as Record<string, unknown>),
                  ...(opts.config?.offerApprovalAfterReview ? { offerApprovalAfterReview: true } : {}),
                },
              }
            : {}),
          isError: !ok,
          ...(reviewCtx.error ? { error: reviewCtx.error.message } : {}),
          observedAt: nowIso(),
          usedFastPath: true,
        };
        return {
          result,
          ...(facts
            ? {
                facts: {
                  review: facts,
                  ...(opts.config?.offerApprovalAfterReview ? { offerApprovalAfterReview: true } : {}),
                },
              }
            : {}),
          sources: [{ kind: 'github', ref: `${repo.owner}/${repo.name}#${prNumber}`, observedAt: result.observedAt }],
        };
      },
    },

    ...(opts.dispatchSource
      ? {
          github_fast_submit_approval: {
            descriptor: {
              name: 'github_fast_submit_approval',
              description: '확인된 PR commit SHA에 대해 GitHub APPROVE 리뷰를 제출하고 reviewId와 commit 증거를 반환합니다.',
              efficiencyHint: 'REST 리뷰 생성 응답의 review ID와 commit SHA 증거를 단일 호출로 확보합니다.',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: { type: 'string' },
                  repo: { type: 'string' },
                  prNumber: { type: 'integer' },
                  expectedHeadSha: { type: 'string' },
                },
                required: ['prNumber', 'expectedHeadSha'],
              },
            },
            async execute(args, ctx, c) {
              const repo = extractRepo(args, ctx);
              const prNumber =
                typeof args['prNumber'] === 'number'
                  ? args['prNumber']
                  : ctx.context.target?.kind === 'github_pr'
                    ? ctx.context.target.prNumber
                    : undefined;
              const expectedHeadSha =
                (typeof args['expectedHeadSha'] === 'string' && args['expectedHeadSha']) ||
                (typeof ctx.observations['lastHeadSha'] === 'string' ? ctx.observations['lastHeadSha'] : undefined);
              if (!repo || !prNumber || !expectedHeadSha) {
                return {
                  result: {
                    mcpId: 'github',
                    toolName: 'github_fast_submit_approval',
                    ok: false,
                    content: [],
                    isError: true,
                    error: 'owner/repo, prNumber, expectedHeadSha are required',
                    observedAt: nowIso(),
                    usedFastPath: true,
                  },
                };
              }
              if (opts.dispatchSource?.executeGitHubApproval) {
                const hr = await opts.dispatchSource.executeGitHubApproval(
                  {
                    requestId: ctx.requestId,
                    target: { kind: 'github_pr', repository: repo, prNumber },
                    expectedHeadSha,
                  },
                  c,
                );
                const ar = hr.actionResults.find((a) => a.action === 'submit_approval');
                const ok = ar?.status === 'succeeded';
                const errText = ar?.error?.message ?? hr.processingErrors[0]?.message;
                return {
                  result: {
                    mcpId: 'github',
                    toolName: 'github_fast_submit_approval',
                    ok,
                    content: [{ type: 'text', text: JSON.stringify(hr.facts['approval'] ?? hr.facts['assessmentPending'] ?? { status: ar?.status ?? hr.disposition }) }],
                    structuredContent: hr.facts,
                    isError: !ok,
                    ...(errText && !ok ? { error: errText } : {}),
                    observedAt: nowIso(),
                    usedFastPath: true,
                  },
                  facts: hr.facts,
                  actionResults: hr.actionResults,
                  ...(hr.pending ? { pending: hr.pending } : {}),
                  sources: [{ kind: 'github', ref: `${repo.owner}/${repo.name}#${prNumber}`, observedAt: nowIso() }],
                };
              }

              const dispatch = await opts.dispatchSource!.acquireHandle(
                {
                  requestId: ctx.requestId,
                  action: 'submit_approval',
                  target: { kind: 'github_pr', repository: repo, prNumber },
                  actualRequest: { repository: repo, prNumber, commitId: expectedHeadSha },
                },
                c,
              );
              const gr = await gw.submitApproval(
                {
                  operationId: dispatch.operationId,
                  confirmationId: opts.ids?.next('conf') ?? `conf-${dispatch.operationId}`,
                  repository: repo,
                  prNumber,
                  expectedHeadSha,
                },
                dispatch.handle,
                c,
              );
              const ok = gr.outcome === 'response';
              return {
                result: {
                  mcpId: 'github',
                  toolName: 'github_fast_submit_approval',
                  ok,
                  content: [{ type: 'text', text: JSON.stringify(gr.response ?? gr.error ?? { outcome: gr.outcome }) }],
                  ...(gr.response ? { structuredContent: gr.response } : {}),
                  isError: !ok,
                  ...(gr.error ? { error: gr.error.message } : {}),
                  observedAt: nowIso(),
                  usedFastPath: true,
                },
                ...(ok
                  ? {
                      facts: {
                        approval: {
                          status: 'succeeded',
                          headSha: expectedHeadSha,
                          repository: `${repo.owner}/${repo.name}`,
                          prNumber,
                          reviewId: gr.externalRefs.find((r) => r.kind === 'pull_request_review')?.id,
                        },
                      },
                    }
                  : {}),
                sources: [{ kind: 'github', ref: `${repo.owner}/${repo.name}#${prNumber}`, observedAt: nowIso() }],
              };
            },
          },
        }
      : {}),
  };
}

function extractRepo(args: Record<string, unknown>, ctx: WorkerContext): Repository | undefined {
  if (typeof args['owner'] === 'string' && typeof args['repo'] === 'string') {
    return { owner: args['owner'], name: args['repo'] };
  }
  if (typeof args['repository'] === 'string' && args['repository'].includes('/')) {
    const [owner, name] = args['repository'].split('/');
    if (owner && name) return { owner, name };
  }
  const repObj = args['repository'] as { owner?: unknown; name?: unknown } | undefined;
  if (typeof repObj?.owner === 'string' && typeof repObj?.name === 'string') {
    return { owner: repObj.owner, name: repObj.name };
  }
  if (ctx.context.target?.kind === 'github_pr') return ctx.context.target.repository;
  const linked = ctx.context.taskRefs.find((r) => r.repository);
  return linked?.repository;
}
