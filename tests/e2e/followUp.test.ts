import { describe, expect, it } from 'vitest';
import type { FollowUpNotice, HarnessResult } from '@deskpet/contracts';
import { RecoveryWorker } from '@deskpet/harness';
import { fallbackText, mapHarnessResult } from '@deskpet/output';
import { STAGE_ID, harnessRequest, voiceTurn } from '../support/builders.js';
import { answer, askApproval, review } from '../support/flows.js';
import { ControllableSensor } from '../support/sensor.js';
import { createWorld } from '../support/world.js';

/**
 * D-23 후속 작업: Eureka 반영을 잠깐 기다린 뒤 응답, 늦게 끝나면 알림 / 명시적 실패 다시 하기 / 주기 복구
 */
const stagePost = `/_api_/stages/${STAGE_ID}/status`;

/** 리뷰 → 승인 → Eureka 질문까지 진행하고 질문 결과를 돌려준다 */
async function untilEurekaQuestion(w: ReturnType<typeof createWorld>): Promise<HarnessResult> {
  await review(w);
  const q = await askApproval(w);
  const approved = await answer(w, q, '응, 승인해');
  expect(w.github.submitCount).toBe(1);
  expect(approved.pending?.purpose).toBe('confirm_stage_completion');
  return approved;
}

function retryRequest(turnId: string, text = 'Eureka 다시 반영해줘', o: { stt?: number } = {}) {
  return harnessRequest(`req-retry-${turnId}`, voiceTurn(turnId, text, { intention: 'eureka.retry', ...(o.stt !== undefined ? { stt: o.stt } : {}) }));
}

describe('Eureka 반영 — 잠깐 기다렸다가 응답 (D-23)', () => {
  it('기다리는 시간 안에 끝나면 지금처럼 결과를 바로 준다 (알림 없음)', async () => {
    const notices: FollowUpNotice[] = [];
    const w = createWorld({ onFollowUp: (n) => notices.push(n) });
    const q = await untilEurekaQuestion(w);
    const done = await answer(w, q, '네');
    expect(done.actionResults[0]).toMatchObject({ action: 'complete_stage', status: 'succeeded' });
    await w.harness.drainBackground();
    expect(notices).toHaveLength(0);
  });

  it('늦으면 "진행 중"으로 먼저 답하고, 끝난 결과는 알림으로 한 번 보낸다. 전송은 한 번뿐', async () => {
    const notices: FollowUpNotice[] = [];
    const w = createWorld({ onFollowUp: (n) => notices.push(n), config: { followUpReplyWaitMs: 20 } });
    const q = await untilEurekaQuestion(w);
    w.eurekaServer.injectFault((r) => r.method === 'POST' && r.path === stagePost, { kind: 'delay', ms: 150 });
    const r = await answer(w, q, '네');
    expect(r.actionResults).toHaveLength(0);
    expect(r.facts['stageCompletion']).toMatchObject({ status: 'in_progress', stageId: STAGE_ID });
    expect(fallbackText(mapHarnessResult(r)).text).toContain("'PR 승인' 단계 반영을 진행하고 있어요. 끝나면 알려 드릴게요.");
    await w.harness.drainBackground();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ source: 'late_completion', action: 'complete_stage', status: 'succeeded', requestId: r.requestId });
    expect(fallbackText(mapHarnessResult(notices[0]!.result)).text).toContain("Eureka의 'PR 승인' 단계를 완료로 반영했어요.");
    expect(w.eurekaServer.writeCount('/_api_/stages')).toBe(1);
  });
});

