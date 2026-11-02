import { describe, expect, it } from 'vitest';
import type { HarnessResult, OutputRequest } from '@deskpet/contracts';
import { OutputService, formatKoreanDateTime, mapHarnessResult, type OutputModel } from '@deskpet/output';
import { PR, REPO, SHA_A, T0 } from '../../../tests/support/builders.js';

const prTarget = { kind: 'github_pr' as const, repository: { ...REPO }, prNumber: PR };

const approvalQuestion: HarnessResult = {
  requestId: 'req-1',
  disposition: 'awaiting_user',
  actionResults: [],
  pending: {
    pendingId: 'p-1',
    revision: 0,
    kind: 'confirmation',
    purpose: 'confirm_pr_approval',
    requiredSlots: [],
    scope: { action: 'submit_approval', target: prTarget, headSha: SHA_A },
    confirmationId: 'c-1',
    outputId: 'out-q',
    expiresAt: T0,
  },
  facts: { question: { purpose: 'confirm_pr_approval', kind: 'confirmation', scope: { action: 'submit_approval', target: prTarget, headSha: SHA_A } } },
  sources: [],
  processingErrors: [],
};

const unknownApproval: HarnessResult = {
  requestId: 'req-1',
  disposition: 'completed',
  actionResults: [
    {
      operationId: 'op-1',
      action: 'submit_approval',
      target: prTarget,
      status: 'unknown',
      dispatchState: 'may_have_been_sent',
      facts: {},
      externalRefs: [],
      observedAt: T0,
      error: { stage: 'github.write', provisionalCode: 'GITHUB_RESULT_UNKNOWN', message: 'timeout', nextAction: 'reconcile' },
    },
  ],
  facts: {},
  sources: [],
  processingErrors: [],
};

const model = (text: string, emotion = 'cheerful', displayText?: string): OutputModel => ({ generate: async () => ({ text, emotion, ...(displayText !== undefined ? { displayText } : {}) }) });

describe('HarnessOutputMapper', () => {
  it('question uses the pending outputId and requires target/action/version meaning', () => {
    const req = mapHarnessResult(approvalQuestion);
    expect(req).toMatchObject({ outputId: 'out-q', purpose: 'question', pendingId: 'p-1', confirmationId: 'c-1' });
    expect(req.requiredMeaning).toEqual([`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}`, '승인']);
  });
});

describe('OutputService', () => {
  it('fallback confirmation question includes repo, PR, SHA and action (golden-scenario 4)', async () => {
    const c = await new OutputService().generate(mapHarnessResult(approvalQuestion));
    expect(c.text).toBe(`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}을 승인할까요?`);
    expect(c.fallbackUsed).toBe(true);
  });

  it('rejects model output that drops required meaning and falls back', async () => {
    const c = await new OutputService({ model: model('승인할까요?') }).generate(mapHarnessResult(approvalQuestion));
    expect(c.fallbackUsed).toBe(true);
    expect(c.validationResult.failures).toContain(`missing_required:${`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}`}`);
  });

  it('unknown results never use model wording: fixed status sentence only; status is copied by code (S-07, audit F-02)', async () => {
    let called = 0;
    const m: OutputModel = { generate: async () => (called++, { text: 'PR 승인 처리가 성공적으로 끝났어요.', emotion: 'cheerful' }) };
    const svc = new OutputService({ model: m });
    const c = await svc.generate(mapHarnessResult(unknownApproval));
    expect(called).toBe(0);
    expect(c.fallbackUsed).toBe(true);
    // 검증기 자체도 완료 표현을 막는다
    expect(svc.validate({ text: 'PR 42번을 승인했어요!' }, mapHarnessResult(unknownApproval))).toContain('success_claim_without_success:submit_approval');
    expect(c.text).toContain('결과를 확인하지 못했어요');
    expect(c.actionStatuses).toEqual([{ operationId: 'op-1', status: 'unknown' }]);
  });

  it('accepts a valid model sentence and constrains emotion to the allowed set', async () => {
    const c = await new OutputService({ model: model(`네, ${`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}`}을 지금 승인할까요?`, 'ecstatic') }).generate(mapHarnessResult(approvalQuestion));
    expect(c.fallbackUsed).toBe(false);
    expect(c.emotion).toBe('thinking');
  });

  it('model failure → fixed phrase', async () => {
    const failing: OutputModel = { generate: async () => Promise.reject(new Error('gpu busy')) };
    const c = await new OutputService({ model: failing }).generate(mapHarnessResult(approvalQuestion));
    expect(c.fallbackUsed).toBe(true);
    expect(c.validationResult.failures[0]).toMatch(/model_error/);
  });

  it('reminder keeps description and exact due date/time with timezone', async () => {
    const req: OutputRequest = {
      outputId: 'out-r',
      requestRefs: { requestId: 'sys-1', operationIds: [] },
      purpose: 'reminder',
      actionResults: [],
      facts: {},
      sources: [],
      requiredMeaning: [],
      constraints: { language: 'ko-KR', maxSpeechChars: 200, allowedEmotions: ['neutral'] },
      reminder: { description: '실험 결과를 비교하고 분석 보고서를 제출한다.', dueAt: '2026-09-28T23:59:00+09:00', timezone: 'Asia/Seoul', relatedIds: { itemId: 'i', reminderKey: 'k' } },
    };
    expect(formatKoreanDateTime(req.reminder!.dueAt, 'Asia/Seoul')).toBe('2026년 9월 28일 밤 11시 59분');
    const c = await new OutputService({ model: model('곧 마감이에요. 3시간 남았어요.') }).generate(req);
    expect(c.fallbackUsed).toBe(true);
    expect(c.validationResult.failures).toContain('reminder_due_missing');
    expect(c.text).toContain('2026년 9월 28일 밤 11시 59분');
  });
});

