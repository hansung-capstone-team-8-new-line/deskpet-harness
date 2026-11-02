import { z } from 'zod';
import { Id, UtcTimestamp } from './common.js';
import { HarnessCancel, HarnessRequest, HarnessResumeRequest, HarnessResult, PipelineEvent } from './harness.js';
import { OutputEvent, OutputRequest } from './output.js';
import { PipelineActionRequest, PipelineEurekaActionRequest, PipelineHarnessRequest, PipelineOutputRequest, PipelineLinksRequest, PipelineReminderRequest, PipelineRemindersRequest } from './pipelineBridge.js';
import { OperationUpdated, Tombstone } from './projection.js';

/**
 * 공통 메시지 봉투.
 * 근거: message-contracts §Envelope and Identity (causationId 통일 제안을 따름 — README C-02).
 *
 * - 지원하지 않는 major, 알 수 없는 kind, payload 타입 오류는 실행 전에 거부한다.
 * - deadlineAt은 실행 요청에 필수.
 */

export const SUPPORTED_MAJOR = 1;

export const SchemaVersion = z
  .string()
  .regex(/^\d+\.\d+$/, 'schemaVersion must be "<major>.<minor>"')
  .refine((v) => Number(v.split('.')[0]) === SUPPORTED_MAJOR, { message: `unsupported major (supported: ${SUPPORTED_MAJOR})` });

export const PAYLOAD_BY_KIND = {
  'harness.request': HarnessRequest,
  'harness.resume': HarnessResumeRequest,
  'harness.result': HarnessResult,
  /** 명시적 취소 (서비스 경계) */
  'harness.cancel': HarnessCancel,
  /** HarnessResult로 출력 문장 생성 요청 (매핑은 서버의 HarnessOutputMapper가 한다) */
  'output.from_result': HarnessResult,
  'pipeline.event': PipelineEvent,
  'output.request': OutputRequest,
  /** 파이프라인 문서 형식 (pipelineBridge.ts): HarnessAdapter.run / reconcile, OutputModel.generate */
  'harness.run': PipelineHarnessRequest,
  'harness.reconcile': PipelineActionRequest,
  'output.generate': PipelineOutputRequest,
  /** 파이프라인 문서 EurekaAdapter: execute / reconcile / reminders / reminder(itemId) */
  'eureka.execute': PipelineEurekaActionRequest,
  'eureka.reconcile': PipelineActionRequest,
  'eureka.reminders': PipelineRemindersRequest,
  'eureka.reminder': PipelineReminderRequest,
  'eureka.links': PipelineLinksRequest,
  'output.event': OutputEvent,
  'operation.updated': OperationUpdated,
  'projection.tombstone': Tombstone,
} as const;

export type EnvelopeKind = keyof typeof PAYLOAD_BY_KIND;
export const EnvelopeKind = z.enum(Object.keys(PAYLOAD_BY_KIND) as [EnvelopeKind, ...EnvelopeKind[]]);

/** 실행 요청 종류: deadlineAt 필수 */
export const EXECUTION_KINDS: ReadonlySet<EnvelopeKind> = new Set(['harness.request', 'harness.resume', 'harness.run', 'eureka.execute']);

const EnvelopeHeader = z.object({
  schemaVersion: SchemaVersion,
  messageId: Id,
  kind: EnvelopeKind,
  requestId: Id,
  causationId: Id.optional(),
  createdAt: UtcTimestamp,
  deadlineAt: UtcTimestamp.optional(),
  payload: z.unknown(),
});

