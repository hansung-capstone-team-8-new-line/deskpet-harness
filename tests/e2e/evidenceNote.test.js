import { describe, expect, it } from 'vitest';
import { EVIDENCE_NOTE_MARK, evidenceNoteContent } from '@deskpet/contracts';
import { EurekaGateway, FakeEurekaServer } from '@deskpet/gateways';
import { fallbackText, mapHarnessResult } from '@deskpet/output';
import { PR, REPO, SHA_A, STAGE_ID } from '../support/builders.js';
import { answer, askApproval, review } from '../support/flows.js';
import { createWorld } from '../support/world.js';
/**
 * D-28 완료 근거 기록: 단계 완료가 성공하면 단계 기록(note)에 승인한 PR 주소를 남긴다.
 * 동의는 단계 완료 확인 질문에 함께 받는다. 기록은 멱등키가 없으므로 결과를 모르면 다시 쓰지 않는다.
 */
const notePost = `/_api_/stages/${STAGE_ID}/note`;
const prUrl = `https://github.com/${REPO.owner}/${REPO.name}/pull/${PR}`;
const noteWrites = (w) => w.eurekaServer.calls.filter((c) => c.method === 'POST' && c.path === notePost);
const stageNotes = (w) => w.eurekaServer.items.get('1000006').stages.find((s) => s.id === STAGE_ID).notes ?? [];
async function untilEurekaQuestion(w) {
    await review(w);
    const q = await askApproval(w);
    const approved = await answer(w, q, '응, 승인해');
    expect(approved.pending?.purpose).toBe('confirm_stage_completion');
    return approved;
}
describe('Gateway: 단계 기록 작성 (POST /_api_/stages/{id}/note)', () => {
    it('웹과 같은 본문 {content, actorId}로 보내고, 같은 단계·같은 본문일 때만 기록 ID를 증거로 쓴다', async () => {
        const server = new FakeEurekaServer(() => Date.parse('2026-11-01T00:00:00Z'));
        server.addItem({ id: '1', name: 'x', stages: [{ id: '11', name: '정리', status: 'doing', order: 1 }] });
        const gw = new EurekaGateway({ http: server, now: () => Date.now(), allowWrites: true, noteActorId: '1000011@10200' });
        const handle = { operationId: 'op-1', attemptId: 'att-1', ownerRevision: 1, beforeDispatch: async () => ({ ok: true, ack: { kind: 'may_have_been_sent', operationId: 'op-1', attemptId: 'att-1', ownerRevision: 1, persistedAt: new Date().toISOString() } }) };
        const g = await gw.addStageNote({ operationId: 'op-1', stageId: '11', content: '근거' }, handle, { deadlineAt: new Date(Date.now() + 10_000).toISOString() });
        expect(server.calls.at(-1)).toMatchObject({ method: 'POST', path: '/_api_/stages/11/note', body: { content: '근거', actorId: '1000011@10200' } });
        expect(g).toMatchObject({ outcome: 'response', dispatchState: 'sent' });
        expect(g.externalRefs[0]).toMatchObject({ kind: 'stage_note' });
    });
    it('쓰기가 꺼져 있으면 보내지 않는다', async () => {
        const server = new FakeEurekaServer(() => Date.now());
        const gw = new EurekaGateway({ http: server, now: () => Date.now(), allowWrites: false });
        const handle = { operationId: 'op-1', attemptId: 'att-1', ownerRevision: 1, beforeDispatch: async () => ({ ok: false, reason: 'not_found', detail: '' }) };
        const g = await gw.addStageNote({ operationId: 'op-1', stageId: '11', content: '근거' }, handle, { deadlineAt: new Date(Date.now() + 10_000).toISOString() });
        expect(g).toMatchObject({ dispatchState: 'not_sent' });
        expect(server.calls).toHaveLength(0);
    });
    it('문구에는 표시·PR 주소·커밋 앞 7자리가 들어가고 계정 정보는 없다', () => {
        const text = evidenceNoteContent({ owner: REPO.owner, name: REPO.name, prNumber: PR, approvedSha: SHA_A, reviewId: '777' });
        expect(text).toBe(`${EVIDENCE_NOTE_MARK} ${prUrl} 승인 후 단계 완료 (커밋 ${SHA_A.slice(0, 7)}, 리뷰 777)`);
    });
});
describe('Harness: 완료 근거 기록 (D-28)', () => {
    it('확인 질문에 함께 묻고, 완료 뒤 단계 기록에 PR 주소를 한 번 남긴다', async () => {
        const w = createWorld({ config: { evidenceNote: true } });
        const q = await untilEurekaQuestion(w);
        expect(fallbackText(mapHarnessResult(q)).text).toContain("Eureka의 'PR 승인' 단계를 완료로 반영하고, 승인한 PR 주소를 단계 기록에 추가할까요?");
        const done = await answer(w, q, '네');
        expect(done.actionResults[0]).toMatchObject({ action: 'complete_stage', status: 'succeeded' });
        expect(done.facts['stageCompletion']).toMatchObject({ evidenceNote: { status: 'written' } });
        expect(noteWrites(w)).toHaveLength(1);
        const note = stageNotes(w).at(-1);
        expect(note.content).toContain(EVIDENCE_NOTE_MARK);
        expect(note.content).toContain(prUrl);
        expect(note.content).toContain(SHA_A.slice(0, 7));
        expect(fallbackText(mapHarnessResult(done)).text).toContain('승인한 PR 주소도 단계 기록에 남겼어요.');
        const op = (await w.store.listOperations()).find((o) => o.action === 'complete_stage');
        expect(op.evidenceNote).toMatchObject({ status: 'written', noteId: note.id });
    });
    it('같은 PR·같은 커밋의 근거 기록이 이미 있으면 쓰지 않는다', async () => {
        const w = createWorld({ config: { evidenceNote: true } });
        w.eurekaServer.items.get('1000006').stages.find((s) => s.id === STAGE_ID).notes = [{ id: '900', content: evidenceNoteContent({ owner: REPO.owner, name: REPO.name, prNumber: PR, approvedSha: SHA_A }) }];
        const q = await untilEurekaQuestion(w);
        const done = await answer(w, q, '네');
        expect(done.facts['stageCompletion']).toMatchObject({ evidenceNote: { status: 'already_present', noteId: '900' } });
        expect(noteWrites(w)).toHaveLength(0);
    });
    it('보낸 뒤 응답을 못 받으면 결과 미확인으로 두고 다시 보내지 않는다. 단계 완료는 그대로 성공', async () => {
        const w = createWorld({ config: { evidenceNote: true } });
        const q = await untilEurekaQuestion(w);
        w.eurekaServer.injectFault((r) => r.method === 'POST' && r.path === notePost, { kind: 'drop_after_apply' });
        const done = await answer(w, q, '네');
        expect(done.actionResults[0]).toMatchObject({ action: 'complete_stage', status: 'succeeded' });
        expect(done.facts['stageCompletion']).toMatchObject({ evidenceNote: { status: 'unknown' } });
        expect(noteWrites(w)).toHaveLength(1);
        const op = (await w.store.listOperations()).find((o) => o.action === 'complete_stage');
        expect(op.evidenceNote?.status).toBe('unknown');
        // 복구 알림 경로에서 다시 불려도 보내지 않는다
        await w.harness.notifyRecovered(op, op.actionResult);
        expect(noteWrites(w)).toHaveLength(1);
        expect(fallbackText(mapHarnessResult(done)).text).toContain('다시 쓰지 않았어요');
    });
    it('명시적 실패면 실패로 알리고 단계 완료는 그대로 둔다', async () => {
        const w = createWorld({ config: { evidenceNote: true } });
        const q = await untilEurekaQuestion(w);
        w.eurekaServer.injectFault((r) => r.method === 'POST' && r.path === notePost, { kind: 'status', status: 500, body: '{"message":"boom"}' });
        const done = await answer(w, q, '네');
        expect(done.actionResults[0]).toMatchObject({ status: 'succeeded' });
        expect(done.facts['stageCompletion']).toMatchObject({ evidenceNote: { status: 'failed' } });
        expect(fallbackText(mapHarnessResult(done)).text).toContain('단계 기록에는 PR 주소를 남기지 못했어요. 완료 반영은 그대로예요.');
    });
    it('기존 기록을 읽지 못하면 쓰지 않는다 (중복 여부를 모름)', async () => {
        const w = createWorld({ config: { evidenceNote: true } });
        const q = await untilEurekaQuestion(w);
        w.eurekaServer.injectFault((r) => r.method === 'GET' && r.path === '/_api_/notes/0/list', { kind: 'status', status: 403, body: '{"message":"no"}' });
        const done = await answer(w, q, '네');
        expect(done.facts['stageCompletion']).toMatchObject({ evidenceNote: { status: 'skipped', reason: 'notes_unverified' } });
        expect(noteWrites(w)).toHaveLength(0);
    });
    it('꺼져 있으면 질문 문장도 그대로이고 기록을 쓰지 않는다', async () => {
        const w = createWorld();
        const q = await untilEurekaQuestion(w);
        expect(fallbackText(mapHarnessResult(q)).text).not.toContain('단계 기록에 추가');
        const done = await answer(w, q, '네');
        expect(done.facts['stageCompletion']).not.toHaveProperty('evidenceNote');
        expect(noteWrites(w)).toHaveLength(0);
    });
});
