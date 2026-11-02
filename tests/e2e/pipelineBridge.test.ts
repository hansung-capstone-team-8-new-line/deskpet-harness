import { describe, expect, it } from 'vitest';
import { PipelineHarnessResult, parseEnvelope, type PipelineHarnessRequest } from '@deskpet/contracts';
import { OutputService } from '@deskpet/output';
import { DirectHarnessInbound, PipelineBridge } from '@deskpet/server';
import { ITEM_ID, PR, REPO, SHA_A, STAGE_ID } from '../support/builders.js';
import { createWorld } from '../support/world.js';

/**
 * 파이프라인 문서 형식(HarnessAdapter.run)으로 G-01을 끝까지 통과한다. docs/pipeline-bridge.md
 */
const DEADLINE = '2026-10-04T10:05:00.000Z';
const PR_TARGET = { kind: 'github_pr', repository: { ...REPO }, prNumber: PR };
const TASK_REFS = [{ itemId: ITEM_ID, stageId: STAGE_ID, repository: { ...REPO }, prNumber: PR, source: { kind: 'eureka', ref: `item:${ITEM_ID}` } }];

let n = 0;
function run(text: string, o: { requestId?: string; intention?: string; mutationApproved?: boolean; stt?: number } = {}): PipelineHarnessRequest {
  n += 1;
  const transcript = { text, isFinal: true, sttConfidence: o.stt ?? 0.95 };
  return {
    action: {
      requestId: o.requestId ?? `REQ-${n}`,
      operationId: `OP-${n}`,
      decision: {
        headOutputs: { intention: { value: o.intention ?? null, confidence: 0.95 } },
        overallConfidence: 0.95,
        missingRequiredSlots: [],
        route: 'harness',
        resolvedTarget: PR_TARGET,
      },
      deadlineAt: DEADLINE,
    },
    transcript,
    context: { requestId: o.requestId ?? `REQ-${n}`, turnId: `TURN-${n}`, transcript, stamp: { conversationId: 'conv-1' }, turns: [] },
    wikiSearchAllowed: false,
    mutationApproved: o.mutationApproved ?? false,
    // 문서에 없는 확장: Eureka 업무 연결
    taskRefs: TASK_REFS,
  } as PipelineHarnessRequest;
}

function setup() {
  const w = createWorld();
  const bridge = new PipelineBridge({ harness: w.harness, store: w.store, output: new OutputService() });
  let seq = 0;
  /** 파이프라인이 질문을 말한 뒤 보고한다 (문서에 없음 → 기존 pipeline.event) */
  async function delivered(r: PipelineHarnessResult, spoken = r.question!) {
    const f = r.action.facts;
    const ev = await w.harness.onPipelineEvent({ messageId: `ev-${++seq}`, requestId: f['harnessRequestId']!, pendingId: f['pendingId']!, outputId: f['outputId']!, sourceRevision: seq, occurredAt: w.clock.nowIso(), kind: 'question_delivered', channel: 'speech', deliveredText: spoken });
    expect(ev).toMatchObject({ applied: true });
  }
  return { w, bridge, delivered };
}

