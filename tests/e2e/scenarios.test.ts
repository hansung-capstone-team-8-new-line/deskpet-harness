import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitHubTransportError } from '@deskpet/gateways';
import { ITEM_ID, PR, SHA_A, SHA_B } from '../support/builders.js';
import { answer, askApproval, review, speak } from '../support/flows.js';
import { ControllableSensor } from '../support/sensor.js';
import { createWorld } from '../support/world.js';

/** golden-scenario §5 세부 시나리오. 모든 외부 호출은 fixture. */

describe('S-04: low STT confidence blocks approval', () => {
  it('low confidence approve command → restate request, no confirmation, no write', async () => {
    const w = createWorld();
    await review(w);
    const r = await askApproval(w, 'req-a', { stt: 0.5 });
    expect(r.disposition).toBe('awaiting_user');
    expect(r.pending).toMatchObject({ kind: 'clarification', purpose: 'restate_write_command' });
    expect(r.pending!.confirmationId).toBeUndefined();
    expect((await speak(r)).text).toBe("승인 명령을 정확히 듣지 못했어요. PR 42번을 승인하려면 '42번 승인해'라고 다시 말해 주세요.");
    expect(w.github.submitCount).toBe(0);
  });

  it('unavailable confidence on the confirmation answer → unclear, re-ask with a new confirmation', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    const r = await answer(w, q, '응 승인해', { stt: 'unavailable' });
    expect(r.disposition).toBe('awaiting_user');
    expect(r.facts['unclearAnswer']).toBeDefined();
    expect(r.pending!.confirmationId).not.toBe(q.pending!.confirmationId);
    expect((await w.store.getConfirmation(q.pending!.confirmationId!))!).toMatchObject({ verdict: 'unclear', state: 'revoked' });
    expect(w.github.submitCount).toBe(0);
    // 재질문에 높은 신뢰도로 답하면 그때 실행
    const r2 = await answer(w, r, '응, 42번 승인해');
    expect(r2.actionResults[0]).toMatchObject({ action: 'submit_approval', status: 'succeeded' });
    expect(w.github.submitCount).toBe(1);
  });
});

describe('S-05: user declines', () => {
  it('rejection writes nothing to GitHub or Eureka', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    const r = await answer(w, q, '아니, 보류해');
    expect(r.disposition).toBe('completed');
    expect(r.actionResults).toEqual([]);
    expect(r.facts['declined']).toMatchObject({ action: 'submit_approval' });
    expect((await w.store.getConfirmation(q.pending!.confirmationId!))!.state).toBe('rejected');
    expect((await w.store.getPending(q.pending!.pendingId))!.state).toBe('consumed');
    expect(w.github.submitCount).toBe(0);
    expect(w.eurekaServer.writeCount('/')).toBe(0);
    expect((await speak(r)).text).toBe('승인을 취소했어요. PR과 Eureka 상태는 바꾸지 않았어요.');
    // 같은 확인을 늦게 승인해도 실행되지 않는다
    const late = await answer(w, q, '응 승인해', { deliver: false });
    expect(late.facts['answerNotAccepted']).toBeDefined();
    expect(w.github.submitCount).toBe(0);
  });

  it('declining the Eureka question keeps the GitHub approval', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    const r = await answer(w, q, '응, 승인해');
    const r2 = await answer(w, r, '아니, 그건 하지 마');
    expect(r2.facts['declined']).toMatchObject({ action: 'complete_stage' });
    expect(w.eurekaServer.writeCount('/')).toBe(0);
    const approval = (await w.store.listOperations()).find((o) => o.action === 'submit_approval')!;
    expect(approval.actionResult!.status).toBe('succeeded');
  });
});

describe('S-06: authentication / permission errors', () => {
  it('review read auth error → failed result, no retry, no write', async () => {
    const w = createWorld();
    w.github.failNextRead('pr', 'auth');
    const r = await review(w);
    expect(r.actionResults[0]).toMatchObject({ action: 'get_review_context', status: 'failed' });
    expect(r.actionResults[0]!.error!.provisionalCode).toBe('GITHUB_AUTH_ERROR');
    expect((await speak(r)).text).toBe('GitHub 권한 문제로 PR을 확인하지 못했어요. PR과 Eureka 상태는 변경되지 않았어요.');
  });

  it('approval auth error → failed (sent), no automatic retry, no Eureka question', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    w.github.failNextSubmit('auth');
    const r = await answer(w, q, '응, 승인해');
    expect(r.actionResults[0]).toMatchObject({ status: 'failed', dispatchState: 'sent' });
    expect(r.pending).toBeUndefined();
    expect(r.facts['followUp']).toMatchObject({ eligibility: 'not_started' });
    expect(w.github.submitCount).toBe(1);
    expect(w.eurekaServer.writeCount('/')).toBe(0);
    expect((await speak(r)).text).toBe('GitHub 권한 문제로 승인하지 못했어요. PR과 Eureka 상태는 변경되지 않았어요.');
  });
});

