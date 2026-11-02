import { confirmationTokens, type ActionResult, type ConfirmationScope, type Emotion, type OutputRequest } from '@deskpet/contracts';
import { formatKoreanDateTime, short } from './format.js';

/**
 * 고정 문구 fallback. 모델 실패·검증 실패 시 사용한다 (interface-contracts I-13).
 * 문구는 golden-scenario의 출력 예시를 따른다. 확인된 성공에만 완료 표현을 쓴다.
 */
interface ReviewFactsLike {
  prNumber: number;
  repository: string;
  headSha?: string;
  consistency?: string;
  changes?: { fileCount: number; additions: number; deletions: number };
  checks?: { requiredState: string; required?: string[]; requiredSource?: string; requiredReasonCode?: string; failing: string[]; pending: string[] };
  approvalWarnings?: string[];
  copilot?: { status: string; comments: unknown[]; blockingComments: number; commentCoverage?: string };
}

export function fallbackText(req: OutputRequest): { text: string; displayText: string; emotion: Emotion } {
  const f = req.facts;
  if (req.purpose === 'reminder' && req.reminder) {
    const due = formatKoreanDateTime(req.reminder.dueAt, req.reminder.timezone);
    const desc = req.reminder.description.replace(/[.。]$/, '');
    return { text: `${desc}. 마감은 ${due}이에요.`, displayText: `${desc} · 마감 ${due}`, emotion: 'neutral' };
  }

  // 파이프라인 문서 경계(output.generate): 기준 문장을 그대로 고정 문구로 쓴다
  if (typeof f['baseText'] === 'string' && f['baseText']) {
    const st = req.actionResults[0]?.status;
    const e: Emotion = req.purpose === 'question' ? 'thinking' : st === 'unknown' ? 'concerned' : st === 'failed' ? 'apologetic' : 'neutral';
    return { text: f['baseText'], displayText: typeof f['baseDisplayText'] === 'string' ? f['baseDisplayText'] : f['baseText'], emotion: e };
  }

  const parts: string[] = [];
  const display: string[] = [];
  let emotion: Emotion = 'neutral';

  const review = f['review'] as ReviewFactsLike | undefined;
  const approval = req.actionResults.find((a) => a.action === 'submit_approval');
  const stage = req.actionResults.find((a) => a.action === 'complete_stage');
  const blocked = f['blocked'] as { reasons: string[]; intent?: string } | undefined;
  const question = f['question'] as { purpose: string; scope?: ConfirmationScope; target?: { kind: string; prNumber?: number } } | undefined;

  if (f['processingErrors'] && (f['processingErrors'] as string[]).length > 0 && f['disposition'] === 'failed') {
    parts.push('요청을 처리하지 못했어요. 외부 작업은 실행하지 않았어요.');
    display.push('처리 실패 · 외부 변경 없음');
    emotion = 'apologetic';
  }

  // ---------------------------------------------------------------- 리뷰 요약
  if (review && !blocked && !approval && review.changes) {
    parts.push(reviewSentence(review));
    display.push(`PR ${review.prNumber} @${short(review.headSha)}`);
  } else if (f['reviewError'] === 'sensor_assessment_pending' && !approval) {
    parts.push('PR 정보는 받았지만 검사 판정을 끝내지 못했어요. 확인되지 않은 내용으로는 진행하지 않을게요.');
    display.push('PR 조회 판정 대기');
    emotion = 'concerned';
  } else if (f['reviewError'] && !approval) {
    const auth = String(f['reviewError']).includes('AUTH');
    parts.push(auth ? 'GitHub 권한 문제로 PR을 확인하지 못했어요. PR과 Eureka 상태는 변경되지 않았어요.' : 'PR 정보를 가져오지 못했어요. 잠시 후 다시 확인할게요.');
    display.push('PR 조회 실패');
    emotion = 'apologetic';
  }

  // ---------------------------------------------------------------- 차단
  if (blocked && !f['reviewError']) {
    parts.push(blockedSentence(blocked.reasons, review?.prNumber, review));
    display.push(`차단: ${blocked.reasons.join(', ')}`);
    emotion = 'concerned';
  }

  // ---------------------------------------------------------------- 판정 대기 (센서 오류)
  // 성공·실패·불명 어느 것도 단정하지 않는다
  const pendingAssess = f['assessmentPending'] as { action: string; target?: { kind: string; prNumber?: number }; dispatchState?: string } | undefined;
  if (pendingAssess) {
    const what = pendingAssess.action === 'submit_approval' ? `PR ${pendingAssess.target?.prNumber ?? ''}번 승인 요청` : 'Eureka 단계 완료 요청';
    parts.push(
      pendingAssess.dispatchState === 'not_sent'
        ? `${what}은 보내지 않았고, 결과 판정도 끝내지 못했어요.`
        : `${what}은 보냈지만 결과 판정을 아직 끝내지 못했어요. 다시 보내지 않고 기록으로 다시 확인할게요.`,
    );
    display.push(`${pendingAssess.action === 'submit_approval' ? 'GitHub 승인' : 'Eureka 반영'} 판정 대기`);
    emotion = 'concerned';
  }

  // ---------------------------------------------------------------- 승인 결과
  if (approval) {
    const t = approval.target.kind === 'github_pr' ? approval.target.prNumber : '';
    if (approval.status === 'succeeded') {
      parts.push(`PR ${t}번을 승인했어요.`);
      display.push(`GitHub 승인 성공 (review ${approval.externalRefs[0]?.id ?? '-'})`);
      emotion = 'cheerful';
    } else {
      parts.push(approvalFailure(approval, t));
      display.push(isWritesDisabled(approval) ? 'GitHub 승인 미전송 (쓰기 비활성)' : `GitHub 승인 ${statusKo(approval.status)}`);
      emotion = approval.status === 'unknown' ? 'concerned' : 'apologetic';
    }
    const fu = f['followUp'] as { eligibility: string; conditions?: string[] } | undefined;
    if (approval.status === 'succeeded' && fu && fu.eligibility !== 'eligible' && fu.eligibility !== 'not_applicable') {
      parts.push(`Eureka 반영은 보류했어요${fu.conditions?.includes('sha_changed_since_approval') ? '. 승인 뒤 새 커밋이 추가됐어요' : ''}.`);
      display.push(`Eureka 보류 (${fu.conditions?.join(', ') ?? fu.eligibility})`);
    }
  }

  // ---------------------------------------------------------------- Eureka 결과
  if (stage) {
    const name = (f['stageCompletion'] as { stageName?: string } | undefined)?.stageName ?? '해당';
    if (stage.status === 'succeeded') {
      parts.push(`Eureka의 '${name}' 단계를 완료로 반영했어요.`);
      display.push('Eureka 반영 성공');
      emotion = 'cheerful';
    } else if (stage.status === 'unknown') {
      parts.push(`Eureka 반영 결과를 아직 확인하지 못했어요. 다시 실행하지 않고 상태를 확인할게요.`);
      display.push('Eureka 반영 결과 미확인');
      emotion = 'concerned';
    } else if (isWritesDisabled(stage)) {
      parts.push('쓰기가 꺼져 있어서 Eureka 반영 요청은 보내지 않았어요.');
      display.push('Eureka 쓰기 비활성');
    } else {
      const policyBlocked = stage.dispatchState === 'not_sent' && stage.error?.provisionalCode !== undefined && ['POLICY_BLOCKED', 'SHA_CHANGED'].includes(stage.error.provisionalCode);
      parts.push(`Eureka 반영은 하지 못했어요. GitHub 승인은 그대로 유지돼요.${policyBlocked ? '' : " 'Eureka 다시 반영해줘'라고 하시면 다시 시도할게요."}`);
      display.push(`Eureka 반영 ${statusKo(stage.status)}`);
      emotion = 'apologetic';
    }
  } else {
    // 잠깐 기다리는 동안 끝나지 않음 (D-23): 끝나면 알림으로 다시 말한다
    const sc = f['stageCompletion'] as { status?: string; stageName?: string } | undefined;
    if (sc?.status === 'in_progress') {
      parts.push(`Eureka의 '${sc.stageName ?? '해당'}' 단계 반영을 진행하고 있어요. 끝나면 알려 드릴게요.`);
      display.push('Eureka 반영 진행 중');
    }
  }

  // ---------------------------------------------------------------- 다시 하기 (D-23)
  const retry = f['retry'] as { status: string; stageName?: string; reasons?: string[] } | undefined;
  if (retry && retry.status !== 'started') {
    const name = retry.stageName ? `'${retry.stageName}' 단계` : 'Eureka 반영';
    const msg: Record<string, [string, string]> = {
      nothing_to_retry: ['다시 할 Eureka 반영 작업을 찾지 못했어요. 아무것도 실행하지 않았어요.', '다시 할 작업 없음'],
      already_done: [`${name}은 이미 완료로 반영돼 있어요.`, '이미 반영됨'],
      result_unknown: [`${name}은 결과를 확인하는 중이라 다시 보내지 않았어요. 확인되면 알려 드릴게요.`, '결과 확인 중 · 재전송 안 함'],
      approval_not_confirmed: ['GitHub 승인이 확인되지 않아 Eureka 반영을 다시 하지 않았어요.', '승인 미확인 · 실행 없음'],
      blocked: [`지금은 ${name}을 반영할 수 없는 상태라 다시 하지 않았어요.`, '반영 불가 · 실행 없음'],
      input_blocked: ['요청을 정확히 듣지 못해 다시 하지 않았어요. 한 번 더 말해 주세요.', '입력 확인 불가 · 실행 없음'],
    };
    const m = msg[retry.status] ?? ['Eureka 반영을 다시 하지 않았어요.', '실행 없음'];
    parts.push(m[0]);
    display.push(m[1]);
    emotion = retry.status === 'already_done' ? 'neutral' : 'concerned';
  }

  // ---------------------------------------------------------------- 거절·답변
  if (f['declined']) {
    const d = f['declined'] as { action: string };
    parts.push(d.action === 'submit_approval' ? '승인을 취소했어요. PR과 Eureka 상태는 바꾸지 않았어요.' : 'Eureka 반영을 하지 않았어요. GitHub 승인은 그대로 유지돼요.');
    display.push('요청 취소 · 변경 없음');
  }
  if (f['unclearAnswer']) parts.push('답변을 정확히 듣지 못했어요.');
  if (f['answerNotAccepted'] && !question) {
    parts.push('확인 질문이 만료됐거나 이미 처리됐어요. 아무것도 실행하지 않았어요.');
    display.push('확인 만료/처리됨 · 실행 없음');
  }

  // ---------------------------------------------------------------- 질문
  if (req.purpose === 'question' && question) {
    // 필수가 아닌 검사 실패는 차단하지 않고 경고로 알린다 (README D-14)
    const warn = question.purpose === 'confirm_pr_approval' ? warningSentence(review?.approvalWarnings ?? []) : '';
    if (warn) parts.push(warn);
    parts.push(questionSentence(question, review?.prNumber ?? question.target?.prNumber));
    display.push('답변 대기');
    if (emotion === 'neutral') emotion = 'thinking';
  }

  if (f['backgroundNotFound'] && req.purpose !== 'question') {
    parts.push('팀 문서에서는 이 PR 프로젝트의 배경을 찾지 못해서, PR 내용만 알려 드렸어요.');
    display.push('배경 문서 없음');
  }

  // 팀 문서 발췌는 고정 문구로 요약할 수 없으므로, 찾은 문서만 알린다 (내용은 출력 모델이 있을 때만)
  const wiki = (f['wiki'] as { excerpts?: { ref: string }[] } | undefined)?.excerpts ?? [];
  if (wiki.length && req.purpose !== 'question') {
    const docs = [...new Set(wiki.map((e) => docTitle(e.ref)))];
    parts.push(`관련 팀 문서 ${docs.length}개를 찾았어요: ${docs.join(', ')}.`);
    display.push(`참고 문서 ${docs.length}`);
  }

  if (parts.length === 0) parts.push('요청을 처리했어요.');
  return { text: parts.join(' '), displayText: display.join(' / ') || parts[0]!, emotion };
}

