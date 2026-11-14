import type { LlmClient, LlmRequest, LlmResponse } from '@deskpet/contracts';

interface HistoryEntry {
  step?: number;
  action?: string;
  tool?: string;
  toolName?: string;
  ok?: boolean;
  error?: string;
  outputPreview?: string;
  permissionDenied?: string;
  verdict?: string;
  guardBlocked?: string[];
}

/**
 * Swarm Coordinator, IntentTriage 및 Worker 루프를 결정론적으로 구동하는 테스트용 스크립트 LLM.
 * 실제 프로덕션의 `llm` / `unclear` 진입과 `GitHubMcpGuide` Fast-Path 도구 호출 시퀀스를 재현한다.
 */
export function createScriptedSwarmLlm(): LlmClient {
  return {
    provider: 'scripted',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const schemaName = req.jsonSchema?.name;

      if (schemaName === 'deskpet_intent_triage') {
        const parsed = safeJson(req.input);
        const userText = typeof parsed['userText'] === 'string' ? parsed['userText'] : '';
        let json: Record<string, unknown>;
        if (/^(안녕|고마워|잘\s*지냈|심심|배고파|졸려|ㅋㅋ|ㅎㅎ|오늘\s*날씨)/.test(userText.trim())) {
          json = { verdict: 'reroute_talk', rationale: 'scripted_casual_talk', missingSlots: [] };
        } else if (/(유레카|eureka|업무\s*목록|할\s*일\s*목록|프로세스)/i.test(userText)) {
          json = {
            verdict: 'direct_eureka',
            rationale: 'scripted_direct_eureka',
            eurekaOperation: /프로세스/.test(userText) ? 'list_processes' : 'list_tasks',
            missingSlots: [],
          };
        } else {
          json = {
            verdict: 'delegate_swarm',
            rationale: 'scripted_swarm_default',
            missingSlots: [],
          };
        }
        return { text: JSON.stringify(json), json, model: 'scripted' };
      }

      if (schemaName === 'deskpet_swarm_plan') {
        const parsed = safeJson(req.input);
        const activeTarget = parsed['activeTarget'] as { kind?: string; mcpId?: string } | null | undefined;
        const servers = Array.isArray(parsed['availableMcpServers'])
          ? (parsed['availableMcpServers'] as string[])
          : [];
        const goal = typeof parsed['goal'] === 'string' ? parsed['goal'] : '';
        const mcpId =
          activeTarget?.kind === 'github_pr'
            ? 'github'
            : activeTarget?.kind === 'mcp_tool' && activeTarget.mcpId
              ? activeTarget.mcpId
              : servers.includes('workspace')
                ? 'workspace'
                : 'github';
        const json = {
          mode: 'single',
          tasks: [{ taskId: 'task-1', goal, ...(mcpId ? { mcpId } : {}) }],
        };
        return { text: JSON.stringify(json), json, model: 'scripted' };
      }

      if (schemaName === 'deskpet_swarm_worker_step') {
        const parsed = safeJson(req.input);
        const goal = typeof parsed['goal'] === 'string' ? parsed['goal'] : '';
        const activeTarget = parsed['activeTarget'] as
          | { kind?: string; repository?: { owner?: string; name?: string }; prNumber?: number }
          | null
          | undefined;
        const observations = (parsed['observations'] as Record<string, unknown> | undefined) ?? {};
        const history = Array.isArray(parsed['executionHistory'])
          ? (parsed['executionHistory'] as HistoryEntry[])
          : [];

        if (observations['declined'] || history.some((h) => h.permissionDenied)) {
          const json = {
            kind: 'finish',
            summary: '사용자 확인 결과 승인을 진행하지 않았어요.',
            displaySummary: '사용자 거부/보류로 중단됨',
            reasoning: 'permission declined by user',
          };
          return { text: JSON.stringify(json), json, model: 'scripted' };
        }

        const isGitHub = activeTarget?.kind === 'github_pr' || /\bPR\b|리뷰|승인|approve/i.test(goal);
        if (isGitHub) {
          const toolNameOf = (h: HistoryEntry) => h.tool ?? h.toolName;
          const reviewEntry = history.find((h) => toolNameOf(h) === 'github_fast_review_context');
          if (!reviewEntry) {
            if (activeTarget?.kind !== 'github_pr') {
              const json = {
                kind: 'need_user',
                questionText: '어떤 저장소와 PR 번호를 확인할까요?',
                reasoning: 'missing target repository or PR number',
              };
              return { text: JSON.stringify(json), json, model: 'scripted' };
            }
            const args = {
              ...(activeTarget.repository?.owner ? { owner: activeTarget.repository.owner } : {}),
              ...(activeTarget.repository?.name ? { repo: activeTarget.repository.name } : {}),
              ...(activeTarget.prNumber ? { prNumber: activeTarget.prNumber } : {}),
            };
            const json = {
              kind: 'call_tool',
              toolName: 'github_fast_review_context',
              mcpId: 'github',
              argumentsJson: JSON.stringify(args),
              reasoning: 'fetch PR review context first',
            };
            return { text: JSON.stringify(json), json, model: 'scripted' };
          }

          if (reviewEntry.ok === false) {
            const json = {
              kind: 'finish',
              summary: reviewEntry.error ?? 'PR 정보를 조회하지 못했어요.',
              displaySummary: reviewEntry.error ?? reviewEntry.outputPreview ?? 'review failed',
              reasoning: 'review context read failed',
            };
            return { text: JSON.stringify(json), json, model: 'scripted' };
          }

          const lastToolOut = (observations['lastToolResult'] as { output?: Record<string, unknown> } | undefined)?.output;
          const reviewObj =
            lastToolOut && typeof lastToolOut === 'object' ? lastToolOut : safeJson(reviewEntry.outputPreview);
          const blockers = Array.isArray((observations['lastReviewFacts'] as Record<string, unknown> | undefined)?.['approvalBlockers'])
            ? ((observations['lastReviewFacts'] as Record<string, unknown>)['approvalBlockers'] as unknown[])
            : Array.isArray(reviewObj['approvalBlockers'])
              ? (reviewObj['approvalBlockers'] as unknown[])
              : [];
          const offerApproval = reviewObj['offerApprovalAfterReview'] === true && blockers.length === 0;
          const wantsApproval = /(승인|approve|lgtm|허가)/i.test(goal) || offerApproval;
          const approveEntry = history.find((h) => toolNameOf(h) === 'github_fast_submit_approval');
          if (wantsApproval && !approveEntry) {
            const lastHeadSha =
              typeof observations['lastHeadSha'] === 'string'
                ? observations['lastHeadSha']
                : safeStringField(reviewEntry.outputPreview, 'headSha');
            const args = {
              ...(activeTarget?.repository?.owner ? { owner: activeTarget.repository.owner } : {}),
              ...(activeTarget?.repository?.name ? { repo: activeTarget.repository.name } : {}),
              ...(activeTarget?.prNumber ? { prNumber: activeTarget.prNumber } : {}),
              ...(lastHeadSha ? { expectedHeadSha: lastHeadSha } : {}),
            };
            const json = {
              kind: 'call_tool',
              toolName: 'github_fast_submit_approval',
              mcpId: 'github',
              argumentsJson: JSON.stringify(args),
              reasoning: 'submit PR approval after review check',
            };
            return { text: JSON.stringify(json), json, model: 'scripted' };
          }

          const json = {
            kind: 'finish',
            summary: approveEntry
              ? approveEntry.ok
                ? 'PR 승인을 완료했어요.'
                : approveEntry.error ?? 'PR 승인 처리에 실패했어요.'
              : 'PR 리뷰 요약을 완료했어요.',
            displaySummary: approveEntry?.outputPreview ?? reviewEntry.outputPreview ?? 'done',
            reasoning: 'completed github workflow',
          };
          return { text: JSON.stringify(json), json, model: 'scripted' };
        }

        const json = {
          kind: 'finish',
          summary: '작업을 완료했어요.',
          displaySummary: goal || 'done',
          reasoning: 'completed task',
        };
        return { text: JSON.stringify(json), json, model: 'scripted' };
      }

      // TTS concise summary / generic prompt
      const parsed = safeJson(req.input);
      const summary = typeof parsed['summary'] === 'string' ? parsed['summary'] : '작업을 완료했어요.';
      return { text: summary.slice(0, 160), model: 'scripted' };
    },
  };
}

function safeJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeStringField(raw: unknown, key: string): string | undefined {
  const obj = safeJson(raw);
  const v = obj[key];
  return typeof v === 'string' && v ? v : undefined;
}