describe('S-07: response lost after sending → unknown', () => {
  it('REST timeout: unknown, never resent, read-only reconcile, Eureka untouched', async () => {
    const w = createWorld({ githubMode: 'rest', config: { maxRecoveryAttempts: 3 } });
    await review(w);
    const q = await askApproval(w);
    w.github.failNextSubmit('drop_after_apply');
    const r = await answer(w, q, '응, 승인해');
    const a = r.actionResults[0]!;
    expect(a).toMatchObject({ status: 'unknown', dispatchState: 'may_have_been_sent' });
    expect(r.pending).toBeUndefined();
    expect(w.github.submitCount).toBe(1);
    expect(w.eurekaServer.writeCount('/')).toBe(0);
    expect((await speak(r)).text).toBe('승인 요청의 결과를 확인하지 못했어요. 중복 승인을 막기 위해 다시 실행하지 않았고, Eureka도 아직 완료 처리하지 않았어요.');

    // 같은 호출 안의 읽기 복구 1회 + 이후 복구도 후보만 찾을 뿐 인과 연결이 없으면 unknown 유지
    let op = (await w.store.getOperation(a.operationId))!;
    expect(op.recovery).toBe('needed');
    expect(op.actionResult!.facts['latestObservation']).toMatchObject({ linkage: 'candidate_only' });
    await w.harness.reconcile(a.operationId, 'sys-1', { deadlineAt: '2026-10-04T10:10:00.000Z' });
    const last = await w.harness.reconcile(a.operationId, 'sys-2', { deadlineAt: '2026-10-04T10:10:00.000Z' });
    op = (await w.store.getOperation(a.operationId))!;
    expect(last.status).toBe('still_unknown');
    expect(op.recovery).toBe('blocked'); // 자동 복구 상한 → 운영 조치 필요
    expect(op.actionResult!.status).toBe('unknown');
    expect(w.github.submitCount).toBe(1);
  });

  it('user "다시 해줘" on unknown does not resend', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    w.github.failNextSubmit('drop_after_apply');
    await answer(w, q, '응, 승인해');
    const again = await answer(w, q, '응, 다시 승인해', { deliver: false });
    expect(again.facts['answerNotAccepted']).toBeDefined();
    expect(w.github.submitCount).toBe(1);
  });

  it('MCP success text only → unknown (C-10), not succeeded', async () => {
    const w = createWorld({ githubMode: 'mcp' });
    await review(w);
    const q = await askApproval(w);
    expect(q.disposition).toBe('awaiting_user');
    const r = await answer(w, q, '응, 승인해');
    expect(r.actionResults[0]).toMatchObject({ status: 'unknown', dispatchState: 'sent' });
    expect(r.pending).toBeUndefined();
    expect(w.eurekaServer.writeCount('/')).toBe(0);
  });

  it('connection refused before sending → proven not_sent → one conditional retry', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    w.github.failNextSubmit('refuse');
    const r = await answer(w, q, '응, 승인해');
    expect(r.actionResults[0]).toMatchObject({ status: 'succeeded' });
    const op = (await w.store.getOperation(r.actionResults[0]!.operationId))!;
    expect(op.attempts.map((x) => x.dispatchState)).toEqual(['not_sent', 'sent']);
    expect(w.github.submitCount).toBe(1);
  });

  it('restart after durable may_have_been_sent → unknown, recovery by read only', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    // 확인·operation 준비·ack까지 진행한 뒤 응답 전에 프로세스가 죽은 상황
    w.github.afterSubmit = () => {
      w.github.afterSubmit = undefined;
      throw new Error('process crashed');
    };
    await expect(answer(w, q, '응, 승인해')).rejects.toThrow('process crashed');
    w.restart();
    const op = (await w.store.listOperations()).find((o) => o.action === 'submit_approval')!;
    expect(op.actionResult).toMatchObject({ status: 'unknown', dispatchState: 'may_have_been_sent' });
    const rec = await w.harness.reconcile(op.operationId, 'sys-restart', { deadlineAt: '2026-10-04T10:10:00.000Z' });
    expect(rec.status).toBe('still_unknown');
    expect(w.github.submitCount).toBe(1);
  });  it('SQLite 파일 저장소: 응답 전 크래시 → 파일을 다시 열어도 unknown, 재전송 없음', async () => {
    const w = createWorld({ durablePath: join(mkdtempSync(join(tmpdir(), 'deskpet-e2e-')), 'h.db') });
    await review(w);
    const q = await askApproval(w);
    // 확인·operation 준비·ack까지 진행한 뒤 응답 전에 프로세스가 죽은 상황
    w.github.afterSubmit = () => {
      w.github.afterSubmit = undefined;
      throw new Error('process crashed');
    };
    await expect(answer(w, q, '응, 승인해')).rejects.toThrow('process crashed');
    w.restart();
    const op = (await w.store.listOperations()).find((o) => o.action === 'submit_approval')!;
    expect(op.actionResult).toMatchObject({ status: 'unknown', dispatchState: 'may_have_been_sent' });
    const rec = await w.harness.reconcile(op.operationId, 'sys-restart', { deadlineAt: '2026-10-04T10:10:00.000Z' });
    expect(rec.status).toBe('still_unknown');
    expect(w.github.submitCount).toBe(1);
  });
});

