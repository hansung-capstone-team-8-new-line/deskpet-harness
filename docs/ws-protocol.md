# Harness 서비스 경계 — WebSocket (`deskpet.harness.v1`)

> 잠정 경계 (README D-15). 파이프라인(손한솔) 연결 시 수정한다.

## 구성

```
[파이프라인 / demo 클라이언트] ──ws──▶ HarnessWsServer ──▶ HarnessInbound(변환 층) ──▶ HarnessService · OutputService
[웹 화면(viewer)]             ──ws──▶        └─ 구독: snapshot + 상태 이벤트 (OperationStore.subscribe)
```

| 위치 | 역할 | 파이프라인 연결 시 |
| --- | --- | --- |
| `packages/server/src/protocol.ts` | 프레임 형식 | 필요하면 수정 |
| `packages/server/src/inbound.ts` | Envelope → Harness 호출 변환 (지금은 그대로 전달) | 입력 형식이 바뀌면 여기서 변환 |
| `packages/server/src/HarnessWsServer.ts` | 인증·역할·상한·재전송·구독 | 그대로 |
| `packages/server/src/operatorGate.ts` | (사용 안 함, D-22) 쓰기 직전 서버 콘솔 `yes` 확인 | 다시 필요해지면 서버에서 연결 |
| `scripts/server.ts` | 실행 진입점 (`pnpm harness`) — `pnpm server`는 pnpm 자체 명령이라 쓰지 않는다 | 그대로 |
| `demo/` | 파이프라인 흉내 클라이언트 (`pnpm demo`) | **폴더째 삭제 가능** (서버는 import하지 않음) |

## 연결

1. WebSocket 연결 (기본 `ws://127.0.0.1:8787`). 브라우저는 `HARNESS_WS_ALLOWED_ORIGINS`에 있는 Origin만 허용 (403).
2. 첫 프레임 `{"type":"hello","token":"…","role":"pipeline"|"viewer","client":"…"}` (5초 안에). 실패 시 4001, 시간 초과 4002.
3. 서버 `{"type":"welcome","protocol":"deskpet.harness.v1","schemaVersion":"1.0","role":…,"epoch":…}`.

역할: `pipeline` = 실행 + 구독, `viewer` = 구독만 (실행 요청은 `forbidden`).

## 요청 / 응답

```json
{"type":"request","envelope":{"schemaVersion":"1.0","messageId":"m-1","kind":"harness.request","requestId":"req-1",
  "createdAt":"…","deadlineAt":"…","payload":{ HarnessRequest }}}
```

| kind (Envelope) | payload | 응답 kind | 비고 |
| --- | --- | --- | --- |
| `harness.request` | HarnessRequest | `harness.result` | deadlineAt 필수 |
| `harness.resume` | HarnessResumeRequest | `harness.result` | deadlineAt 필수 |
| `pipeline.event` | PipelineEvent | `pipeline.event.result` (`{applied, reason?}`) | 질문 전달·발화 시작 등. 확인 질문의 `question_delivered`는 실제로 말한 문장 `deliveredText` 필수 |
| `harness.cancel` | `{requestId, reason}` | `harness.cancel.result` | **명시적 취소만 취소** |
| `output.from_result` | HarnessResult | `output.content` (OutputContent) | 서버가 매핑 후 출력 생성 |
| `output.request` | OutputRequest | `output.content` | |
| `harness.run` | 파이프라인 문서 HarnessRequest | `harness.run.result` | deadlineAt 필수. `docs/pipeline-bridge.md` |
| `harness.reconcile` | 파이프라인 문서 ActionRequest | `action.result` | 다시 보내지 않고 조회로만 확인 |
| `output.generate` | 파이프라인 문서 OutputRequest | `output.text` (`{text}`) | requiredText 유지 |
| `eureka.execute` / `eureka.reconcile` | 파이프라인 문서 ActionRequest | `action.result` | 직접 Eureka 경로. 쓰기는 mutationApproved 필요 |
| `eureka.reminders` / `eureka.reminder` | `{requestId}` / `{requestId, itemId}` | `eureka.reminders.result` / `eureka.reminder.result` | 읽기 전용 |
| `eureka.links` | `{requestId, itemId}` | `eureka.links.result` | 읽기 전용. 단계 기록의 PR 주소 → 연결된 PR (pipeline-bridge P-19) |

응답: `{"type":"reply","causationId":"<요청 messageId>","requestId":"…","ok":true,"kind":"…","payload":…}`
오류: `{"type":"reply","ok":false,"error":{"code":"invalid_message|forbidden|unsupported_kind|too_many_in_flight|deadline_exceeded|shutting_down|internal","message":"…","issues":[…]}}`

- Envelope 검증 실패, 지원하지 않는 major(`2.x`), 받지 않는 kind는 **실행 전에** 거부.
- 봉투 `requestId`와 payload의 요청(`requestId` / resume은 `originalRequestId` / output.request는 `requestRefs.requestId`)이 다르면 `invalid_message`.
- 봉투 `deadlineAt`이 이미 지났으면 `deadline_exceeded`로 실행하지 않는다 (같은 messageId 재전달은 저장된 응답). 실행 deadline은 봉투와 payload deadline 중 이른 쪽.
- 확인 질문 전달 보고(`question_delivered`)는 `deliveredText`에 코드가 만든 범위 문구(예: `NewLine/DeskPet PR 42번, 현재 커밋 a1b2c3d` + `승인`)가 그대로 있고 다른 저장소·PR·커밋이 없을 때만 반영된다. 아니면 `{applied:false, reason:"question_scope_mismatch" | "delivered_text_required"}`이고, 그 질문에 대한 답은 실행되지 않는다.
- `internal` 오류는 원문을 응답에 넣지 않는다 (서버 로그에 오류 이름만). 다시 보내기 전에 상태를 확인할 것.