/** wiki/deskpet-development-log.md#… → deskpet-development-log, projects/deskpet/README.md → deskpet */
function docTitle(ref: string): string {
  const path = ref.split('#')[0]!;
  const parts = path.replace(/\.md$/, '').split('/');
  const last = parts[parts.length - 1]!;
  return last === 'README' ? (parts[parts.length - 2] ?? last).replace(/^@/, '') : last;
}

function reviewSentence(r: ReviewFactsLike): string {
  const s: string[] = [`PR ${r.prNumber}번, 현재 커밋 ${short(r.headSha)} 기준이에요.`];
  if (r.changes) s.push(`파일 ${r.changes.fileCount}개가 바뀌었고 ${r.changes.additions}줄 추가, ${r.changes.deletions}줄 삭제예요.`);
  if (r.checks) {
    const c = r.checks;
    const req = new Set(c.required ?? []);
    const reqFail = c.failing.filter((n) => req.has(n));
    const otherFail = c.failing.filter((n) => !req.has(n));
    if (c.requiredState === 'unknown') s.push(requiredUnknownSentence(c.requiredReasonCode));
    if (reqFail.length) s.push(`필수 검사가 실패했어요: ${reqFail.join(', ')}.`);
    if (otherFail.length) s.push(c.requiredState === 'unknown' ? `실패한 검사가 있어요: ${otherFail.join(', ')}.` : `필수는 아니지만 실패한 검사가 있어요: ${otherFail.join(', ')}.`);
    if (c.pending.length) s.push(`아직 진행 중인 검사가 있어요: ${c.pending.join(', ')}.`);
    if (!c.failing.length && !c.pending.length) s.push('모든 검사가 통과했어요.');
    if (c.requiredSource === 'deskpet_config') s.push('필수 검사 기준은 GitHub 대신 DeskPet 설정을 썼어요.');
  }
  if (r.copilot) {
    if (r.copilot.status === 'current') {
      const cov = r.copilot.commentCoverage;
      if (cov && cov !== 'complete') {
        // 세부 지적을 다 모으지 못했으면 '없다'고 말하지 않는다 (감사 F-06)
        s.push(r.copilot.comments.length === 0 ? '현재 커밋의 Copilot 리뷰는 있지만 세부 지적은 확인하지 못했어요.' : `Copilot 지적은 확인된 것만 ${r.copilot.comments.length}건이고, 나머지는 확인하지 못했어요.`);
      } else s.push(r.copilot.comments.length === 0 ? 'Copilot 지적은 없어요.' : `Copilot 지적 ${r.copilot.comments.length}건이 있고 차단 수준은 ${r.copilot.blockingComments}건이에요.`);
    } else if (r.copilot.status === 'stale_only') s.push('현재 커밋에 대한 Copilot 리뷰는 아직 없어요. 이전 커밋 리뷰만 있어요.');
    else if (r.copilot.status === 'none') s.push('Copilot 리뷰는 없어요.');
    else s.push('리뷰 목록은 확인하지 못했어요.');
  }
  if (r.consistency === 'changed') s.push('확인하는 동안 새 커밋이 추가돼서 일부 자료는 이전 버전 기준이에요.');
  return s.join(' ');
}