describe('S-08: head SHA changes', () => {
  it('new commit after the review the user heard → approval blocked before asking', async () => {
    const w = createWorld();
    await review(w);
    w.github.pushCommit(SHA_B);
    const r = await askApproval(w);
    expect(r.disposition).toBe('completed');
    expect(r.pending).toBeUndefined();
    expect(r.facts['blocked']).toMatchObject({ reasons: expect.arrayContaining(['sha_changed']) });
    expect((await speak(r)).text).toBe('리뷰를 들은 뒤 새 커밋이 추가됐어요. 변경 내용을 다시 확인한 후 승인해야 해요.');
    expect(w.github.submitCount).toBe(0);
  });

  it('commit pushed after confirmation, before dispatch → gateway re-verification blocks, not_sent', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    w.github.pushCommit(SHA_B);
    const r = await answer(w, q, '응, 승인해');
    expect(r.actionResults[0]).toMatchObject({ status: 'failed', dispatchState: 'not_sent' });
    expect(r.actionResults[0]!.error!.provisionalCode).toBe('SHA_CHANGED');
    expect(w.github.submitCount).toBe(0);
    // 새 리뷰 요청은 새로운 operation으로 추적된다
    const again = await review(w, 'req-review-2');
    expect(again.actionResults[0]!.operationId).not.toBe(r.actionResults[0]!.operationId);
    expect(again.facts['review']).toMatchObject({ headSha: SHA_B });
  });

  it('commit pushed right after approval → approval kept, Eureka follow-up blocked, no auto rollback', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    w.github.afterSubmit = () => w.github.pushCommit(SHA_B, { invalidateChecks: false });
    const r = await answer(w, q, '응, 승인해');
    expect(r.actionResults[0]).toMatchObject({ status: 'succeeded' });
    expect(r.pending).toBeUndefined();
    expect(r.facts['followUp']).toMatchObject({ eligibility: 'blocked', conditions: expect.arrayContaining(['sha_changed_since_approval']) });
    expect(w.eurekaServer.writeCount('/')).toBe(0);
    expect((await speak(r)).text).toBe('PR 42번을 승인했어요. Eureka 반영은 보류했어요. 승인 뒤 새 커밋이 추가됐어요.');
  });

  it('commit pushed after Eureka consent, before execution → re-verification blocks the stage write', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    const r = await answer(w, q, '응, 승인해');
    w.github.pushCommit(SHA_B);
    const r2 = await answer(w, r, '응, 완료해');
    expect(r2.actionResults[0]).toMatchObject({ action: 'complete_stage', status: 'failed', dispatchState: 'not_sent' });
    expect(w.eurekaServer.writeCount('/')).toBe(0);
    const approval = (await w.store.listOperations()).find((o) => o.action === 'submit_approval')!;
    expect(approval.actionResult!.status).toBe('succeeded');
    expect(w.github.submitCount).toBe(1);
  });
});