describe('OutputService — displayText 검증 (화면 문장)', () => {
  it('화면 문장이 미확인 작업을 성공으로 표시하면 검증에서 걸린다', () => {
    const f = new OutputService().validate({ text: 'PR 42번 승인 결과를 아직 확인하지 못했어요.', displayText: 'PR 42 승인 완료' }, mapHarnessResult(unknownApproval));
    expect(f).toContain('display:success_claim_without_success:submit_approval');
  });

  it('화면 문장에서 승인 대상(필수 의미)이 빠지면 고정 문구로 되돌린다', async () => {
    const c = await new OutputService({ model: model(`${`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}`}을 승인할까요?`, 'thinking', '승인할까요?') }).generate(mapHarnessResult(approvalQuestion));
    expect(c.fallbackUsed).toBe(true);
    expect(c.validationResult.failures).toContain(`display:missing_required:${`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}`}`);
  });

  it('화면 문장도 필수 의미를 지키면 모델 문장을 그대로 쓴다', async () => {
    const d = `${`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}`} 승인 확인`;
    const c = await new OutputService({ model: model(`${`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}`}을 승인할까요?`, 'thinking', d) }).generate(mapHarnessResult(approvalQuestion));
    expect(c.fallbackUsed).toBe(false);
    expect(c.displayText).toBe(d);
  });

  it('모델이 화면 문장을 내지 않으면 고정 화면 문장을 쓰고 검사 실패로 보지 않는다', async () => {
    const c = await new OutputService({ model: model(`${`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}`}을 승인할까요?`, 'thinking') }).generate(mapHarnessResult(approvalQuestion));
    expect(c.fallbackUsed).toBe(false);
    expect(c.validationResult.failures).toEqual([]);
  });
});

describe('OutputService — 다른 대상 식별자 금지 (감사 F-02)', () => {
  it('확인 질문에 다른 저장소를 섞으면 고정 문구로 되돌린다', async () => {
    const c = await new OutputService({ model: model(`Other/Repo PR 42번 말고 NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}을 승인할까요?`, 'thinking') }).generate(mapHarnessResult(approvalQuestion));
    expect(c.fallbackUsed).toBe(true);
    expect(c.validationResult.failures).toContain('foreign_identifier:repository:other/repo');
  });

  it('다른 PR 번호·커밋을 섞으면 고정 문구로 되돌린다', async () => {
    const c = await new OutputService({ model: model(`NewLine/DeskPet PR 42번, 현재 커밋 ${SHA_A.slice(0, 7)}을 승인할까요? PR 999번, 커밋 deadbee1도 같이요.`, 'thinking') }).generate(mapHarnessResult(approvalQuestion));
    expect(c.fallbackUsed).toBe(true);
    expect(c.validationResult.failures).toEqual(expect.arrayContaining(['foreign_identifier:pr:999', 'foreign_identifier:sha:deadbee1']));
  });
});

describe('blocked sentence for own PR', () => {
  it('explains that GitHub does not allow approving your own PR', async () => {
    const r: HarnessResult = {
      requestId: 'req-1',
      disposition: 'completed',
      actionResults: [],
      facts: { review: { prNumber: 9, repository: 'o/r' }, blocked: { reasons: ['cannot_approve_own_pr', 'required_checks_unverified'] } },
      sources: [],
      processingErrors: [],
    };
    const c = await new OutputService().generate(mapHarnessResult(r));
    expect(c.text).toBe('PR 9번은 본인이 연 PR이라 GitHub에서 승인할 수 없어요.');
  });
});
