import { describe, expect, it } from 'vitest';
import type { LlmClient, LlmRequest, LlmResponse, McpClientPort } from '@deskpet/contracts';
import { McpGuideRegistry, PipelinePermissionQueue, SwarmWorker } from '@deskpet/harness';
import { constraints, prContext, voiceTurn } from '../../../tests/support/builders.js';

function makeWorker(stepPayload: Record<string, unknown>): SwarmWorker {
  const llm: LlmClient = {
    provider: 'mock',
    async complete(_req: LlmRequest): Promise<LlmResponse> {
      return { text: JSON.stringify(stepPayload), json: stepPayload, model: 'mock' };
    },
  };
  const mcpManager: McpClientPort = {
    listServerIds: () => ['workspace'],
    hasServer: (id: string) => id === 'workspace',
    listTools: async () => [],
    callTool: async () => ({ mcpId: 'workspace', toolName: 'noop', ok: false, content: [], observedAt: new Date(1_700_000_000_000).toISOString() }),
  };
  return new SwarmWorker({
    mcpManager,
    guideRegistry: new McpGuideRegistry(),
    permissionQueue: new PipelinePermissionQueue(async (p) => ({
      pendingId: 'pend-1',
      revision: 1,
      kind: p.kind,
      purpose: p.purpose,
      requiredSlots: p.requiredSlots,
      outputId: 'out-1',
      expiresAt: '2026-11-25T08:00:00.000Z',
      ...(p.scope ? { scope: p.scope } : {}),
    })),
    clock: { nowMs: () => 1_700_000_000_000, nowIso: () => '2026-11-25T07:00:00.000Z' },
    ids: { next: (prefix: string) => `${prefix}-1` },
    llm,
  });
}

async function runFinish(stepPayload: Record<string, unknown>) {
  const worker = makeWorker(stepPayload);
  return worker.run({
    requestId: 'req-sum',
    task: { taskId: 'task-001', goal: '이전 코드 설명', mcpId: 'workspace' },
    turn: voiceTurn('t-sum', '이전의 작성한 코드를 설명해줘'),
    context: prContext(),
    constraints: constraints(),
  });
}

describe('SwarmWorker finish summary fallback', () => {
  it('uses reasoning when kind=finish omits summary', async () => {
    const out = await runFinish({
      kind: 'finish',
      reasoning: 'App.tsx와 overview.tsx를 확인한 결과 대시보드 상태 배지와 이력 뷰가 구현되어 있어요.',
    });
    expect(out.summary.status).toBe('completed');
    expect(out.summary.summary).toBe('App.tsx와 overview.tsx를 확인한 결과 대시보드 상태 배지와 이력 뷰가 구현되어 있어요.');
  });

  it('replaces generic completion filler with displaySummary when available', async () => {
    const out = await runFinish({
      kind: 'finish',
      summary: '작업을 완료했어요.',
      displaySummary: 'App.tsx에서 라우터 설정과 컴포넌트 연결 구조를 확인했어요.',
      reasoning: 'fallback reasoning',
    });
    expect(out.summary.summary).toBe('App.tsx에서 라우터 설정과 컴포넌트 연결 구조를 확인했어요.');
  });

  it('preserves substantive summary as-is', async () => {
    const out = await runFinish({
      kind: 'finish',
      summary: '이전 작업에서는 connect-form.tsx의 연결 폼과 detail-panel.tsx를 작성했어요.',
      reasoning: 'completed explanation',
    });
    expect(out.summary.summary).toBe('이전 작업에서는 connect-form.tsx의 연결 폼과 detail-panel.tsx를 작성했어요.');
  });
});