describe('S-09: 명시적으로 실패한 Eureka 반영 다시 하기 — "다시 해줘"를 동의로 (D-23)', () => {
  it('실패 → 다시 해줘 → 새 작업으로 한 번 더 보내고 성공. GitHub 승인은 다시 하지 않는다', async () => {
    const w = createWorld();
    const q = await untilEurekaQuestion(w);
    w.eurekaServer.injectFault((r) => r.method === 'POST' && r.path === stagePost, { kind: 'status', status: 500, body: '{"message":"boom"}' });
    const failed = await answer(w, q, '네');
    expect(failed.actionResults[0]).toMatchObject({ action: 'complete_stage', status: 'failed' });
    expect(fallbackText(mapHarnessResult(failed)).text).toContain("'Eureka 다시 반영해줘'라고 하시면 다시 시도할게요.");

    const r = await w.harness.handle(retryRequest('t-retry-1'));
    expect(r.facts['retry']).toMatchObject({ status: 'started' });
    expect(r.actionResults[0]).toMatchObject({ action: 'complete_stage', status: 'succeeded' });
    expect(w.github.submitCount).toBe(1);
    const stageOps = (await w.store.listOperations()).filter((o) => o.action === 'complete_stage');
    expect(stageOps).toHaveLength(2);
    expect(stageOps[1]!.operationId).not.toBe(stageOps[0]!.operationId);
    // 확인 기록 규칙은 그대로: 새 확인 하나가 새 작업 하나에만, 전달 근거는 retry_request
    const conf = await w.store.getConfirmation(stageOps[1]!.confirmationRef!);
    expect(conf).toMatchObject({ state: 'approved', operationId: stageOps[1]!.operationId, deliveredContentAndChannelEvidence: { channel: 'retry_request' } });
  });

  it('결과 불명(unknown)이면 다시 보내지 않는다. 이미 성공했거나 할 일이 없으면 실행 없음', async () => {
    const w = createWorld();
    expect((await w.harness.handle(retryRequest('t-r0'))).facts['retry']).toMatchObject({ status: 'nothing_to_retry' });
    const q = await untilEurekaQuestion(w);
    w.eurekaServer.injectFault((r) => r.method === 'POST' && r.path === stagePost, { kind: 'drop_after_apply' });
    const u = await answer(w, q, '네');
    expect(u.actionResults[0]!.status).toBe('unknown');
    const r = await w.harness.handle(retryRequest('t-r1'));
    expect(r.facts['retry']).toMatchObject({ status: 'result_unknown' });
    expect(w.eurekaServer.writeCount('/_api_/stages')).toBe(1);

    const w2 = createWorld();
    const q2 = await untilEurekaQuestion(w2);
    await answer(w2, q2, '네');
    expect((await w2.harness.handle(retryRequest('t-r2'))).facts['retry']).toMatchObject({ status: 'already_done' });
    expect(w2.eurekaServer.writeCount('/_api_/stages')).toBe(1);
  });

  it('음성 신뢰도가 낮으면 다시 하지 않는다', async () => {
    const w = createWorld();
    const q = await untilEurekaQuestion(w);
    w.eurekaServer.injectFault((r) => r.method === 'POST' && r.path === stagePost, { kind: 'status', status: 500, body: '{}' });
    await answer(w, q, '네');
    const r = await w.harness.handle(retryRequest('t-low', '다시 해줘', { stt: 0.3 }));
    expect(r.facts['retry']).toMatchObject({ status: 'input_blocked' });
    expect(w.eurekaServer.writeCount('/_api_/stages')).toBe(1);
  });
});

