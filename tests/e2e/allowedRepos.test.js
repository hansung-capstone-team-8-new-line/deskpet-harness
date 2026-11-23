import { describe, expect, it } from 'vitest';
import { isRepositoryAllowed, parseAllowedRepositories } from '@deskpet/contracts';
import { EurekaGateway, FakeEurekaServer } from '@deskpet/gateways';
import { DEFAULT_POLICY, FakeClock, InMemoryOperationStore, SequentialIdGen } from '@deskpet/harness';
import { EurekaBridge } from '@deskpet/server';
import { T0 } from '../support/builders.js';
import { askApproval, review, speak } from '../support/flows.js';
import { createWorld } from '../support/world.js';
/**
 * D-36 허용 저장소 목록 (D-21 보안 보류분, 사용자 결정 2026-11-08)
 * - 목록 밖 저장소 PR은 리뷰(읽기)는 하지만 승인 질문을 만들지 않는다
 * - Eureka 단계 기록의 PR 주소 중 목록 밖 저장소는 연결 후보에서 뺀다
 * - 목록이 비어 있으면 지금처럼 제한 없음
 */
const DEADLINE = '2026-10-04T10:05:00.000Z';
describe('허용 저장소 목록 형식', () => {
    it('owner/name 목록, 대소문자 무시, 비면 제한 없음', () => {
        expect(parseAllowedRepositories(' NewLine/DeskPet , a/b ')).toEqual({ repos: ['NewLine/DeskPet', 'a/b'], invalid: [] });
        expect(parseAllowedRepositories('NewLine, https://github.com/a/b').invalid).toHaveLength(2);
        expect(isRepositoryAllowed(['NewLine/DeskPet'], 'newline', 'deskpet')).toBe(true);
        expect(isRepositoryAllowed(['NewLine/DeskPet'], 'NewLine', 'Other')).toBe(false);
        expect(isRepositoryAllowed(undefined, 'x', 'y')).toBe(true);
        expect(isRepositoryAllowed([], 'x', 'y')).toBe(true);
    });
});
describe('승인 전 확인', () => {
    it('목록 밖 저장소: 리뷰는 하고, 승인 질문 없이 이유를 말한다', async () => {
        const w = createWorld({ config: { allowedRepositories: ['someone/else'] } });
        await review(w);
        const q = await askApproval(w);
        expect(q.pending?.purpose).not.toBe('confirm_pr_approval');
        expect(w.github.submitCount).toBe(0);
        expect((await speak(q)).text).toContain('승인을 허용한 저장소의 PR이 아니라');
    });
    it('목록 안 저장소(대소문자 달라도)는 지금처럼 승인 질문까지 간다', async () => {
        const w = createWorld({ config: { allowedRepositories: ['newline/deskpet'] } });
        await review(w);
        const q = await askApproval(w);
        expect(q.pending?.purpose).toBe('confirm_pr_approval');
    });
});
describe('eureka.links 후보 거르기', () => {
    it('목록 밖 PR 주소는 후보에서 빼고 excludedCount로 알린다', async () => {
        const clock = new FakeClock(T0);
        const server = new FakeEurekaServer(() => clock.nowMs());
        server.addItem({
            id: '1000020',
            name: 'LLM_Test_only',
            stages: [{ id: 's1', name: '실행', status: 'todo', order: 1, notes: [{ id: 'n1', content: 'https://github.com/NewLine/DeskPet/pull/42 https://github.com/evil/repo/pull/1' }] }],
        });
        const store = new InMemoryOperationStore({ clock, ids: new SequentialIdGen(), capacityBytes: DEFAULT_POLICY.storeCapacityBytes, recoveryBudgetBytes: DEFAULT_POLICY.recoveryBudgetBytes, minRetentionMs: DEFAULT_POLICY.minRetentionMs, maxRecoveryAttempts: 3 });
        const eureka = new EurekaGateway({ http: server, now: () => clock.nowMs() });
        const limited = new EurekaBridge({ eureka, store, clock, allowedRepositories: ['NewLine/DeskPet'] });
        const r = await limited.links('1000020', DEADLINE);
        expect(r).toMatchObject({ status: 'linked', excludedCount: 1 });
        expect(r.links.map((l) => l.prNumber)).toEqual([42]);
        const open = new EurekaBridge({ eureka, store, clock });
        const r2 = await open.links('1000020', DEADLINE);
        expect(r2.status).toBe('ambiguous');
        expect(r2.excludedCount).toBeUndefined();
    });
});
