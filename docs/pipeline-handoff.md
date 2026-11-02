# 파이프라인 연결 안내 (Harness 서버)

파이프라인(손한솔 님)이 Harness에 붙을 때 볼 한 장. 자세한 내용은 `ws-protocol.md`(연결·Envelope), `pipeline-bridge.md`(메시지별 형식 P-01~P-23).

## 1. 접속

| 항목 | 값 |
| --- | --- |
| 주소 | `ws://<Harness 서버>:8787` (같은 기기면 `ws://127.0.0.1:8787`). 다른 기기면 서버 쪽 `HARNESS_WS_ALLOWED_CLIENTS`에 그 기기 IP를 넣어야 한다 (`remote-access.md`) |
| 첫 프레임 (5초 안) | `{"type":"hello","token":"<pipeline 토큰>","role":"pipeline","client":"deskpet-pipeline"}` → `{"type":"welcome",…,"epoch":n}` |
| 요청 | `{"type":"request","envelope":{schemaVersion:"1.0", messageId, kind, requestId, createdAt, deadlineAt?, payload}}` → `{"type":"reply", causationId: messageId, ok, kind, payload}` |
| 실행 요청 deadline | `harness.run`, `eureka.execute`는 `deadlineAt` 필수 |
| 같은 요청 다시 보내기 | 같은 `messageId` → 같은 응답 (다시 실행 안 함). 연결이 끊겨도 처리 중인 요청은 끝까지 처리된다 |
| 상태 구독 (선택) | `{"type":"subscribe","source":"harness"}` → snapshot 1회 + 이벤트 |

## 2. 보내는 메시지 (파이프라인 문서 형식)

| kind | 언제 |
| --- | --- |
| `harness.run` | PR 리뷰·승인·그 답변. `action.decision`(RouteDecision) + `transcript`(STT 문장·신뢰도) + `context` + `mutationApproved` + (확장) `taskRefs` |
| `output.generate` | 출력 모델로 말할 문장 만들기. 질문이면 `requiredText`에 Harness가 준 `question`을 넣는다 |
| `pipeline.event` | **질문을 실제로 다 말한 뒤** `question_delivered`(+`deliveredText`). 이 보고가 없으면 답을 받지 않는다. 그 밖에 `speech_started`, `question_wait_expired`, `target_changed`, `request_cancelled` |
| `eureka.execute` | 업무 목록·상태·기한 변경·등록·완료 (직접 경로). 쓰기는 사용자 확인 뒤 `mutationApproved:true` |
| `eureka.reminders` / `eureka.reminder` | 리마인더 후보 (설명·마감) — 지금 Eureka에 설명 필드가 없어 0건 (C-08) |
| `eureka.links` | 업무의 단계 기록에서 연결된 PR 찾기 → `links[0]`으로 `resolvedTarget`·`taskRefs`를 채워 `harness.run` |
| `harness.reconcile` / `eureka.reconcile` | 결과 불명 작업 확인 (다시 보내지 않음) |

## 3. 맞춰야 할 값 (잠정 — 같이 정하기)

| 항목 | 지금 Harness가 기대하는 값 |
| --- | --- |
| 라우터 intention | `pr.review`, `pr.approve`, `pr.summary`, `confirm.approve`, `confirm.reject`, `eureka.retry`, `eureka.list`·`status`·`postpone`·`register`·`complete` |
| 음성 신뢰도 | `transcript.sttConfidence` 실제 값. 승인 답변은 0.85 이상, 라우터 `overallConfidence` 0.8 이상이어야 쓰기 진행 |
| 승인 답변 | 라우터가 승인으로 판단하면 `mutationApproved:true`. Harness도 문장(응·네·승인…)을 따로 확인한다 |
| 대화 ID | 요청의 `conversationId`(확장) 또는 `context.stamp.conversationId`. 같은 대화의 새 업무 요청은 대기 중 질문을 철회한다 |

## 4. 받는 것

| 프레임 | 내용 | 할 일 |
| --- | --- | --- |
| `reply` (`harness.run`) | `{action:{status, facts}, question, resultText}`. 질문이면 `status:"needs_clarification"` + `question` | `question` 또는 `resultText`를 `output.generate`의 `requiredText`로 → TTS → 질문이면 `pipeline.event question_delivered` |
| `reply`의 진행 중 | `status:"unknown"` + `facts.inProgress:"true"` | "진행 중" 안내만. 결과는 notice로 온다 |
| `notice` | `{notice:{source, requestId, operationId, status, result, pipelineAction, pipelineQuestion?}, resultText}` — 늦게 끝난 Eureka 반영, 주기 복구 결과 | `resultText`를 말한다. `pipelineQuestion`이 있으면 일반 질문처럼 처리 (전달 보고 → 답을 `harness.run`) |
| `facts.timings` | 단계별 처리 시간 (JSON 문자열) | STT·라우터·TTS 시간과 합쳐 NFR-01 기록 |

## 5. 시험해 보기

- Harness 없이 형식만: `pnpm web:fixture` (ws://127.0.0.1:8788, pipeline 토큰 `fixture-pipeline-token-123`, 가짜 GitHub·Eureka)
- 예시 클라이언트: `demo/adapterClient.ts` (파이프라인 형식으로 보내는 실제 코드)