describe('파이프라인 문서 형식 — HarnessAdapter.run', () => {
  it('G-01: 리뷰 → 승인 질문 → 승인 답변(mutationApproved) → Eureka 확인 질문 → 반영', async () => {
    const { w, bridge, delivered } = setup();

    const review = PipelineHarnessResult.parse(await bridge.run(run('그 PR 리뷰해줘', { intention: 'pr.review' })));
    expect(review.action.status).toBe('succeeded');
    expect(review.resultText).toContain('PR 42번');
    expect(review.question).toBeNull();

    const ask = PipelineHarnessResult.parse(await bridge.run(run('좋아, 그 PR 승인해줘', { intention: 'pr.approve', requestId: 'REQ-APPROVE' })));
    expect(ask.action).toMatchObject({ operationId: expect.stringMatching(/^OP-/), status: 'needs_clarification', facts: { questionKind: 'confirmation' } });
    expect(ask.question).toBe(`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}을 승인할까요?`);
    expect(w.github.submitCount).toBe(0);

    // 출력 모델은 requiredText를 지키고, 파이프라인이 실제로 말한 문장을 보고한다
    const spoken = await bridge.generate({ requestId: 'REQ-APPROVE', outputId: 'OUT-1', action: ask.action, requiredText: ask.question!, isQuestion: true });
    expect(spoken).toContain(`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}`);
    await delivered(ask, spoken);

    const approved = PipelineHarnessResult.parse(await bridge.run(run('응, 승인해', { intention: 'confirm.approve', requestId: 'REQ-APPROVE', mutationApproved: true })));
    expect(w.github.submitCount).toBe(1);
    // 승인 성공 뒤 Eureka 반영은 별도 확인 질문
    expect(approved.action).toMatchObject({ status: 'needs_clarification', facts: { action: 'submit_approval', questionPurpose: 'confirm_stage_completion' } });
    expect(approved.question).toContain("Eureka의 'PR 승인' 단계를 완료로 반영할까요?");
    await delivered(approved);

    const done = PipelineHarnessResult.parse(await bridge.run(run('네', { intention: 'confirm.approve', requestId: 'REQ-APPROVE', mutationApproved: true })));
    expect(done.action).toMatchObject({ status: 'succeeded', facts: { action: 'complete_stage' } });
    expect(w.eurekaServer.writeCount('/')).toBe(1);
  });

  it('mutationApproved=false면 "응"이어도 쓰지 않고 다시 묻는다', async () => {
    const { w, bridge, delivered } = setup();
    await bridge.run(run('리뷰해줘', { intention: 'pr.review' }));
    const ask = await bridge.run(run('승인해줘', { intention: 'pr.approve', requestId: 'REQ-A' }));
    await delivered(ask);
    const r = await bridge.run(run('응', { intention: 'confirm.approve', requestId: 'REQ-A', mutationApproved: false }));
    expect(w.github.submitCount).toBe(0);
    expect(r.action.status).toBe('needs_clarification');
  });

  it('질문 전달 보고가 없으면 답을 받지 않는다', async () => {
    const { w, bridge } = setup();
    await bridge.run(run('리뷰해줘', { intention: 'pr.review' }));
    await bridge.run(run('승인해줘', { intention: 'pr.approve', requestId: 'REQ-B' }));
    const r = await bridge.run(run('응', { intention: 'confirm.approve', requestId: 'REQ-B', mutationApproved: true }));
    expect(w.github.submitCount).toBe(0);
    expect(r.action.status).not.toBe('succeeded');
  });

  it('대기 질문이 있어도 다른 업무 요청이 오면 그 질문을 철회해, 뒤이은 "네"가 이전 승인에 붙지 않는다', async () => {
    const { w, bridge, delivered } = setup();
    await bridge.run(run('리뷰해줘', { intention: 'pr.review' }));
    const ask = await bridge.run(run('승인해줘', { intention: 'pr.approve', requestId: 'REQ-C' }));
    await delivered(ask);
    await bridge.run(run('PR 다시 리뷰해줘', { intention: 'pr.review', requestId: 'REQ-D' }));
    expect(await w.store.listWaitingPendingsByConversation('conv-1')).toHaveLength(0);
    await bridge.run(run('네', { intention: 'confirm.approve', requestId: 'REQ-E', mutationApproved: true }));
    expect(w.github.submitCount).toBe(0);
  });

  it('응답 유실은 unknown, reconcile은 다시 보내지 않고 조회로만 확인한다', async () => {
    const { w, bridge, delivered } = setup();
    await bridge.run(run('리뷰해줘', { intention: 'pr.review' }));
    const ask = await bridge.run(run('승인해줘', { intention: 'pr.approve', requestId: 'REQ-U' }));
    await delivered(ask);
    w.github.failNextSubmit('drop_after_apply');
    const r = await bridge.run(run('응, 승인해', { intention: 'confirm.approve', requestId: 'REQ-U', mutationApproved: true }));
    expect(r.action.status).toBe('unknown');
    expect(r.resultText).not.toMatch(/승인했어요/);
    const rec = await bridge.reconcile({ requestId: 'REQ-U', operationId: 'OP-RECON', decision: run('x').action.decision, deadlineAt: DEADLINE });
    // 리뷰 후보만 있고 인과 연결이 없으면 unknown을 유지한다 (기존 S-07 규칙). 어떤 경우에도 다시 보내지 않는다
    expect(rec).toMatchObject({ operationId: 'OP-RECON', status: 'unknown', facts: { action: 'submit_approval' } });
    expect(w.github.submitCount).toBe(1);
  });

  it('출력 모델: 성공하지 않은 결과는 기준 문장을 그대로, 범위 문구를 바꾼 모델 문장은 버린다', async () => {
    const { bridge } = setup();
    const unknown = { operationId: 'OP-X', status: 'unknown' as const, facts: {} };
    expect(await bridge.generate({ requestId: 'R', outputId: 'O', action: unknown, requiredText: '결과를 확인하지 못했어요.', isQuestion: false })).toBe('결과를 확인하지 못했어요.');

    const w = createWorld();
    const tricky = new PipelineBridge({ harness: w.harness, store: w.store, output: new OutputService({ model: { generate: async () => ({ text: 'Other/Repo PR 42번을 승인할까요?' }) } }) });
    const q = `NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}을 승인할까요?`;
    const facts = { pendingId: 'p', requiredMeaning: [`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}`, '승인'].join('\n') };
    expect(await tricky.generate({ requestId: 'R', outputId: 'O', action: { operationId: 'OP', status: 'needs_clarification', facts }, requiredText: q, isQuestion: true })).toBe(q);
  });
});