describe('주기 복구 RecoveryWorker (S-07, D-23) — 다시 보내지 않고 조회만', () => {
  it('판정 대기(센서 오류)는 다음 tick에서 재판정하고 알린다', async () => {
    const notices: FollowUpNotice[] = [];
    const sensor = new ControllableSensor();
    const w = createWorld({ sensor, onFollowUp: (n) => notices.push(n) });
    await review(w);
    const q = await askApproval(w);
    sensor.fail = (i) => i.gatewayResult.mode === 'write';
    const r = await answer(w, q, '응, 승인해');
    expect(r.facts['assessmentPending']).toBeDefined();
    sensor.fail = null;
    const worker = new RecoveryWorker({ harness: w.harness, store: w.store, clock: w.clock });
    const rep = await worker.tick();
    expect(rep).toMatchObject({ checked: 1, resolved: 1 });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ source: 'recovery', action: 'submit_approval', status: 'succeeded' });
    expect(w.github.submitCount).toBe(1);
    expect((await worker.tick()).checked).toBe(0);
  });

  it('결과 불명은 간격을 늘려 가며 조회만 하고, 상한에 닿으면 blocked로 남긴다. 재전송 0회', async () => {
    const w = createWorld({ config: { maxRecoveryAttempts: 2 } });
    await review(w);
    const q = await askApproval(w);
    w.github.failNextSubmit('drop_after_apply');
    const r = await answer(w, q, '응, 승인해');
    const id = r.actionResults[0]!.operationId;
    expect(r.actionResults[0]!.status).toBe('unknown');
    const worker = new RecoveryWorker({ harness: w.harness, store: w.store, clock: w.clock, intervalMs: 1_000 });
    for (let i = 0; i < 6; i++) {
      await worker.tick();
      w.clock.advance(10_000);
    }
    const op = (await w.store.getOperation(id))!;
    expect(op.recovery).toBe('blocked');
    expect(op.actionResult!.status).toBe('unknown');
    expect(w.github.submitCount).toBe(1);
  });

  it('다음 확인 시각 전에는 다시 조회하지 않는다', async () => {
    const w = createWorld({ config: { maxRecoveryAttempts: 10 } });
    await review(w);
    const q = await askApproval(w);
    w.github.failNextSubmit('drop_after_apply');
    await answer(w, q, '응, 승인해');
    const worker = new RecoveryWorker({ harness: w.harness, store: w.store, clock: w.clock, intervalMs: 30_000 });
    expect((await worker.tick()).checked).toBe(1);
    expect(await worker.tick()).toMatchObject({ checked: 0, skippedBackoff: 1 });
    w.clock.advance(31_000);
    expect((await worker.tick()).checked).toBe(1);
  });
});


describe('파이프라인 형식(harness.run)과 서버 notice', () => {
  it('진행 중은 status=unknown + facts.inProgress, 다시 하기 결과는 facts.retryStatus', async () => {
    const { PipelineBridge } = await import('@deskpet/server');
    const { OutputService } = await import('@deskpet/output');
    const w = createWorld({ config: { followUpReplyWaitMs: 20 } });
    const bridge = new PipelineBridge({ harness: w.harness, store: w.store, output: new OutputService() });
    const q = await untilEurekaQuestion(w);
    w.eurekaServer.injectFault((r) => r.method === 'POST' && r.path === stagePost, { kind: 'delay', ms: 100 });
    const r = await answer(w, q, '네');
    const mapped = await bridge.toPipelineResult(r, 'OP-P1');
    expect(mapped.action).toMatchObject({ status: 'unknown', facts: { inProgress: 'true' } });
    await w.harness.drainBackground();
    const none = await bridge.toPipelineResult(await w.harness.handle(retryRequest('t-p2')), 'OP-P2');
    expect(none.action).toMatchObject({ status: 'succeeded', facts: { retryStatus: 'already_done' } });
  });
});