describe('S-09: GitHub succeeded, Eureka response lost', () => {
  it('Eureka unknown is isolated; GitHub success preserved; no re-approval', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    const r = await answer(w, q, '응, 승인해');
    w.eurekaServer.injectFault((x) => x.method === 'POST', { kind: 'drop_after_apply' });
    const r2 = await answer(w, r, '응, 완료해');
    expect(r2.actionResults[0]).toMatchObject({ action: 'complete_stage', status: 'unknown', dispatchState: 'may_have_been_sent' });
    expect(w.eurekaServer.writeCount('/_api_/stages/')).toBe(1);
    expect(w.github.submitCount).toBe(1);
    expect((await speak(r2)).text).toBe('Eureka 반영 결과를 아직 확인하지 못했어요. 다시 실행하지 않고 상태를 확인할게요.');
    const stageOp = (await w.store.getOperation(r2.actionResults[0]!.operationId))!;
    expect(stageOp.actionResult!.facts['latestObservation']).toMatchObject({ currentStageStatus: 'done' });
    expect(stageOp.recovery).toBe('needed');
    expect(w.eurekaServer.items.get(ITEM_ID)!.stages[1]!.status).toBe('done');
  });
});

describe('S-11: PR already merged', () => {
  it('blocks approval without writing', async () => {
    const w = createWorld();
    await review(w);
    w.github.setPrState('merged');
    const r = await askApproval(w);
    expect(r.facts['blocked']).toMatchObject({ reasons: expect.arrayContaining(['pr_merged']) });
    expect((await speak(r)).text).toBe('PR 42번은 이미 병합되어 승인할 수 없어요.');
    expect(w.github.submitCount).toBe(0);
  });
});

describe('Confirmation scope', () => {
  it('confirmation stores repo, PR, SHA and action; LLM-free approval flag cannot authorize', async () => {
    const w = createWorld();
    await review(w);
    const q = await askApproval(w);
    const conf = (await w.store.getConfirmation(q.pending!.confirmationId!))!;
    expect(conf.scope).toMatchObject({ action: 'submit_approval', target: { prNumber: PR }, headSha: SHA_A });
    expect(conf.requiredQuestionMeaning).toBe(`APPROVE NewLine/DeskPet#42 @ ${SHA_A}`);
    // 존재하지 않는 확인 ID로는 실행되지 않는다
    const fake = await w.harness.resume({
      originalRequestId: q.requestId,
      currentTurn: { ...q.pending!, conversationId: 'conv-1', turnId: 't-fake', rawText: '응', isFinal: true, inputChannel: 'web', sttConfidenceState: 'not_applicable', routeDecision: { headOutputs: {}, overallConfidence: 1, missingRequiredSlots: [], route: 'x', sourceTurnIds: [] } } as never,
      context: { contextId: 'ctx-1', version: 1, candidates: [], relatedTurns: [], taskRefs: [] },
      pendingId: q.pending!.pendingId,
      expectedPendingRevision: 0,
      confirmationId: 'conf-does-not-exist',
      newCallConstraints: { deadlineAt: '2026-10-04T10:10:00.000Z', maxPages: 3, maxResultBytes: 1000, policyVersion: 'p' },
    });
    expect(fake.disposition).toBe('failed');
    expect(w.github.submitCount).toBe(0);
  });
});

describe('writes disabled (real-connection demo mode)', () => {
  it('approval is not sent and no durable ack is requested; GitHub/Eureka unchanged', async () => {
    const w = createWorld();
    w.github.writesEnabled = false;
    await review(w);
    const q = await askApproval(w);
    const r = await answer(w, q, '응, 승인해');
    expect(r.actionResults[0]).toMatchObject({ action: 'submit_approval', status: 'failed', dispatchState: 'not_sent' });
    const op = (await w.store.getOperation(r.actionResults[0]!.operationId))!;
    expect(op.attempts.map((a) => a.dispatchState)).toEqual(['not_sent']);
    expect(op.attempts[0]!.dispatchEvidence?.mayHaveBeenSentAt).toBeUndefined();
    expect(w.github.submitCount).toBe(0);
    expect(w.eurekaServer.writeCount('/')).toBe(0);
    expect((await speak(r)).text).toBe('쓰기가 꺼져 있어서 PR 42번 승인 요청은 보내지 않았어요. PR과 Eureka 상태는 그대로예요.');
  });
});

