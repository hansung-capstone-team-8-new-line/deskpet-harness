import { FakeGitHubTransport, type FakePr } from '@deskpet/gateways';
import { BASE_SHA, PR, REPO, SHA_A } from './builders.js';

/** G-01 고정 PR: 최신 head SHA_A에 대한 Copilot 리뷰 완료, 필수 검사 통과 (golden-scenario §4 사전 조건). */
export function goldenPr(): FakePr {
  return {
    repository: { ...REPO },
    prNumber: PR,
    basics: {
      title: 'feat: harness output mapper',
      author: 'teammate',
      state: 'open',
      draft: false,
      headSha: SHA_A,
      baseRef: 'main',
      baseSha: BASE_SHA,
    },
    files: [
      { path: 'packages/output/src/mapper.ts', status: 'modified', additions: 42, deletions: 7 },
      { path: 'packages/output/test/mapper.test.ts', status: 'added', additions: 60, deletions: 0 },
    ],
    runs: [
      { name: 'build', status: 'completed', conclusion: 'success', headSha: SHA_A },
      { name: 'test', status: 'completed', conclusion: 'success', headSha: SHA_A },
    ],
    requiredChecks: { state: 'configured', names: ['build', 'test'], source: 'github_branch_protection' },
    reviews: [
      {
        reviewId: '8001',
        author: 'copilot-pull-request-reviewer[bot]',
        state: 'COMMENTED',
        commitSha: SHA_A,
        submittedAt: '2026-10-04T09:30:00.000Z',
        comments: [
          { path: 'packages/output/src/mapper.ts', line: 12, severity: 'low', body: '함수 이름을 더 구체적으로' },
          { path: 'packages/output/src/mapper.ts', line: 30, severity: 'low', body: 'null 체크 중복' },
        ],
      },
    ],
  };
}

export function fakeGitHub(mode: 'rest' | 'mcp', now: () => number, pr = goldenPr()) {
  return new FakeGitHubTransport(mode, pr, now);
}