describe('복구로 GitHub 승인이 확정되면 Eureka 상태·기록을 보고 후속 질문 여부를 정한다 (D-24)', () => {
  async function pendingApproval(w: ReturnType<typeof createWorld>, sensor: ControllableSensor, ctx?: import('@deskpet/contracts').ContextPacket) {
    const b = await import('../support/builders.js');
    await w.harness.handle(b.harnessRequest('req-review', b.voiceTurn('t-rv', '그 PR 리뷰해줘'), ctx));
    const q = await w.harness.handle(b.harnessRequest('req-approve', b.voiceTurn('t-ap', '그 PR 승인해줘', { intention: 'pr.approve' }), ctx));
    sensor.fail = (i) => i.gatewayResult.mode === 'write';
    const r = await answer(w, q, '응, 승인해');
    expect(r.facts['assessmentPending']).toBeDefined();
    sensor.fail = null;
  }

  it('단계가 반영 가능하면 확인 질문을 만들어 알림에 싣고, 답하면 그 단계만 완료한다', async () => {
    const notices: FollowUpNotice[] = [];
    const sensor = new ControllableSensor();
    const w = createWorld({ sensor, onFollowUp: (n) => notices.push(n) });
    await pendingApproval(w, sensor);
    await new RecoveryWorker({ harness: w.harness, store: w.store, clock: w.clock }).tick();
    expect(notices).toHaveLength(1);
    const n = notices[0]!;
    expect(n).toMatchObject({ source: 'recovery', action: 'submit_approval', status: 'succeeded', result: { disposition: 'awaiting_user', pending: { purpose: 'confirm_stage_completion' } } });
    expect(fallbackText(mapHarnessResult(n.result)).text).toContain("Eureka의 'PR 승인' 단계를 완료로 반영할까요?");
    const done = await answer(w, n.result, '네');
    expect(done.actionResults[0]).toMatchObject({ action: 'complete_stage', status: 'succeeded' });
    expect(w.eurekaServer.writeCount('/_api_/stages')).toBe(1);
    expect(w.github.submitCount).toBe(1);
  });

  it('재시작 뒤(메모리 없음)에도 operation에 남긴 연결 단계로 질문을 만든다', async () => {
    const notices: FollowUpNotice[] = [];
    const sensor = new ControllableSensor();
    const w = createWorld({ sensor, onFollowUp: (n) => notices.push(n) });
    await pendingApproval(w, sensor);
    w.restart();
    await new RecoveryWorker({ harness: w.harness, store: w.store, clock: w.clock }).tick();
    expect(notices[0]?.result.pending?.purpose).toBe('confirm_stage_completion');
  });

  it('단계가 이미 끝났으면 묻지 않고 이유를 남긴다', async () => {
    const notices: FollowUpNotice[] = [];
    const sensor = new ControllableSensor();
    const w = createWorld({ sensor, onFollowUp: (n) => notices.push(n) });
    await pendingApproval(w, sensor);
    w.eurekaServer.items.get((await import('../support/builders.js')).ITEM_ID)!.stages.find((s) => s.id === STAGE_ID)!.status = 'done';
    await new RecoveryWorker({ harness: w.harness, store: w.store, clock: w.clock }).tick();
    expect(notices[0]!.result.pending).toBeUndefined();
    expect(notices[0]!.result.facts['followUp']).toMatchObject({ eligibility: 'blocked', conditions: ['eureka_stage_already_done'] });
    expect(fallbackText(mapHarnessResult(notices[0]!.result)).text).toContain('PR 42번을 승인했어요. Eureka 반영은 보류했어요.');
  });

  it('기록(note)에서 찾은 연결이면 그 기록에 PR 주소가 남아 있을 때만 묻는다', async () => {
    const b = await import('../support/builders.js');
    const noteCtx = { ...b.prContext(), taskRefs: [{ ...b.prContext().taskRefs[0]!, source: { kind: 'eureka' as const, ref: `item:${b.ITEM_ID}/stage:${STAGE_ID}/note:N1` } }] };
    for (const [content, expectQuestion] of [[`PR: https://github.com/${b.REPO.owner}/${b.REPO.name}/pull/${b.PR}`, true], ['링크 지움', false]] as const) {
      const notices: FollowUpNotice[] = [];
      const sensor = new ControllableSensor();
      const w = createWorld({ sensor, onFollowUp: (n) => notices.push(n) });
      w.eurekaServer.items.get(b.ITEM_ID)!.stages.find((s) => s.id === STAGE_ID)!.notes = [{ id: 'N1', content }];
      await pendingApproval(w, sensor, noteCtx);
      await new RecoveryWorker({ harness: w.harness, store: w.store, clock: w.clock }).tick();
      if (expectQuestion) expect(notices[0]!.result.pending?.purpose).toBe('confirm_stage_completion');
      else expect(notices[0]!.result.facts['followUp']).toMatchObject({ eligibility: 'blocked', conditions: ['eureka_note_link_removed'] });
    }
  });
});
