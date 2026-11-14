import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  DeterministicSensor,
  GenericMcpGuide,
  McpGuideRegistry,
  RuleBasedGuide,
  WorkspaceMcpGuide,
  classifyAnswer,
  createDeclarativeMcpGuide,
  writeInputBlockers,
} from '@deskpet/harness';
import { constraints, harnessRequest, prContext, voiceTurn, webTurn, PR, REPO, SHA_A, T0 } from '../../../tests/support/builders.js';
import { createWorld } from '../../../tests/support/world.js';

describe('input policy', () => {
  it('blocks writes on low / unavailable STT confidence and low route confidence independently (C-05)', () => {
    expect(writeInputBlockers(voiceTurn('t', '승인해', { stt: 0.5 }), DEFAULT_POLICY)).toContain('stt_confidence_low');
    expect(writeInputBlockers(voiceTurn('t', '승인해', { stt: 'unavailable' }), DEFAULT_POLICY)).toContain('stt_confidence_unavailable');
    expect(writeInputBlockers(voiceTurn('t', '승인해', { stt: 0.99, routeConfidence: 0.4 }), DEFAULT_POLICY)).toEqual(['route_confidence_low']);
    // 2026-11-08: 라우터 통합 신뢰도 0.53 이상이면 통과
    expect(writeInputBlockers(voiceTurn('t', '승인해', { stt: 0.99, routeConfidence: 0.53 }), DEFAULT_POLICY)).toEqual([]);
    expect(writeInputBlockers(voiceTurn('t', '승인해', { stt: 0.99, routeConfidence: 0.52 }), DEFAULT_POLICY)).toEqual(['route_confidence_low']);
    expect(writeInputBlockers(voiceTurn('t', '승인해', { isFinal: false }), DEFAULT_POLICY)).toContain('turn_not_final');
    expect(writeInputBlockers(webTurn('t', '승인'), DEFAULT_POLICY)).toEqual([]);
  });

  it('classifies answers; reject wins; ambiguity is unclear, never approval', () => {
    expect(classifyAnswer(voiceTurn('t', '응, 승인해'), DEFAULT_POLICY).verdict).toBe('approved');
    expect(classifyAnswer(voiceTurn('t', '아니, 보류해'), DEFAULT_POLICY).verdict).toBe('rejected');
    expect(classifyAnswer(voiceTurn('t', '음… 글쎄'), DEFAULT_POLICY).verdict).toBe('unclear');
    expect(classifyAnswer(voiceTurn('t', '반영해'), DEFAULT_POLICY).verdict).toBe('approved');
    expect(classifyAnswer(voiceTurn('t', 'Eureka에도 반영해 줘'), DEFAULT_POLICY).verdict).toBe('approved');
    expect(classifyAnswer(voiceTurn('t', '반영하지 마'), DEFAULT_POLICY).verdict).toBe('rejected');
    // 2026-11-09 시험 사고: "거절"·영문 자판 오타가 승인으로 처리됨
    expect(classifyAnswer(voiceTurn('t', '거절'), DEFAULT_POLICY).verdict).toBe('rejected');
    expect(classifyAnswer(voiceTurn('t', '거절', { intention: 'confirm.approve' }), DEFAULT_POLICY).verdict).toBe('rejected');
    expect(classifyAnswer(voiceTurn('t', 'rjwjf', { intention: 'confirm.approve' }), DEFAULT_POLICY).verdict).toBe('unclear');
    expect(classifyAnswer(voiceTurn('t', '응', { intention: 'confirm.approve' }), DEFAULT_POLICY).verdict).toBe('approved');
    expect(classifyAnswer(voiceTurn('t', '응 승인해', { stt: 0.4 }), DEFAULT_POLICY).verdict).toBe('unclear');
  });
});

