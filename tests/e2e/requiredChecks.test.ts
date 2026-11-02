import { describe, expect, it } from 'vitest';
import { parseRequiredChecksFallback } from '@deskpet/gateways';
import { SHA_A } from '../support/builders.js';
import { askApproval, review, speak } from '../support/flows.js';
import { goldenPr } from '../support/github.js';
import { createWorld } from '../support/world.js';

/** 필수 검사 설정을 GitHub에서 확인할 수 없을 때의 처리 (README D-13, D-14) */
const planUnsupported = () => {
  const pr = goldenPr();
  pr.requiredChecks = { state: 'unavailable', reasonCode: 'plan_unsupported', detail: '403 Upgrade to GitHub Pro or make this repository public' };
  return pr;
};

describe('required checks unavailable on a free private repo', () => {
  it('without DeskPet fallback → blocked with the reason, no confirmation', async () => {
    const w = createWorld({ pr: planUnsupported() });
    const r0 = await review(w);
    expect(r0.facts['review']).toMatchObject({ checks: { requiredState: 'unknown', requiredReasonCode: 'plan_unsupported' } });
    const r = await askApproval(w);
    expect(r.pending).toBeUndefined();
    expect(r.facts['blocked']).toMatchObject({ reasons: expect.arrayContaining(['required_checks_unverified']) });
    expect((await speak(r)).text).toBe('현재 GitHub 요금제에서는 필수 검사 설정을 쓸 수 없어서 확인하지 못했어요. 그래서 승인하지 않았어요.');
    expect(w.github.submitCount).toBe(0);
  });

  it('with DeskPet fallback and a failing required check → required_check_failed', async () => {
    const pr = planUnsupported();
    pr.runs[1] = { name: 'test', status: 'completed', conclusion: 'failure', headSha: SHA_A };
    const w = createWorld({ pr, requiredChecksFallback: parseRequiredChecksFallback('NewLine/DeskPet=build,test') });
    const r0 = await review(w);
    expect(r0.facts['review']).toMatchObject({ checks: { requiredState: 'configured', requiredSource: 'deskpet_config' } });
    expect((await speak(r0)).text).toContain('필수 검사가 실패했어요: test.');
    const r = await askApproval(w);
    expect(r.facts['blocked']).toMatchObject({ reasons: ['required_check_failed:test'] });
    expect((await speak(r)).text).toBe('필수 검사가 실패해서 승인하지 않았어요.');
  });

  it('with DeskPet fallback and passing checks → confirmation is asked', async () => {
    const w = createWorld({ pr: planUnsupported(), requiredChecksFallback: { 'newline/deskpet': ['test'] } });
    await review(w);
    const r = await askApproval(w);
    expect(r.pending).toMatchObject({ kind: 'confirmation' });
  });
});

describe('non-required check failure is a warning, not a block (D-14)', () => {
  it('asks for confirmation and mentions the failing non-required check', async () => {
    const pr = goldenPr();
    pr.requiredChecks = { state: 'configured', names: ['test'], source: 'github_branch_protection' };
    pr.runs.push({ name: 'lint', status: 'completed', conclusion: 'failure', headSha: SHA_A });
    const w = createWorld({ pr });
    const r0 = await review(w);
    expect((await speak(r0)).text).toContain('필수는 아니지만 실패한 검사가 있어요: lint.');
    const r = await askApproval(w);
    expect(r.pending).toMatchObject({ kind: 'confirmation' });
    expect(r.facts['review']).toMatchObject({ approvalBlockers: [], approvalWarnings: ['non_required_check_failed:lint'] });
    expect((await speak(r)).text).toBe(`참고로 필수는 아니지만 lint 검사가 실패했어요. NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}을 승인할까요?`);
  });
});

describe('parseRequiredChecksFallback', () => {
  it('parses repo=checks pairs and ignores malformed entries', () => {
    expect(parseRequiredChecksFallback('a/b=test, lint ; bad ; c/d=build;e/f=')).toEqual({ 'a/b': ['test', 'lint'], 'c/d': ['build'] });
    expect(parseRequiredChecksFallback(undefined)).toEqual({});
  });
});
