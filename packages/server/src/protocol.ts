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
  z.object({ type: z.literal('hello'), token: z.string().max(512), role: Role, client: z.string().max(100).optional() }),
  /** 실행·조회 요청: Envelope (harness.request | harness.resume | pipeline.event | harness.cancel | output.from_result | output.request) */
  z.object({ type: z.literal('request'), envelope: z.unknown() }),
  /** 상태 구독: snapshot 한 번 → 이후 변경 이벤트 */
  z.object({ type: z.literal('subscribe'), source: z.literal('harness') }),
  z.object({ type: z.literal('ping'), id: z.string().max(100) }),
  /** 세션 기록 읽기 (D-47). viewer도 가능. 이후 새 기록은 history.appended로 받는다 */
  z.object({ type: z.literal('history'), beforeId: z.string().max(200).optional(), limit: z.number().int().min(1).max(500).optional() }),
  /**
   * 관리 동작 (D-50). 관리 토큰(HARNESS_WEB_ADMIN_TOKEN)이 맞아야 한다. 연결 역할과 별개로 매번 토큰을 확인한다.
   * update.check: 지금 새 버전 확인 / update.apply: git pull(빨리 감기만) → 설치 → 웹 빌드 → 재시작
   */
  /** 현황 다시 읽기 (D-51). viewer도 가능, 서버가 자주 누르는 것을 걸러 낸다 */
  z.object({ type: z.literal('overview.refresh') }),
  z.object({
    type: z.literal('admin'),
    token: z.string().max(512),
    action: z.enum(['update.check', 'update.apply']),
    id: z.string().max(100).optional(),
  }),
  /** 사용자 설정 저장 (D-52): 승인 허용 저장소. 관리 토큰 없이 접속한 화면 누구나 (사용자 결정 2026-11-14) */
  z.object({ type: z.literal('settings.set'), id: z.string().max(100).optional(), settings: z.object({ allowedRepositories: z.array(z.string().max(200)).max(50) }) }),
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
  /** held: 파이프라인 연결이 없던 동안 보관했다가 연결 직후 보낸 알림 */
  | { type: 'notice'; notice: unknown; resultText: string; held?: boolean }
  | { type: 'pong'; id: string }
  /** 세션 기록 한 쪽 (최신 순) */
  | { type: 'history'; entries: unknown[]; hasMore: boolean; sessionId: string }
  /** 새 세션 기록 (기록을 한 번이라도 읽은 연결에만) */
  | { type: 'history.appended'; entry: unknown }
  /** 서버 정보: 버전·업데이트 상태·관리 기능 여부 (D-49). 접속 직후와 바뀔 때 */
  | { type: 'server.info'; info: unknown }
  /** 현황: 진행 중 업무·리마인더·링크 (D-51). 접속 직후와 바뀔 때 */
  | { type: 'overview'; overview: unknown }
  | { type: 'admin.result'; id?: string; action: string; ok: boolean; message: string }
  | { type: 'settings.result'; id?: string; ok: boolean; message: string }
  | { type: 'error'; code: ErrorCode; message: string };

/** 연결 종료 코드 (4000번대: 애플리케이션 정의) */
export const CLOSE = {
  unauthorized: 4001,
  helloTimeout: 4002,
  slowConsumer: 4008,
  shuttingDown: 1001,
} as const;
