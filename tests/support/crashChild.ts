/**
 * 실제 프로세스 강제 종료 시험용 자식 프로세스.
 * 영속 저장소에 쓰기 작업을 준비하고 may_have_been_sent ack를 받은 직후(= Gateway가 전송했을 수 있는 순간) SIGKILL로 죽는다.
 * 사용: node --import tsx tests/support/crashChild.ts <dbPath> <stage: after_ack | before_ack>
 */
import { DEFAULT_POLICY, InMemoryOperationStore, randomIdGen, systemClock } from '@deskpet/harness';

const [dbPath, stage] = process.argv.slice(2);
const target = { kind: 'github_pr' as const, repository: { owner: 'o', name: 'r' }, prNumber: 1 };
const store = InMemoryOperationStore.openDurable(dbPath!, {
  clock: systemClock,
  ids: randomIdGen,
  capacityBytes: DEFAULT_POLICY.storeCapacityBytes,
  recoveryBudgetBytes: DEFAULT_POLICY.recoveryBudgetBytes,
  minRetentionMs: DEFAULT_POLICY.minRetentionMs,
  maxRecoveryAttempts: DEFAULT_POLICY.maxRecoveryAttempts,
});
const r = await store.reserveAndPrepare({
  owner: 'harness',
  requestId: 'req-crash',
  action: 'submit_approval',
  target,
  isWrite: true,
  expectedOutcome: {
    action: 'submit_approval',
    target,
    expectedVersion: { headSha: 'a'.repeat(40) },
    postconditions: ['approval.review_state_approved'],
    requiredEvidence: ['review_id'],
    completenessRequirement: { sections: [], allowTruncation: false },
  },
  checkRuleVersion: 'rules-0.1',
  actualRequest: { commitId: 'a'.repeat(40) },
  priorEvidence: {},
  holderId: 'child',
});
if (!r.ok) throw new Error(r.reason);
process.stdout.write(`${r.operation.operationId}\n`);
if (stage === 'after_ack') {
  const ack = await store.persistMayHaveBeenSent({ ...r.authority, operationId: r.operation.operationId });
  if (!ack.ok) throw new Error(ack.reason);
}
// 정리·close 없이 즉시 강제 종료
process.kill(process.pid, 'SIGKILL');
