import { describe, expect, it } from 'vitest';
import {
  ActionResult,
  ConfirmationRecord,
  CurrentTurnInput,
  GuideDecision,
  OutputRequest,
  ReviewSection,
  clampPayloadDeadline,
  makeEnvelope,
  parseEnvelope,
} from '@deskpet/contracts';
import { harnessRequest, voiceTurn, webTurn, T0, REPO, PR, SHA_A } from '../../../tests/support/builders.js';

const envelope = (over: Record<string, unknown> = {}) => ({
  schemaVersion: '1.0',
  messageId: 'm-1',
  kind: 'harness.request',
  requestId: 'req-1',
  createdAt: T0,
  deadlineAt: '2026-10-04T10:01:00.000Z',
  payload: harnessRequest('req-1', voiceTurn('t-1', 'PR 42 리뷰해줘')),
  ...over,
});

describe('Envelope — 요청 일치·deadline (감사 F-05)', () => {
  it('rejects a payload that belongs to another request', () => {
    const r = parseEnvelope(envelope({ requestId: 'req-other' }));
    expect(r.ok).toBe(false);
  });

  it('uses the earlier of envelope and payload deadline for execution', () => {
    const r = parseEnvelope(envelope());
    if (!r.ok) throw new Error('parse');
    // builder payload deadline is later than the envelope deadline
    const c = clampPayloadDeadline(r.value);
    expect((c.payload as { constraints: { deadlineAt: string } }).constraints.deadlineAt).toBe('2026-10-04T10:01:00.000Z');
  });
});

