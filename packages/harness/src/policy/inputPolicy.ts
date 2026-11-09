import type { CurrentTurnInput } from '@deskpet/contracts';
import type { PolicyConfig } from './config.js';

/**
 * 쓰기 승인 입력 검사 — 일반 코드가 한다 (Liability §Principles 1).
 * 근거: message-contracts §Harness Boundary — voice는 final만 수락, unavailable을 높은 신뢰도로 간주하지 않음,
 *       web의 not_applicable과 구분, RouteDecision confidence로 STT confidence를 대체하지 않음.
 *       README C-05: STT와 라우터 신뢰도를 독립적으로 검사한다.
 */
export function writeInputBlockers(turn: CurrentTurnInput, cfg: PolicyConfig): string[] {
  const out: string[] = [];
  if (!turn.isFinal) out.push('turn_not_final');
  if (turn.inputChannel === 'voice') {
    if (turn.sttConfidenceState === 'unavailable') out.push('stt_confidence_unavailable');
    else if (turn.sttConfidenceState === 'provided' && (turn.sttConfidence ?? 0) < cfg.minSttConfidenceForWrite) out.push('stt_confidence_low');
    else if (turn.sttConfidenceState === 'not_applicable') out.push('stt_state_invalid_for_voice');
  }
  // web 입력의 채널 인증 방식은 미정 (message-contracts) — 여기서는 not_applicable만 허용
  if (turn.inputChannel === 'web' && turn.sttConfidenceState !== 'not_applicable') out.push('stt_state_invalid_for_web');
  if (turn.routeDecision.overallConfidence < cfg.minRouteConfidenceForWrite) out.push('route_confidence_low');
  return out;
}

/**
 * 승인 '요청'(확인 질문을 띄우는 단계)의 입력 검사 (D-39). loose면 신뢰도 기준은 빼고 말이 끝났는지·STT 상태만 본다.
 * 실제 쓰기는 확인 답변(classifyAnswer, 엄격)에서만 일어난다
 */
export function approvalRequestBlockers(turn: CurrentTurnInput, cfg: PolicyConfig): string[] {
  const all = writeInputBlockers(turn, cfg);
  return cfg.approvalRequestInput === 'strict' ? all : all.filter((b) => b !== 'stt_confidence_low' && b !== 'route_confidence_low');
}

/**
 * 승인 요청으로 볼 말 (D-39). STT가 '승인'을 비슷한 소리로 잘못 듣는 경우(성인·생일 등)까지 받는다.
 * 요청은 확인 질문만 띄우므로 느슨하게 받는다. 거절 말이 있으면 아니다
 */
const APPROVAL_REQUEST = /(승인|성인|송인|숭인|생인|싱인|승일|성일|생일)\s*(해|하자|할게|부탁|좀|ㄱ)/;
export function looksLikeApprovalRequest(text: string): boolean {
  return APPROVAL_REQUEST.test(text) && !REJECT_WORDS.test(text);
}

export type AnswerVerdict = 'approved' | 'rejected' | 'unclear';

/**
 * 확인 답변 말 목록 (2026-11-09 사용자 결정 D-38: 동의·실행 요청을 같은 승인으로 본다).
 * 거절 말이 있으면 거절이 우선이고, 되묻는 말(…까?, …?)은 승인으로 보지 않는다.
 */
export const REJECT_WORDS = /(아니|안\s*돼|안\s*해|안\s*할|않|취소|보류|거절|거부|하지\s*마|하지\s*말|싫어|싫다|그만|별로|nope|\bno\b|cancel|reject|\bstop\b)/i;
/** 짧은 긍정: 낱말 하나로 서야 한다 ("네가", "어디", "예약"은 아님). 반복(네네·응응)은 허용 */
const SHORT_YES = /(?:^|[\s,.!~])(?:응+|어|엉|웅|넹|네+|예+|ㅇㅇ+|ㅇㅋ|콜|오키|ok|okay|yes|yep|yeah|sure)(?=$|[\s,.!~])/i;
/** 동의·실행 요청: 낱말 시작이 맞으면 뒤 어미는 자유 (승인해줘요, 알겠습니다, 진행해 주세요 …) */
const YES_PHRASE = /(?:^|[\s,.!~])(?:그래|좋아|좋습니다|맞아|맞습니다|알겠|알았|오케이|당연|승인|완료해|진행|반영|처리해|해줘|해\s줘|해주세요|해\s주세요|부탁|ㄱㄱ|고고|go\s+ahead)/i;
/** 되묻는 말: 물음표로 끝나거나 …까/까요/나요/니/냐로 끝남 */
const QUESTION = /([?？]|까요?|나요|[니냐])\s*[?？]?\s*$/;

/** 문장만 보고 정한 답변 종류 (라우터 판단과 별개). 시험 클라이언트도 같은 함수를 쓴다 */
export function answerWordVerdict(text: string): 'approve' | 'reject' | 'question' | 'unclear' {
  const t = text.trim();
  if (REJECT_WORDS.test(t)) return 'reject';
  if (QUESTION.test(t)) return 'question';
  return SHORT_YES.test(t) || YES_PHRASE.test(t) ? 'approve' : 'unclear';
}

/**
 * 확인 답변 해석 (규칙 기반, inference). 거절은 라우터 intention·거절 말 중 하나면 거절. 승인은 문장에 승인 말이 있어야 한다.
 * 모호하면 unclear — 승인으로 해석하지 않는다. 거절 신호가 있으면 거절이 우선한다.
 */
export function classifyAnswer(turn: CurrentTurnInput, cfg: PolicyConfig): { verdict: AnswerVerdict; rationale: string } {
  const blockers = writeInputBlockers(turn, cfg);
  if (blockers.length > 0) return { verdict: 'unclear', rationale: `input not acceptable for approval: ${blockers.join(',')}` };
  const intention = turn.routeDecision.headOutputs['intention']?.value;
  if (intention === 'confirm.reject') return { verdict: 'rejected', rationale: 'router intention confirm.reject' };
  const words = answerWordVerdict(turn.rawText);
  if (words === 'reject') return { verdict: 'rejected', rationale: 'reject keyword' };
  if (words === 'question') return { verdict: 'unclear', rationale: 'answer is a question, not an approval' };
  // 2026-11-09: 라우터가 confirm.approve라고 해도 문장에 승인 말이 없으면 승인으로 보지 않는다 (오타·잡음이 승인으로 넘어가지 않게)
  if (words === 'approve') return { verdict: 'approved', rationale: intention === 'confirm.approve' ? 'router intention confirm.approve + approve keyword' : 'approve keyword' };
  if (intention === 'confirm.approve') return { verdict: 'unclear', rationale: 'router said confirm.approve but no approval word in text' };
  return { verdict: 'unclear', rationale: 'no explicit approval or rejection' };
}