export type Envelope<K extends EnvelopeKind = EnvelopeKind> = Omit<z.infer<typeof EnvelopeHeader>, 'kind' | 'payload'> & {
  kind: K;
  payload: z.infer<(typeof PAYLOAD_BY_KIND)[K]>;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** 봉투 + kind별 payload를 검증한다. 실패하면 실행하지 않는다. */
export function parseEnvelope(input: unknown): ParseResult<Envelope> {
  const header = EnvelopeHeader.safeParse(input);
  if (!header.success) return { ok: false, issues: header.error.issues.map(fmt) };
  const h = header.data;
  if (EXECUTION_KINDS.has(h.kind) && !h.deadlineAt) {
    return { ok: false, issues: ['deadlineAt: required for execution requests'] };
  }
  const schema = PAYLOAD_BY_KIND[h.kind] as z.ZodTypeAny;
  const payload = schema.safeParse(h.payload);
  if (!payload.success) return { ok: false, issues: payload.error.issues.map((i) => `payload.${fmt(i)}`) };
  // 봉투와 payload가 서로 다른 요청을 가리키면 실행하지 않는다 (감사 F-05)
  const inner = payloadRequestId(h.kind, payload.data);
  if (inner !== undefined && inner !== h.requestId) {
    return { ok: false, issues: [`requestId: envelope requestId does not match payload (${inner})`] };
  }
  return { ok: true, value: { ...h, payload: payload.data } as Envelope };
}

/** payload가 가리키는 요청 ID. 봉투 requestId와 같아야 한다. 해당 필드가 없는 kind는 undefined */
export function payloadRequestId(kind: EnvelopeKind, payload: unknown): string | undefined {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (kind) {
    case 'harness.request':
    case 'harness.cancel':
    case 'harness.result':
    case 'output.from_result':
    case 'pipeline.event':
      return typeof p['requestId'] === 'string' ? p['requestId'] : undefined;
    case 'harness.resume':
      return typeof p['originalRequestId'] === 'string' ? p['originalRequestId'] : undefined;
    case 'harness.run': {
      const a = p['action'] as { requestId?: unknown } | undefined;
      return typeof a?.requestId === 'string' ? a.requestId : undefined;
    }
    case 'harness.reconcile':
    case 'output.generate':
    case 'eureka.execute':
    case 'eureka.reconcile':
    case 'eureka.reminders':
    case 'eureka.reminder':
    case 'eureka.links':
      return typeof p['requestId'] === 'string' ? p['requestId'] : undefined;
    case 'output.request': {
      const refs = p['requestRefs'] as { requestId?: unknown } | undefined;
      return typeof refs?.requestId === 'string' ? refs.requestId : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * 봉투 deadline과 payload 안 실행 deadline 중 이른 쪽을 실행 deadline으로 쓴다 (감사 F-05).
 * 봉투에 deadline이 없거나 payload deadline이 더 이르면 그대로 둔다.
 */
export function clampPayloadDeadline(env: Envelope): Envelope {
  if (!env.deadlineAt) return env;
  const outer = Date.parse(env.deadlineAt);
  const clamp = (c: { deadlineAt: string }) => (Date.parse(c.deadlineAt) > outer ? { ...c, deadlineAt: env.deadlineAt! } : c);
  if (env.kind === 'harness.request') {
    const p = env.payload as Envelope<'harness.request'>['payload'];
    return { ...env, payload: { ...p, constraints: clamp(p.constraints) } } as Envelope;
  }
  if (env.kind === 'harness.run') {
    const p = env.payload as Envelope<'harness.run'>['payload'];
    return { ...env, payload: { ...p, action: clamp(p.action) } } as Envelope;
  }
  if (env.kind === 'eureka.execute') {
    const p = env.payload as Envelope<'eureka.execute'>['payload'];
    return { ...env, payload: clamp(p) } as Envelope;
  }
  if (env.kind === 'harness.resume') {
    const p = env.payload as Envelope<'harness.resume'>['payload'];
    return { ...env, payload: { ...p, newCallConstraints: clamp(p.newCallConstraints) } } as Envelope;
  }
  return env;
}

export function makeEnvelope<K extends EnvelopeKind>(
  kind: K,
  fields: { messageId: string; requestId: string; causationId?: string; createdAt: string; deadlineAt?: string },
  payload: z.input<(typeof PAYLOAD_BY_KIND)[K]>,
): Envelope<K> {
  const raw = { schemaVersion: `${SUPPORTED_MAJOR}.0`, kind, ...fields, payload };
  const parsed = parseEnvelope(raw);
  if (!parsed.ok) throw new Error(`invalid envelope: ${parsed.issues.join('; ')}`);
  return parsed.value as Envelope<K>;
}

function fmt(i: z.ZodIssue): string {
  return `${i.path.join('.') || '(root)'}: ${i.message}`;
}
