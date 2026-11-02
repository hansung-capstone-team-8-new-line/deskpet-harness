import {
  OutputRequest as OutputRequestSchema,
  allowedFromScope,
  emptyAllowed,
  foreignIdentifiers,
  mentionedIdentifiers,
  type AllowedIdentifiers,
  type ConfirmationScope,
  type Emotion,
  type OutputContent,
  type OutputRequest,
} from '@deskpet/contracts';
import { fallbackText } from './fallback.js';
import { formatKoreanDateTime } from './format.js';
import { OUTPUT_INSTRUCTIONS, buildOutputPrompt } from './prompt.js';

/**
 * «port» OutputModel — 출력 체인 모델 (기술 스택: LangChain). 어댑터는 @deskpet/llm.
 * 모델은 문장·표정 제안만 한다. 업무 status·사실 식별자는 일반 코드가 복사하며 모델이 수정하지 않는다.
 */
export interface OutputModelInput {
  instructions: string;
  /** 기준 문장·필수 토큰·상태만 담은 입력 (prompt.ts) */
  prompt: string;
  maxChars: number;
  allowedEmotions: string[];
  deadlineMs: number;
}

export interface OutputModel {
  generate(input: OutputModelInput): Promise<{ text: string; displayText?: string; emotion?: string }>;
}

export interface OutputServiceOptions {
  model?: OutputModel;
  /** interface-contracts §7 제안 timeout 5초 */
  modelTimeoutMs?: number;
}

/** 성공을 확인하지 못한 작업에 쓰면 안 되는 완료 표현 */
const SUCCESS_PHRASES: Record<string, RegExp> = {
  // 화면용 짧은 표현("승인 완료", "승인 성공")도 함께 막는다
  submit_approval: /승인(했|됐|됨|을 완료|이 완료|\s*완료|\s*성공)/,
  complete_stage: /(반영(했|됐|됨|\s*완료|\s*성공)|완료(로|됐|했|\s*처리))/,
};

export class OutputService {
  constructor(private readonly o: OutputServiceOptions = {}) {}

  async generate(raw: OutputRequest): Promise<OutputContent> {
    const req = OutputRequestSchema.parse(raw);
    const statuses = req.actionResults.map((a) => ({ operationId: a.operationId, status: a.status }));
    const fb = this.fallback(req.facts, req);
    // 성공하지 않은 쓰기 결과와 판정 대기는 모델로 바꿔 쓰지 않고 고정 상태 문장만 쓴다 (감사 F-02)
    if (this.o.model && fixedStatusOnly(req)) {
      return { ...fb, actionStatuses: statuses, validationResult: { passed: true, failures: [] }, fallbackUsed: true };
    }
    if (this.o.model) {
      const t0 = Date.now();
      const ms = () => ({ modelMs: Date.now() - t0 });
      try {
        const draft = await withTimeout(
          this.o.model.generate({
            instructions: OUTPUT_INSTRUCTIONS,
            prompt: buildOutputPrompt(req, fb),
            maxChars: req.constraints.maxSpeechChars,
            allowedEmotions: req.constraints.allowedEmotions,
            deadlineMs: this.o.modelTimeoutMs ?? 5_000,
          }),
          this.o.modelTimeoutMs ?? 5_000,
        );
        const emotion = req.constraints.allowedEmotions.includes(draft.emotion as Emotion) ? (draft.emotion as Emotion) : fb.emotion;
        // 모델이 화면 문장을 냈으면 그것도 같은 기준으로 검사한다. 내지 않았으면 고정 화면 문장을 쓴다
        const failures = this.validate({ text: draft.text, ...(draft.displayText !== undefined ? { displayText: draft.displayText } : {}) }, req);
        if (failures.length === 0) {
          return { outputId: req.outputId, text: draft.text, displayText: draft.displayText ?? fb.displayText, emotion, actionStatuses: statuses, validationResult: { passed: true, failures: [] }, fallbackUsed: false, ...ms() };
        }
        return { ...fb, actionStatuses: statuses, validationResult: { passed: false, failures }, fallbackUsed: true, ...ms() };
      } catch (e) {
        return { ...fb, actionStatuses: statuses, validationResult: { passed: false, failures: [`model_error:${e instanceof Error ? e.message : 'unknown'}`] }, fallbackUsed: true, ...ms() };
      }
    }
    return { ...fb, actionStatuses: statuses, validationResult: { passed: true, failures: [] }, fallbackUsed: true };
  }