## 끊김·재전송 (중복 실행 방지)

- **연결 끊김은 취소가 아니다.** 받은 요청은 끝까지 처리되고 결과는 Harness 기록에 남는다.
- 같은 `messageId` 재전송 → 실행 없이 같은 응답 (최근 1,000개). 같은 messageId에 다른 내용 → `invalid_message`.
- 연결이 바뀌어 응답을 못 받았으면 **같은 `turnId`로 다시 보낸다** → Harness가 저장된 결과를 돌려준다 (턴 결과 보존 1시간).
- 승인 같은 쓰기는 어떤 경우에도 경계에서 다시 보내지 않는다 (Harness·DispatchOwner 규칙).

## 상태 구독

`{"type":"subscribe","source":"harness"}` →
1. `{"type":"snapshot","snapshot":{source:"harness",scope:"all",epoch,objectsWithRevisions,tombstones}}` (operation·pending·confirmation을 같은 시점에)
2. 이후 `{"type":"event","event":OperationUpdated|Tombstone}` — snapshot을 읽기 전에 수집을 시작하므로 누락 없음.

클라이언트는 entity별 더 높은 revision만 적용한다 (RequestStateProjector). epoch가 바뀌면(서버 재시작) 다시 구독한다.

### notice (D-23)

요청이 끝난 뒤 확정된 결과는 구독과 별개로 pipeline 연결에 `{"type":"notice","notice":FollowUpNotice,"resultText":"고정 문구"}`로 온다. 대상: 잠깐 기다려도 끝나지 않았던 Eureka 반영(`late_completion`), 주기 복구가 확정한 결과(`recovery`). viewer 연결에는 보내지 않는다. 자세한 형식은 `pipeline-bridge.md` P-20~P-22.

## 상한·운영

| 항목 | 기본값 |
| --- | --- |
| 바인딩 | `127.0.0.1` |
| 메시지 크기 | 256KB (초과 시 1009로 끊음) |
| 연결당 동시 요청 | 8 (control 칸 제외) |
| 서버 전체 동시 요청 | 32 (`maxInFlightTotal`, control 칸 제외) |
| 칸별 동시 요청 (D-24) | work(harness.*·output.*) 16 / eureka(eureka.*) 16 / control(pipeline.event·harness.cancel·*.reconcile) 64 (`maxInFlightByLane`). control은 다른 칸·연결 상한과 별도라 승인 흐름이 입구에서 막히지 않음 |
| 자원별 동시 호출 (D-24) | LLM 2건, 자리 대기 0.5초 뒤 호출하지 않고 규칙·고정 문구로 (`LLM_MAX_CONCURRENT`, `LLM_QUEUE_WAIT_MS`) / GitHub 4건, Eureka 4건 — 호출의 남은 시간 안에서 기다리고 끝내 자리가 없으면 보내지 않음(`not_sent`) (`GITHUB_MAX_CONCURRENT`, `EUREKA_MAX_CONCURRENT`) |
| 구독 snapshot 중 대기 이벤트 | 1,000 초과 시 그 연결을 4008로 끊어 다시 구독하게 함 (`maxPendingEvents`) |
| 송신 버퍼 | 1MB 초과 시 느린 연결을 4008로 끊음 (Harness를 막지 않음) |
| 종료 | SIGINT/SIGTERM → 새 요청 거부, 처리 중 요청 최대 30초 기다린 뒤 닫고 저장소 close |
| 시작 | 저장소 열기 → 보존 정리 → 결과 확인이 필요한 쓰기를 읽기로만 확인 → 서버 시작 |

## 쓰기

- 기본은 쓰기 비활성.
- `pnpm harness --allow-github-writes`일 때만 GitHub 승인 전송 가능. `DESKPET_STORE_PATH`(영속 저장소)가 없으면 시작하지 않는다.
- 승인은 요청 쪽 사용자 확인(질문 전달 보고 + 승인 답변)만으로 받는다. 서버 콘솔 `yes` 확인은 없앴다 (D-22).
- 보내기 직전 head SHA·PR 상태·권한·필수 검사를 다시 확인한 다음에만 보낸다 (DurableAck 전).
- Eureka 쓰기는 `pnpm harness --allow-eureka-writes`일 때만, 개발 환경(flw-d1)에서만 (D-20).

## 문서와 다른 점 (C-14)

기술 스택 문서는 보드 안 프로세스 간 통신 후보로 gRPC·ZeroMQ를 적었고 WebSocket은 없다. 웹 화면(I-19)은 WebSocket이 자연스럽고, 파이프라인 쪽은 손한솔과 합의가 필요하다. 변환 층(`HarnessInbound`)이 전송과 분리되어 있어 gRPC 등으로 바꿔도 Harness·변환 층은 그대로 쓴다.

## 실행

```
# 터미널 1
pnpm harness                  # 또는 pnpm harness --allow-github-writes
# 터미널 2
pnpm demo 12                 # 기존 데모와 같은 입력·출력
pnpm demo 12 --ask "이 PR 뭐가 바뀌었어?"
```

## 검증

`tests/e2e/ws.test.ts` — 실제 localhost WebSocket: 토큰·hello 시간 초과·viewer 권한·Origin 거부, Envelope 거부(데드라인 없음·major 2·payload 오류·kind), 크기 상한, G-01 전체 흐름과 출력, 답변 직후 연결 끊김에도 승인 처리 + 같은 turnId 재전송 시 저장된 결과(GitHub 전송 1회), 같은 messageId 재전송, 명시적 취소, snapshot→이벤트 순서와 epoch.