describe('파이프라인 문서 형식 — 봉투·수신 층', () => {
  it('harness.run 봉투를 검증하고 harness.run.result로 답한다. 봉투 requestId와 action.requestId가 다르면 거부', async () => {
    const w = createWorld();
    const output = new OutputService();
    const inbound = new DirectHarnessInbound({ harness: w.harness, output, bridge: new PipelineBridge({ harness: w.harness, store: w.store, output }) });
    const payload = run('그 PR 리뷰해줘', { intention: 'pr.review', requestId: 'REQ-ENV' });
    const env = { schemaVersion: '1.0', messageId: 'm-env-1', kind: 'harness.run', requestId: 'REQ-ENV', createdAt: '2026-10-04T10:00:00.000Z', deadlineAt: DEADLINE, payload };
    const parsed = parseEnvelope(env);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const reply = await inbound.dispatch(parsed.value);
    expect(reply.kind).toBe('harness.run.result');
    expect(PipelineHarnessResult.parse(reply.payload).action.status).toBe('succeeded');
    expect(parseEnvelope({ ...env, requestId: 'REQ-OTHER' }).ok).toBe(false);
    // bridge가 없는 서버는 받지 않는다
    expect(new DirectHarnessInbound({ harness: w.harness, output }).kinds.has('harness.run')).toBe(false);
  });
});

describe('파이프라인 문서 형식 — 팀 문서 발췌 전달', () => {
  it('facts.wikiExcerpts(JSON 문자열)를 output.generate가 출력 모델 입력의 팀 문서 발췌로 넘긴다', async () => {
    const w = createWorld();
    let prompt = '';
    const output = new OutputService({ model: { generate: async (i) => ((prompt = i.prompt), { text: '팀 문서에 따르면 음성 업무 관리 기기예요. PR 42번 리뷰를 마쳤어요.' }) } });
    const bridge = new PipelineBridge({ harness: w.harness, store: w.store, output });
    const facts = { wikiExcerpts: JSON.stringify([{ text: 'DeskPet은 음성 업무 관리 기기다.', ref: 'wiki/deskpet-architecture.md#Summary' }]) };
    const text = await bridge.generate({ requestId: 'R', outputId: 'O', action: { operationId: 'OP', status: 'succeeded', facts }, requiredText: 'PR 42번 리뷰를 마쳤어요.', isQuestion: false });
    expect(prompt).toContain('[wiki/deskpet-architecture.md#Summary]');
    expect(text).toContain('팀 문서에 따르면');
  });
});