describe('Sensor', () => {
  const sensor = new DeterministicSensor();
  const target = { kind: 'github_pr' as const, repository: { ...REPO }, prNumber: PR };
  const expected = {
    action: 'submit_approval' as const,
    target,
    expectedVersion: { headSha: SHA_A },
    postconditions: [],
    requiredEvidence: [],
    completenessRequirement: { sections: [], allowTruncation: false },
  };
  const input = (g: Record<string, unknown>) => ({
    requestId: 'r',
    operationId: 'op',
    attemptId: 'a',
    executionRevision: 1,
    expectedOutcome: expected,
    actualRequest: {},
    gatewayResult: { externalRefs: [], successTextOnly: false, ...g } as never,
    priorEvidence: { priorReviewIds: ['8001'] },
    executionContext: { cancelled: false, expired: false },
  });

  it('MCP success text only is indeterminate, never confirmed_success', () => {
    const a = sensor.inspect(input({ mode: 'write', dispatchState: 'sent', outcome: 'response', successTextOnly: true, response: { text: 'ok' } }));
    expect(a).toMatchObject({ verdict: 'indeterminate', suggestedActionStatus: 'unknown', followUpNeed: 'reconcile' });
  });

  it('a pre-existing approval is not this submission', () => {
    const a = sensor.inspect(
      input({ mode: 'read', dispatchState: 'sent', outcome: 'response', externalRefs: [{ system: 'github', kind: 'pull_request_review', id: '8001', details: { state: 'APPROVED', commitId: SHA_A } }] }),
    );
    expect(a.verdict).toBe('indeterminate');
  });

  it('linked review with matching SHA is confirmed_success', () => {
    const a = sensor.inspect(
      input({ mode: 'write', dispatchState: 'sent', outcome: 'response', externalRefs: [{ system: 'github', kind: 'pull_request_review', id: '9001', details: { state: 'APPROVED', commitId: SHA_A } }] }),
    );
    expect(a).toMatchObject({ verdict: 'confirmed_success', suggestedActionStatus: 'succeeded' });
  });

  it('response loss is indeterminate + unknown; not_sent with proof is not_executed', () => {
    expect(sensor.inspect(input({ mode: 'write', dispatchState: 'may_have_been_sent', outcome: 'no_response' })).suggestedActionStatus).toBe('unknown');
    expect(sensor.inspect(input({ mode: 'write', dispatchState: 'not_sent', outcome: 'error', notSentProof: 'x' })).verdict).toBe('not_executed');
  });
});

describe('Guide', () => {
  it('asks only for missing target slots instead of guessing (S-01)', () => {
    const g = new RuleBasedGuide(DEFAULT_POLICY);
    const ctx = { ...prContext(), target: undefined };
    const d = g.proposeNext({
      requestId: 'r',
      turnId: 't',
      stateRevision: 1,
      goal: { currentTurn: voiceTurn('t', '그 PR 리뷰해줘'), intent: 'pr.review', allowedScope: [] },
      context: { packet: ctx, wiki: { outcome: 'not_queried', excerpts: [] }, unverified: [] },
      operations: [],
      confirmations: [],
      constraints: { deadlineAt: T0, policyVersion: 'p', maxSteps: 3 },
      facts: {},
    });
    expect(d.kind).toBe('ask_user');
    expect(d.kind === 'ask_user' && d.payload.requiredSlots).toEqual(['repository', 'prNumber']);
  });
});

