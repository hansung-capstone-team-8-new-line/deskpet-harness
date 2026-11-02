import { z } from 'zod';

/**
 * Harness 서비스 경계 — WebSocket 프레임 (프로토콜 `deskpet.harness.v1`).
 * 실행 요청의 본문은 contracts의 Envelope를 그대로 쓴다 (message-contracts §Envelope and Identity).
 * 프레임은 전송 계층의 껍데기일 뿐이고, 의미는 Envelope kind와 payload가 정한다.
 * 파이프라인 연결 시 바뀌는 곳: 이 파일(프레임)과 inbound.ts(변환 층). HarnessService는 그대로 둔다.
 */
export const PROTOCOL = 'deskpet.harness.v1';

export const Role = z.enum(['pipeline', 'viewer']);
export type Role = z.infer<typeof Role>;

// ------------------------------------------------------------ client → server
export const ClientFrame = z.discriminatedUnion('type', [
  /** 첫 프레임. 토큰은 로그에 남기지 않는다 */
  z.object({ type: z.literal('hello'), token: z.string().min(1).max(512), role: Role, client: z.string().max(100).optional() }),
  /** 실행·조회 요청: Envelope (harness.request | harness.resume | pipeline.event | harness.cancel | output.from_result | output.request) */
  z.object({ type: z.literal('request'), envelope: z.unknown() }),
  /** 상태 구독: snapshot 한 번 → 이후 변경 이벤트 */
  z.object({ type: z.literal('subscribe'), source: z.literal('harness') }),
  z.object({ type: z.literal('ping'), id: z.string().max(100) }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ------------------------------------------------------------ server → client
export type ErrorCode =
  | 'unauthorized'
  | 'hello_required'
  | 'forbidden'
  | 'invalid_frame'
  | 'invalid_message'
  | 'unsupported_kind'
  | 'too_many_in_flight'
  | 'deadline_exceeded'
  | 'shutting_down'
  | 'internal';

export type ServerFrame =
  | { type: 'welcome'; protocol: typeof PROTOCOL; schemaVersion: string; role: Role; epoch: number; serverTime: string }
  | {
      type: 'reply';
      /** 요청 Envelope의 messageId */
      causationId: string;
      requestId: string;
      ok: true;
      /** harness.result | pipeline.event.result | harness.cancel.result | output.content */
      kind: string;
      payload: unknown;
    }
  | { type: 'reply'; causationId: string | null; requestId: string | null; ok: false; error: { code: ErrorCode; message: string; issues?: string[] } }
  | { type: 'snapshot'; snapshot: unknown }
  | { type: 'event'; event: unknown }
  /** 요청이 끝난 뒤 확정된 결과 (D-23). pipeline 연결에만 보낸다. resultText는 고정 문구 */
  | { type: 'notice'; notice: unknown; resultText: string }
  | { type: 'pong'; id: string }
  | { type: 'error'; code: ErrorCode; message: string };

/** 연결 종료 코드 (4000번대: 애플리케이션 정의) */
export const CLOSE = {
  unauthorized: 4001,
  helloTimeout: 4002,
  slowConsumer: 4008,
  shuttingDown: 1001,
} as const;