function blockedSentence(reasons: string[], pr?: number, review?: ReviewFactsLike): string {
  const n = pr ? `PR ${pr}번은 ` : '';
  if (reasons.includes('sha_changed')) return '리뷰를 들은 뒤 새 커밋이 추가됐어요. 변경 내용을 다시 확인한 후 승인해야 해요.';
  if (reasons.includes('pr_merged')) return `${n}이미 병합되어 승인할 수 없어요.`;
  if (reasons.includes('pr_closed')) return `${n}닫혀 있어 승인할 수 없어요.`;
  if (reasons.includes('pr_draft')) return `${n}초안 상태라 승인할 수 없어요.`;
  if (reasons.includes('cannot_approve_own_pr')) return `${n ? n.replace('은 ', '은 본인이 연 PR이라 ') : '본인이 연 PR이라 '}GitHub에서 승인할 수 없어요.`;
  if (reasons.some((r) => r.startsWith('required_check_failed'))) return '필수 검사가 실패해서 승인하지 않았어요.';
  if (reasons.some((r) => r.startsWith('required_check_pending'))) return '필수 검사가 아직 진행 중이라 승인하지 않았어요.';
  if (reasons.includes('required_checks_unverified')) return `${requiredUnknownSentence(review?.checks?.requiredReasonCode)} 그래서 승인하지 않았어요.`;
  if (reasons.includes('required_checks_partially_verified')) return '필수 검사 설정을 일부만 확인할 수 있어서 승인하지 않았어요.';
  if (reasons.some((r) => r.startsWith('permission'))) return '승인 권한을 확인할 수 없어서 승인하지 않았어요.';
  if (reasons.includes('llm_unavailable')) return '판단을 도와주는 모델에게서 지금 쓸 수 있는 답을 받지 못해 처리하지 못했어요. 외부 작업은 하지 않았어요. 잠시 후 다시 말씀해 주세요.';
  if (reasons.some((r) => r.startsWith('unsupported_intent'))) return '그 요청은 아직 처리할 수 없어요.';
  return `조건이 맞지 않아 실행하지 않았어요 (${reasons.join(', ')}).`;
}

