import { describe, expect, it } from 'vitest';
import { approvalBlockers, approvalWarnings, latestRunsByName, type ChecksData } from '@deskpet/contracts';
import { SHA_A, T0 } from '../../../tests/support/builders.js';

type Run = ChecksData['runs'][number];
const run = (o: Partial<Run>): Run => ({ name: 'test', status: 'completed', conclusion: 'success', headSha: SHA_A, ...o });
const pr = { title: 't', author: 'teammate', state: 'open' as const, draft: false, headSha: SHA_A, baseRef: 'main', observedAt: T0 };
const blockers = (runs: Run[]) =>
  approvalBlockers({
    pr,
    checks: { runs, requiredChecks: { state: 'configured', names: ['test'] } },
    expectedHeadSha: SHA_A,
    viewerPermission: 'write',
    viewerLogin: 'gomdori',
  });

describe('latestRunsByName (docs/connection-test-issues.md #4)', () => {
  it('older success + newer failure → blocked (the unsafe case)', () => {
    const runs = [
      run({ id: '1', startedAt: '2026-10-05T01:00:00.000Z', conclusion: 'success' }),
      run({ id: '2', startedAt: '2026-10-05T02:00:00.000Z', conclusion: 'failure' }),
    ];
    expect(blockers(runs)).toEqual(['required_check_failed:test']);
  });

  it('older failure + newer re-run success → passes', () => {
    const runs = [
      run({ id: '1', startedAt: '2026-10-05T01:00:00.000Z', conclusion: 'failure' }),
      run({ id: '2', startedAt: '2026-10-05T02:00:00.000Z', conclusion: 'success' }),
    ];
    expect(blockers(runs)).toEqual([]);
    expect(latestRunsByName(runs)).toMatchObject({ duplicates: 1, runs: [{ id: '2' }] });
  });

  it('falls back to numeric id when timestamps are missing', () => {
    const runs = [run({ id: '20', conclusion: 'failure' }), run({ id: '9', conclusion: 'success' })];
    expect(latestRunsByName(runs).runs[0]!.id).toBe('20');
  });

  it('without ordering evidence picks the worst result (conservative)', () => {
    const runs = [run({ conclusion: 'success' }), run({ conclusion: 'failure' })];
    expect(blockers(runs)).toEqual(['required_check_failed:test']);
    expect(latestRunsByName([run({}), run({ status: 'in_progress', conclusion: null })]).runs[0]!.status).toBe('in_progress');
  });

  it('warnings also use the latest run only', () => {
    const runs = [
      run({ name: 'lint', id: '1', startedAt: '2026-10-05T01:00:00.000Z', conclusion: 'failure' }),
      run({ name: 'lint', id: '2', startedAt: '2026-10-05T02:00:00.000Z', conclusion: 'success' }),
    ];
    expect(approvalWarnings({ runs, requiredChecks: { state: 'configured', names: ['test'] } })).toEqual([]);
  });
});