  /**
   * 필수 의미 보존·상태 왜곡 금지·리마인더 일시 포함·길이 검사.
   * 음성(text)과 화면(displayText)에 같은 기준을 적용한다. 화면 실패는 `display:` 접두사로 구분한다.
   * displayText가 없으면 고정 화면 문장을 쓰므로 검사하지 않는다.
   */
  validate(content: { text: string; displayText?: string }, req: OutputRequest): string[] {
    const f = checkSurface(content.text, req);
    if (content.displayText !== undefined) f.push(...checkSurface(content.displayText, req).map((x) => `display:${x}`));
    return f;
  }

  fallback(_facts: Record<string, unknown>, req: OutputRequest): Omit<OutputContent, 'actionStatuses' | 'validationResult' | 'fallbackUsed'> {
    const fb = fallbackText(req);
    return { outputId: req.outputId, text: fb.text, displayText: fb.displayText, emotion: req.constraints.allowedEmotions.includes(fb.emotion) ? fb.emotion : 'neutral' };
  }
}

function checkSurface(raw: string, req: OutputRequest): string[] {
  const f: string[] = [];
  const text = raw.trim();
  if (!text) f.push('empty_text');
  if (text.length > req.constraints.maxSpeechChars) f.push('too_long');
  for (const token of req.requiredMeaning) if (!text.includes(token)) f.push(`missing_required:${token}`);
  // 입력 사실에 없는 저장소·PR 번호·커밋을 섞으면 안 된다 (감사 F-02)
  for (const x of foreignIdentifiers(text, allowedIdentifiers(req))) f.push(`foreign_identifier:${x}`);
  for (const a of req.actionResults) {
    const re = SUCCESS_PHRASES[a.action];
    if (re && a.status !== 'succeeded' && re.test(text)) f.push(`success_claim_without_success:${a.action}`);
  }
  if (req.purpose === 'reminder' && req.reminder) {
    const due = formatKoreanDateTime(req.reminder.dueAt, req.reminder.timezone);
    if (!text.includes(due)) f.push('reminder_due_missing');
    if (!text.includes(req.reminder.description.replace(/[.。]$/, '').slice(0, 8))) f.push('reminder_description_missing');
  }
  return f;
}


const WRITE_ACTIONS = new Set(['submit_approval', 'complete_stage']);

/** 모델 문장을 쓰지 않을 결과: 성공하지 않은 쓰기 작업 또는 판정 대기 */
export function fixedStatusOnly(req: OutputRequest): boolean {
  if (req.facts['assessmentPending']) return true;
  return req.actionResults.some((a) => WRITE_ACTIONS.has(a.action) && a.status !== 'succeeded');
}

/** 출력 요청 사실에 들어 있는 저장소·PR 번호·커밋. 모델 문장의 식별자는 이 안에 있어야 한다 */
export function allowedIdentifiers(req: OutputRequest): AllowedIdentifiers {
  const allowed = emptyAllowed();
  const scope = (req.facts['question'] as { scope?: ConfirmationScope } | undefined)?.scope;
  if (scope) allowedFromScope(scope, allowed);
  for (const a of req.actionResults) {
    if (a.target.kind === 'github_pr') {
      allowed.repositories.add(`${a.target.repository.owner}/${a.target.repository.name}`.toLowerCase());
      allowed.prNumbers.add(a.target.prNumber);
    }
  }
  collect(req.facts, allowed, 0);
  // 기준 문장(파이프라인 경계)에 이미 있는 식별자는 허용한다
  const base = req.facts['baseText'];
  if (typeof base === 'string') {
    const m = mentionedIdentifiers(base);
    m.repositories.forEach((x) => allowed.repositories.add(x));
    m.prNumbers.forEach((x) => allowed.prNumbers.add(x));
    m.shas.forEach((x) => allowed.shas.add(x));
  }
  return allowed;
}

function collect(v: unknown, into: AllowedIdentifiers, depth: number): void {
  if (depth > 6 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const x of v) collect(x, into, depth + 1);
    return;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'repository') {
      if (typeof x === 'string') into.repositories.add(x.toLowerCase());
      else if (x && typeof x === 'object' && 'owner' in x && 'name' in x) into.repositories.add(`${String((x as { owner: unknown }).owner)}/${String((x as { name: unknown }).name)}`.toLowerCase());
    } else if (k === 'prNumber' && typeof x === 'number') into.prNumbers.add(x);
    else if (/sha$|^commitId$/i.test(k) && typeof x === 'string' && x) into.shas.add(x);
    else collect(x, into, depth + 1);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