function questionSentence(q: { purpose: string; scope?: ConfirmationScope }, pr?: number): string {
  switch (q.purpose) {
    case 'identify_pr':
      return '어느 저장소의 몇 번 PR을 확인할까요?';
    case 'select_pr_candidate':
      return '후보 PR이 여러 개예요. 어느 PR부터 볼까요?';
    case 'clarify_request':
      return '무엇을 도와드릴지 조금 더 자세히 말해 주시겠어요?';
    case 'restate_write_command':
      return `승인 명령을 정확히 듣지 못했어요. ${pr ? `PR ${pr}번을 승인하려면 '${pr}번 승인해'라고` : '대상과 함께'} 다시 말해 주세요.`;
    // 대상·행위·버전은 고정 범위 문구로만 말한다 (contracts/confirmation.ts)
    case 'confirm_pr_approval':
      return `${confirmationTokens(q.scope!)[0]}을 승인할까요?`;
    case 'confirm_stage_completion':
      return `${confirmationTokens(q.scope!)[0]}할까요?`;
    default:
      return '어떻게 할까요?';
  }
}

function approvalFailure(a: ActionResult, pr: number | string): string {
  if (isWritesDisabled(a)) return `쓰기가 꺼져 있어서 PR ${pr}번 승인 요청은 보내지 않았어요. PR과 Eureka 상태는 그대로예요.`;
  if (a.status === 'unknown') return '승인 요청의 결과를 확인하지 못했어요. 중복 승인을 막기 위해 다시 실행하지 않았고, Eureka도 아직 완료 처리하지 않았어요.';
  if (a.error?.provisionalCode === 'GITHUB_AUTH_ERROR') return 'GitHub 권한 문제로 승인하지 못했어요. PR과 Eureka 상태는 변경되지 않았어요.';
  if (a.error?.provisionalCode === 'SHA_CHANGED') return '리뷰를 들은 뒤 새 커밋이 추가됐어요. 변경 내용을 다시 확인한 후 승인해야 해요.';
  if (a.status === 'cancelled') return `PR ${pr}번 승인을 취소했어요. 외부 변경은 없어요.`;
  return `PR ${pr}번을 승인하지 못했어요. Eureka 상태는 변경되지 않았어요.`;
}