describe('Envelope', () => {
  it('accepts a valid harness.request', () => {
    const r = parseEnvelope(envelope());
    expect(r.ok).toBe(true);
  });

  it('accepts a newer minor of the supported major', () => {
    expect(parseEnvelope(envelope({ schemaVersion: '1.7' })).ok).toBe(true);
  });

  it('rejects an unsupported major', () => {
    const r = parseEnvelope(envelope({ schemaVersion: '2.0' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toMatch(/unsupported major/);
  });

  it('rejects malformed schemaVersion', () => {
    expect(parseEnvelope(envelope({ schemaVersion: 'v1' })).ok).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(parseEnvelope(envelope({ kind: 'harness.teleport' })).ok).toBe(false);
  });

  it('requires deadlineAt for execution requests', () => {
    const { deadlineAt: _d, ...rest } = envelope();
    const r = parseEnvelope(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toMatch(/deadlineAt/);
  });

  it('rejects payload type errors before execution', () => {
    const bad = envelope({ payload: { requestId: 'req-1' } });
    const r = parseEnvelope(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.startsWith('payload.'))).toBe(true);
  });

  it('makeEnvelope throws on invalid payload', () => {
    expect(() =>
      makeEnvelope('harness.request', { messageId: 'm', requestId: 'r', createdAt: T0 }, harnessRequest('r', voiceTurn('t', 'x'))),
    ).toThrow(/deadlineAt/);
  });
});

describe('CurrentTurnInput', () => {
  it('voice with provided confidence', () => {
    expect(CurrentTurnInput.safeParse(voiceTurn('t', '승인해', { stt: 0.9 })).success).toBe(true);
  });

  it('voice with unavailable confidence is valid input (but policy blocks writes)', () => {
    expect(CurrentTurnInput.safeParse(voiceTurn('t', '승인해', { stt: 'unavailable' })).success).toBe(true);
  });

  it('web must be not_applicable, distinguished from missing voice confidence', () => {
    expect(CurrentTurnInput.safeParse(webTurn('t', '승인')).success).toBe(true);
    expect(CurrentTurnInput.safeParse({ ...webTurn('t', '승인'), sttConfidenceState: 'unavailable' }).success).toBe(false);
    expect(CurrentTurnInput.safeParse({ ...voiceTurn('t', '승인'), sttConfidenceState: 'not_applicable', sttConfidence: undefined }).success).toBe(false);
  });

  it('provided state requires a value', () => {
    const t = { ...voiceTurn('t', 'x'), sttConfidence: undefined };
    expect(CurrentTurnInput.safeParse(t).success).toBe(false);
  });

  it('rejects unknown inputChannel enum', () => {
    expect(CurrentTurnInput.safeParse({ ...voiceTurn('t', 'x'), inputChannel: 'telepathy' }).success).toBe(false);
  });
});

describe('ActionResult', () => {
  const base = {
    operationId: 'op-1',
    action: 'submit_approval',
    target: { kind: 'github_pr', repository: REPO, prNumber: PR },
    facts: {},
    externalRefs: [],
    observedAt: T0,
  };

  it('rejects write succeeded without external evidence', () => {
    expect(ActionResult.safeParse({ ...base, status: 'succeeded', dispatchState: 'sent' }).success).toBe(false);
  });

  it('accepts write succeeded with evidence', () => {
    const r = ActionResult.safeParse({
      ...base,
      status: 'succeeded',
      dispatchState: 'sent',
      externalRefs: [{ system: 'github', kind: 'review', id: '9001' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown + not_sent', () => {
    expect(ActionResult.safeParse({ ...base, status: 'unknown', dispatchState: 'not_sent' }).success).toBe(false);
  });

  it('rejects needs_clarification as a status (pending is separate — C-03)', () => {
    expect(ActionResult.safeParse({ ...base, status: 'needs_clarification', dispatchState: 'not_sent' }).success).toBe(false);
  });

  it('rejects unknown action names', () => {
    expect(ActionResult.safeParse({ ...base, action: 'shell.exec', status: 'failed', dispatchState: 'not_sent' }).success).toBe(false);
  });
});

describe('ConfirmationRecord', () => {
  it('rejects unknown verdict enum', () => {
    const rec = {
      confirmationId: 'c-1',
      pendingId: 'p-1',
      requestId: 'r',
      conversationId: 'conv-1',
      revision: 0,
      scope: { action: 'submit_approval', target: { kind: 'github_pr', repository: REPO, prNumber: PR }, headSha: SHA_A },
      requiredQuestionMeaning: 'x',
      outputId: 'o-1',
      state: 'waiting',
      expiresAt: T0,
    };
    expect(ConfirmationRecord.safeParse(rec).success).toBe(true);
    expect(ConfirmationRecord.safeParse({ ...rec, verdict: 'maybe' }).success).toBe(false);
  });
});

describe('GuideDecision', () => {
  const base = { decisionId: 'd', basedOnRevision: 1, reasonRefs: [], unknowns: [] };

  it('payload must match kind', () => {
    expect(GuideDecision.safeParse({ ...base, kind: 'finish', payload: { reason: 'done', outputFactRefs: [] } }).success).toBe(true);
    expect(GuideDecision.safeParse({ ...base, kind: 'finish', payload: { purpose: 'q' } }).success).toBe(false);
  });

  it('propose_action only allows registered actions', () => {
    const ok = {
      ...base,
      kind: 'propose_action',
      payload: {
        action: 'get_review_context',
        typedArguments: { action: 'get_review_context', repository: REPO, prNumber: PR, requestedSections: ['checks'] },
        target: { kind: 'github_pr', repository: REPO, prNumber: PR },
        prerequisites: [],
      },
    };
    expect(GuideDecision.safeParse(ok).success).toBe(true);
    const bad = { ...ok, payload: { ...ok.payload, action: 'run_shell' } };
    expect(GuideDecision.safeParse(bad).success).toBe(false);
  });
});

describe('ReviewSection', () => {
  it('distinguishes not_requested / unavailable / empty list', () => {
    expect(ReviewSection.safeParse({ sectionKind: 'reviews', availability: 'not_requested', completeness: 'unknown' }).success).toBe(true);
    expect(
      ReviewSection.safeParse({
        sectionKind: 'reviews',
        availability: 'available',
        completeness: 'complete',
        data: { reviews: [] },
        observedAt: T0,
      }).success,
    ).toBe(true);
    expect(ReviewSection.safeParse({ sectionKind: 'reviews', availability: 'missing', completeness: 'unknown' }).success).toBe(false);
  });
});

describe('OutputRequest', () => {
  const base = {
    outputId: 'o',
    requestRefs: { requestId: 'r' },
    actionResults: [],
    facts: {},
    sources: [],
    requiredMeaning: [],
    constraints: { language: 'ko-KR', maxSpeechChars: 200, allowedEmotions: ['neutral'] },
  };
  it('question requires pendingId; reminder requires payload', () => {
    expect(OutputRequest.safeParse({ ...base, purpose: 'question' }).success).toBe(false);
    expect(OutputRequest.safeParse({ ...base, purpose: 'question', pendingId: 'p' }).success).toBe(true);
    expect(OutputRequest.safeParse({ ...base, purpose: 'reminder' }).success).toBe(false);
  });
});