describe('HarnessService basics', () => {
  it('S-01: unknown target → clarification, zero GitHub calls; answer continues on the same request', async () => {
    const w = createWorld();
    const r1 = await w.harness.handle(harnessRequest('req-1', voiceTurn('t-1', '그 PR 리뷰해줘'), { ...prContext(), target: undefined }));
    expect(r1.disposition).toBe('awaiting_user');
    expect(r1.pending!.kind).toBe('clarification');
    expect(w.github.reads.length).toBe(0);
    const d = await w.deliverQuestion(r1);
    const r2 = await w.harness.resume({
      originalRequestId: 'req-1',
      currentTurn: voiceTurn('t-2', 'DeskPet 42번'),
      context: prContext(2),
      pendingId: d.pendingId,
      expectedPendingRevision: d.revision,
      newCallConstraints: constraints(),
    });
    expect(r2.requestId).toBe('req-1');
    expect(r2.disposition).toBe('completed');
    expect(r2.facts['review']).toMatchObject({ prNumber: PR, headSha: SHA_A });
  });

  it('duplicate turnId returns the stored result without re-executing', async () => {
    const w = createWorld();
    const req = harnessRequest('req-1', voiceTurn('t-1', 'PR 42 리뷰해줘'));
    const a = await w.harness.handle(req);
    const reads = w.github.reads.length;
    const b = await w.harness.handle(req);
    expect(b).toEqual(a);
    expect(w.github.reads.length).toBe(reads);
  });

  it('rejects invalid requests before execution', async () => {
    const w = createWorld();
    const bad = harnessRequest('req-1', { ...voiceTurn('t-1', 'x'), inputChannel: 'fax' as never });
    const r = await w.harness.handle(bad);
    expect(r.disposition).toBe('failed');
    expect(r.processingErrors[0]!.provisionalCode).toBe('INVALID_INPUT');
    expect(w.github.reads.length).toBe(0);
  });

  it('answer before question delivery is not accepted', async () => {
    const w = createWorld();
    await w.harness.handle(harnessRequest('req-0', voiceTurn('t-0', 'PR 42 리뷰해줘')));
    const r1 = await w.harness.handle(harnessRequest('req-1', voiceTurn('t-1', '그 PR 승인해줘', { intention: 'llm' })));
    expect(r1.pending!.kind).toBe('confirmation');
    const r2 = await w.harness.resume({
      originalRequestId: 'req-1',
      currentTurn: voiceTurn('t-2', '응 승인해', { intention: 'confirm.approve' }),
      context: prContext(),
      pendingId: r1.pending!.pendingId,
      expectedPendingRevision: 0,
      confirmationId: r1.pending!.confirmationId!,
      newCallConstraints: constraints(),
    });
    expect(r2.facts['answerNotAccepted']).toBe('question_not_delivered');
    expect(w.github.submitCount).toBe(0);
  });

  it('pipeline event gap blocks resume execution', async () => {
    const w = createWorld();
    await w.harness.handle(harnessRequest('req-0', voiceTurn('t-0', 'PR 42 리뷰해줘')));
    const r1 = await w.harness.handle(harnessRequest('req-1', voiceTurn('t-1', '승인해줘', { intention: 'llm' })));
    const d = await w.deliverQuestion(r1);
    // revision 3을 건너뛰고 4가 도착 → gap
    const gap = await w.harness.onPipelineEvent({ messageId: 'm-x', requestId: 'req-1', sourceRevision: 3, occurredAt: T0, kind: 'speech_started', pendingId: d.pendingId });
    expect(gap).toEqual({ applied: false, reason: 'gap' });
    const r2 = await w.harness.resume({
      originalRequestId: 'req-1',
      currentTurn: voiceTurn('t-2', '응 승인해'),
      context: prContext(),
      pendingId: d.pendingId,
      expectedPendingRevision: d.revision,
      confirmationId: d.confirmationId!,
      newCallConstraints: constraints(),
    });
    expect(r2.disposition).toBe('failed');
    expect(w.github.submitCount).toBe(0);
  });

  it('question_wait_expired expires the confirmation; late answer does nothing', async () => {
    const w = createWorld();
    await w.harness.handle(harnessRequest('req-0', voiceTurn('t-0', 'PR 42 리뷰해줘')));
    const r1 = await w.harness.handle(harnessRequest('req-1', voiceTurn('t-1', '승인해줘', { intention: 'llm' })));
    const d = await w.deliverQuestion(r1);
    await w.pipelineEvent('req-1', 'question_wait_expired', { pendingId: d.pendingId, outputId: r1.pending!.outputId });
    expect((await w.store.getConfirmation(d.confirmationId!))!.state).toBe('expired');
    const r2 = await w.harness.resume({
      originalRequestId: 'req-1',
      currentTurn: voiceTurn('t-2', '응 승인해'),
      context: prContext(),
      pendingId: d.pendingId,
      expectedPendingRevision: d.revision,
      confirmationId: d.confirmationId!,
      newCallConstraints: constraints(),
    });
    expect(r2.facts['answerNotAccepted']).toBeDefined();
    expect(w.github.submitCount).toBe(0);
  });

  it('cancel revokes waiting confirmation', async () => {
    const w = createWorld();
    await w.harness.handle(harnessRequest('req-0', voiceTurn('t-0', 'PR 42 리뷰해줘')));
    const r1 = await w.harness.handle(harnessRequest('req-1', voiceTurn('t-1', '승인해줘', { intention: 'llm' })));
    const c = await w.harness.cancel({ requestId: 'req-1', reason: 'user_cancel' });
    expect(c.revokedPendings).toEqual([r1.pending!.pendingId]);
    expect((await w.store.getConfirmation(r1.pending!.confirmationId!))!.state).toBe('revoked');
  });
});