describe('operator declines at the final gate', () => {
  it('records cancelled + not_sent and does not auto-retry', async () => {
    const w = createWorld();
    let prompts = 0;
    const original = w.github.submitApproval.bind(w.github);
    w.github.submitApproval = async () => {
      prompts += 1;
      throw new GitHubTransportError('not_sent', 'operator declined before sending', 'operator_declined');
    };
    await review(w);
    const q = await askApproval(w);
    const r = await answer(w, q, '응, 승인해');
    expect(r.actionResults[0]).toMatchObject({ action: 'submit_approval', status: 'cancelled', dispatchState: 'not_sent' });
    expect(prompts).toBe(1);
    expect(w.github.submitCount).toBe(0);
    void original;
  });
});

describe('Sensor 자체 오류 → 판정 대기 (guide-sensor: suggestedActionStatus 미생성, assessment=pending)', () => {
  it('쓰기 응답 뒤 센서만 실패하면 unknown/failed로 바꾸지 않고, 재전송 없이 reassess로 재판정한다', async () => {
    const sensor = new ControllableSensor();
    const w = createWorld({ sensor });
    await review(w);
    const q = await askApproval(w);
    sensor.fail = (i) => i.gatewayResult.mode === 'write';
    const r = await answer(w, q, '응, 승인해');
    expect(r.actionResults).toEqual([]);
    expect(r.facts['assessmentPending']).toMatchObject({ action: 'submit_approval', dispatchState: 'sent', recovery: 'none' });
    expect((await speak(r)).text).toBe('PR 42번 승인 요청은 보냈지만 결과 판정을 아직 끝내지 못했어요. 다시 보내지 않고 기록으로 다시 확인할게요.');
    const opId = (r.facts['assessmentPending'] as { operationId: string }).operationId;
    let op = (await w.store.getOperation(opId))!;
    expect(op).toMatchObject({ assessment: 'pending', recovery: 'none', executionPhase: 'response_received' });
    expect(op.actionResult).toBeUndefined();
    expect(w.github.submitCount).toBe(1);

    // 센서가 계속 실패하면 대기 유지
    expect((await w.harness.reassess(opId, 'sys-1')).status).toBe('still_pending');
    // 센서 복구 후 저장된 응답 증거로만 재판정 (외부 호출 없음)
    sensor.fail = null;
    const re = await w.harness.reassess(opId, 'sys-2');
    expect(re).toMatchObject({ status: 'assessed', actionResult: { status: 'succeeded' } });
    op = (await w.store.getOperation(opId))!;
    expect(op.assessment).toBe('assessed');
    expect(w.github.submitCount).toBe(1);
    expect((await w.harness.reassess(opId, 'sys-3')).status).toBe('not_needed');
  });

  it('복구 중 센서가 실패해도 복구 담당을 해제하고 unknown을 유지한다', async () => {
    const sensor = new ControllableSensor();
    const w = createWorld({ sensor, config: { maxRecoveryAttempts: 5 } });
    await review(w);
    const q = await askApproval(w);
    w.github.failNextSubmit('drop_after_apply');
    const r = await answer(w, q, '응, 승인해');
    const a = r.actionResults[0]!;
    expect(a.status).toBe('unknown');

    sensor.fail = () => true;
    const rec = await w.harness.reconcile(a.operationId, 'sys-1', { deadlineAt: '2026-10-04T10:10:00.000Z' });
    expect(rec.status).toBe('still_unknown');
    let op = (await w.store.getOperation(a.operationId))!;
    expect(op.recovery).toBe('needed'); // running으로 남지 않는다
    expect(op.currentExecutionAuthority).toBeUndefined();
    expect(op.actionResult!.status).toBe('unknown');

    sensor.fail = null;
    const next = await w.harness.reconcile(a.operationId, 'sys-2', { deadlineAt: '2026-10-04T10:10:00.000Z' });
    expect(next.status).not.toBe('busy');
    op = (await w.store.getOperation(a.operationId))!;
    expect(op.recovery).not.toBe('running');
    expect(w.github.submitCount).toBe(1);
  });

  it('조회 응답의 센서 판정이 실패하면 그 결과로 승인 질문을 만들지 않는다', async () => {
    const sensor = new ControllableSensor();
    const w = createWorld({ sensor });
    sensor.fail = (i) => i.gatewayResult.mode === 'read';
    const r = await askApproval(w);
    expect(r.pending).toBeUndefined();
    expect(r.facts['reviewError']).toBe('sensor_assessment_pending');
    expect((await speak(r)).text).toContain('검사 판정을 끝내지 못했어요');
    const ops = await w.store.listOperations();
    expect(ops.find((o) => o.action === 'get_review_context')).toMatchObject({ assessment: 'pending' });
    expect(w.github.submitCount).toBe(0);
  });
});