function statusKo(s: ActionResult['status']): string {
  return { succeeded: '성공', failed: '실패', unknown: '결과 미확인', cancelled: '취소' }[s];
}

function requiredUnknownSentence(code?: string): string {
  switch (code) {
    case 'plan_unsupported':
      return '현재 GitHub 요금제에서는 필수 검사 설정을 쓸 수 없어서 확인하지 못했어요.';
    case 'insufficient_permission':
      return '필수 검사 설정을 볼 권한이 없어서 확인하지 못했어요.';
    default:
      return '필수 검사 설정을 지금은 확인하지 못했어요.';
  }
}

function warningSentence(warnings: string[]): string {
  const failed = warnings.filter((w) => w.startsWith('non_required_check_failed:')).map((w) => w.split(':')[1]);
  const pending = warnings.filter((w) => w.startsWith('non_required_check_pending:')).map((w) => w.split(':')[1]);
  const s: string[] = [];
  if (failed.length) s.push(`참고로 필수는 아니지만 ${failed.join(', ')} 검사가 실패했어요.`);
  if (pending.length) s.push(`필수가 아닌 ${pending.join(', ')} 검사는 아직 진행 중이에요.`);
  return s.join(' ');
}

/** 쓰기 잠금(allowWrites=false)으로 전송하지 않은 결과 */
function isWritesDisabled(a: ActionResult): boolean {
  return a.dispatchState === 'not_sent' && /writes disabled/.test(a.error?.message ?? '');
}