describe('Universal McpGuide Registry & WorkspaceMcpGuide', () => {
  it('resolves declarative guides by mcpId and falls back to GenericMcpGuide without arbitrary blocks', () => {
    const custom = createDeclarativeMcpGuide({
      mcpId: 'slack',
      description: 'Slack 메시지 요약 Guide',
      instructions: ['채널 메시지를 요약하세요.'],
    });
    const registry = new McpGuideRegistry([custom]);
    expect(registry.resolve('slack').mcpId).toBe('slack');
    expect(registry.resolve('unknown_mcp')).toBeInstanceOf(GenericMcpGuide);
    const prompt = registry.resolve('slack').buildInstructions({
      mcpId: 'slack',
      workerId: 'wrk-1',
      goal: '요약',
      turn: voiceTurn('t', '슬랙 봐줘'),
      context: prContext(),
      availableTools: [{ mcpId: 'slack', name: 'list_channels', qualifiedName: 'slack::list_channels', description: 'channels', inputSchema: {} }],
      fastPathTools: [],
    });
    expect(prompt).toContain('Slack 메시지 요약 Guide');
    expect(prompt).toContain('list_channels');
  });

  it('WorkspaceMcpGuide requires permission only for destructive commands (rm -rf, git reset --hard, etc.)', () => {
    const stubWs = { defaultRoot: '/repo' } as never;
    const guide = new WorkspaceMcpGuide({ workspace: stubWs });
    const ctx = {
      requestId: 'r-1',
      conversationId: 'conv-1',
      workerId: 'wrk-w1',
      mcpId: 'workspace',
      goal: 'edit',
      turn: voiceTurn('t', '고쳐줘'),
      context: prContext(),
      constraints: { deadlineAt: T0, maxPages: 1, maxResultBytes: 1024, policyVersion: '1' },
      observations: {},
    };

    expect(
      guide.requiresPermission({ mcpId: 'workspace', toolName: 'workspace_edit_file', arguments: { path: 'a.ts', target: 'x', replacement: 'y' } }, ctx),
    ).toBeNull();
    expect(
      guide.requiresPermission({ mcpId: 'workspace', toolName: 'workspace_run_command', arguments: { command: 'pnpm test' } }, ctx),
    ).toBeNull();

    const perm = guide.requiresPermission(
      { mcpId: 'workspace', toolName: 'workspace_run_command', arguments: { command: 'rm -rf tmp-old' } },
      ctx,
    );
    expect(perm?.kind).toBe('confirmation');
    expect(perm?.purpose).toBe('confirm_destructive_command');
  });
});
