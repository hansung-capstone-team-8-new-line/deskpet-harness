---
type: framework
topics:
  - deskpet
  - agentic-systems
status: draft
sources:
  - "사용자와의 메시지 규격화 설계 대화 및 상세화 위임 (2026-10-03)"
  - "[[wiki/deskpet_LLM_guide_Liability|김도헌 DeskPet LLM 설계 규칙]]"
  - "[[wiki/deskpet-interface-contracts|DeskPet Interface Contracts]]"
  - "https://github.com/github/github-mcp-server/blob/main/pkg/github/pullrequests.go"
  - "https://github.com/github/github-mcp-server#tools"
  - "https://docs.github.com/en/rest/pulls/reviews"
created: "2026-10-03"
updated: "2026-10-04"
---

# DeskPet Harness Message Contracts

## Summary

Harness, Gateway, 출력 체인, 웹 상태 변환 사이의 잠정 메시지 계약이다. 공통 타입은 기존 위키를 재사용하며 아래 필드·enum·메서드는 구현 전 제안이다. JSON Schema, 실제 MCP payload, HTTP endpoint를 확정한 문서가 아니다. 실행 정책의 원본은 [[wiki/deskpet_LLM_guide_Liability|LLM 설계 규칙]]이다.

## Principles

- 호출 처리 상태, 업무 결과, 사용자 확인, 출력 전달 상태를 별도로 표현한다.
- 값 없음, 조회하지 않음, 확인 불가, 미지원, 잘림을 구분한다.
- 버전·출처·전송 여부를 증거보다 강하게 주장하지 않는다.
- 인증키·토큰을 메시지나 진단 기록에 넣지 않는다. 프로세스 간 호출은 인증된 경계가 필요하며 타입만으로 신뢰를 보장하지 않는다.

## Workflow

### Envelope and Identity

| 필드 | 규칙 |
| --- | --- |
| schemaVersion | 필수 문자열, 초기 1.0 제안. 비호환 변경은 major 변경 |
| messageId | 필수 고유 ID. 동일 논리 메시지 재전달 시 유지 |
| kind | 필수 종류. 예: harness.request, harness.resume, harness.result, operation.updated, output.content_ready |
| requestId | 전체 요청 ID. 백그라운드 조회에도 시스템 요청 ID 부여 |
| causationId | 후속 메시지의 직전 원인 ID. 기존 parentId와 통일하는 제안 |
| createdAt | 필수 UTC RFC 3339 시각 |
| deadlineAt | 실행 요청에 필수인 절대 기한. 결과/기록 삭제 시각이 아님 |
| payload | 종류별 데이터 |

turnId는 새 발화, operationId는 논리 작업, attemptId는 실제 호출 시도, confirmationId는 사용자 확인, outputId는 출력 단위를 식별한다. revision은 같은 상태 객체 내에서만 단조 증가한다. 서버 재시작 뒤에도 revision을 유지하거나 별도 epoch와 스냅샷으로 재동기화해야 한다. 시각만으로 순서를 결정하지 않는다.

동일 메시지 재전달은 messageId 유지, 실제 호출 재시도는 operationId 유지·attemptId 교체다. 전송 취소는 인프로세스 signal 또는 인증된 취소 메시지로 매핑하며 JSON 객체에 실행 핸들을 직렬화하지 않는다. payload 타입 오류·알 수 없는 필수 enum·지원하지 않는 major는 실행 전에 거부한다. 선택 필드는 해당하지 않으면 생략하되 의미 있는 부재는 명시 상태로 보낸다.

### Harness Boundary

| 타입/메서드 | 입력 또는 반환 |
| --- | --- |
| handle(HarnessRequest) | CurrentTurnInput, ContextPacket, 실행 제약 |
| resume(HarnessResumeRequest) | 원 requestId, 새 CurrentTurnInput/ContextPacket, pendingId, expectedPendingRevision, 승인 확인이면 confirmationId, 새 호출 실행 제약 |
| HarnessResult | disposition, ActionResult 목록, 선택적 pending·출력 사실·출처·처리 오류 |

CurrentTurnInput은 conversationId, turnId, 원문, isFinal, inputChannel(voice / web), sttConfidenceState(provided / unavailable / not_applicable), 제공된 경우 sttConfidence, RouteDecision을 담는다. voice는 final만 수락하며 unavailable을 높은 신뢰도로 간주하지 않는다. web의 not_applicable은 음성 신뢰도 누락과 구분한다. RouteDecision의 confidence로 STT confidence를 대체하거나 이전 턴 값을 재사용하지 않는다. 낮은 또는 확인 불가한 음성 신뢰도에서는 승인 쓰기를 차단하고 재질문한다. 임계값과 채널 인증 방식은 통합 시 확정한다.

disposition은 completed / awaiting_user / failed / cancelled다. completed는 이번 호출 종료이지 모든 작업 성공이 아니다. cancelled도 이미 전송한 외부 작업이 취소됐다는 뜻이 아니다.

pending에는 pendingId, kind(clarification / confirmation), 질문 목적, 필요한 슬롯 또는 확인할 대상·행위·버전, 유효성 정보를 담는다. 질문 전달 시점에 시작되는 타이머는 파이프라인 책임이다. confirmation이면 확인 기록과 연결한다. 재질문은 외부 ActionResult 상태로 억지 변환하지 않는다. 기존 needs_clarification 소비자와의 호환 매핑은 별도 경계에서 처리한다.

### Pending Transitions and Concurrent Resume

pending은 Harness가 소유하며 requestId/conversationId, 원 contextId/version, revision, outputId, expiresAt, 상태(waiting / consumed / expired / revoked)를 포함한다. 파이프라인의 pendingRef는 연결용 참조이며 독립적인 승인 원본이 아니다. 질문 전달 전 waiting이라도 답변 수락은 허용하지 않는다. 파이프라인은 실제 질문 전달, 발화 시작, question_wait_expired, 대상 전환·요청 취소를 같은 요청 내 순서가 있는 이벤트로 보고한다. 이벤트에는 messageId, requestId, pendingId/outputId, source revision과 사실 발생 시각을 연결한다. resume 처리 전에 앞선 관련 이벤트가 반영돼야 하며 순서 누락은 실행을 차단한다.

무응답 대기 종료는 pending과 미소비 confirmation을 expired로 전이시킨다. 기한 내 발화 시작은 무응답 타이머만 멈추며 expiresAt이나 새 호출 deadline을 자동 연장하지 않는다. 대상 전환·요청 취소는 기존 pending 및 미소비 확인을 revoked로 만든다. UI 화면 복귀 자체는 취소 이벤트가 아니다. 재질문·범위 정정은 기존 pending을 닫고 새 pending을 발급한다. 확인 질문을 다시 발급할 때는 기존 미소비 confirmation을 revoked로 닫고 새 confirmation을 연결한다. unclear 답변도 이 규칙을 따르며 과거 답변·질문 증거는 보존한다.

Harness는 request/conversation/context 연결, 실제 질문 전달 증거, 절대 기한, 현재 턴 confidence, expectedPendingRevision을 검사한 뒤 답변 수락·pending 소비·확인 판정 및 필요한 operation 연결을 원자적으로 commit한다. 동일 turnId 재전달은 저장된 처리 결과로 응답하며 새 답변으로 소비하지 않는다. 다른 턴의 동시 답변은 먼저 유효하게 commit된 전이만 수락하고 낡은 revision은 현재 상태를 반환한다. 거절·취소·만료와 승인도 같은 직렬화 경계를 사용한다. 승인 뒤 dispatch 전 수신한 취소는 원자적으로 실행 권한을 회수할 수 있지만, 전송 가능 경계를 지난 취소를 외부 취소 성공으로 기록하지 않는다. unclear는 기존 pending을 소비하고 새 재질문으로 연결하며 승인 operation을 만들지 않는다.

ContextPacket은 contextId/version, 확정 target 또는 후보, 관련 role 포함 turns와 원 ID, pendingRef, 출처가 있는 taskRefs를 담는다. 현재 발화/RouteDecision은 중복하지 않는다. 제공된 과거 상태를 최신 상태로 취급하지 않는다.

### Confirmation Record

| 영역 | 필수 정보 |
| --- | --- |
| 식별 | confirmationId, pendingId, requestId, conversationId, revision |
| 범위 | 대상, 행위, SHA 또는 정확한 변경 내용 |
| 질문 | 필수 확인 의미, 연결 outputId, 실제 전달 내용과 채널 증거 |
| 답변 | answerTurnId, 현재 턴 입력 채널·STT confidence 상태/값·RouteDecision 근거, 사용자 답변 및 해석 근거, approved/rejected/unclear 판정 |
| 생명주기 | waiting/approved/rejected/expired/revoked 상태, 유효 기한 |
| 소비 | 연결 operationId. 하나의 확인을 여러 작업에 재사용하지 않음 |

unclear는 승인 상태가 아니며 재질문이 필요하다. 유효 기한·confidence 임계값은 설정 미정이다. 사용자에게 전달된 의미와 저장된 확인 범위를 비교한다. Gateway에 전달하는 confirmationId는 추적 참조이며 임의 ID나 approved 플래그 자체를 인증으로 사용하지 않는다.

### Review Query

getReviewContext 입력은 repository(owner/name), prNumber, requestedSections(changes/checks/reviews), 선택적 expectedHeadSha, deadline 및 유한한 페이지·결과 크기 상한이다. PR 기본 정보는 항상 조회한다.

반환은 PR 기본 정보, requestedHeadSha, initialHeadSha, observedHeadSha, diff 비교 기준, sections, consistency(verified/changed/unverified)를 담는다. 각 section은 다음을 가진다.

| 필드 | 의미 |
| --- | --- |
| availability | available / not_requested / unavailable / unsupported |
| completeness | complete / partial / unknown |
| data | 실제 확보한 자료. 리뷰가 없으면 성공적으로 조회한 빈 목록 |
| versionEvidence | 실제 응답으로 확인한 SHA·비교 기준·출처. 시작 SHA를 임의 복사하지 않음 |
| observedAt | 조회 시각 |
| pagination/truncation | 남은 페이지·잘림·제한 사실 |
| error | 조회 오류가 있는 경우 |

verified는 확보 자료의 선언된 코드 버전 일치를 뜻하며 동일 시점 스냅샷이나 모든 요청 자료 확보를 뜻하지 않는다. version 근거가 없는 section은 unverified로 보존한다. checks 조회 성공과 검사 통과는 별도다. 필수 검사 설정 판정도 결과 목록만 보고 추정하지 않는다.

2026-10-03 공식 GitHub MCP 공개 main 조회에서 get_commit.sha, get_file_contents.sha, pull_request_review_write.commitID를 확인했다. pull_request_read에는 SHA 입력이 없고 status/check runs는 내부에서 현재 PR head를 조회한다. 따라서 묶음의 SHA 일관성은 별도 구현 과제다. 실제 DeskPet 서버의 버전·설정·스키마는 미검증이며 main은 변할 수 있다. Copilot 리뷰 출처·commit 근거·상세 코멘트 확보 범위도 통합 시 검증한다.

### Write and Reconciliation

| 메서드 | 입력 | 반환 |
| --- | --- | --- |
| submitApproval | operationId, confirmationId, repository/prNumber, expectedHeadSha, 실행 제약 | ActionResult, 시도·전송 증거 |
| getApprovalOutcome | 기존 operation, 대상·SHA·제출자·시각·외부 ID 등 확보 증거 | ActionResult 또는 unknown 유지 |
| listTasks | 필터, 페이지·크기 상한, 실행 제약 | 항목, 조회 시각, 완전성·페이지 정보 |
| getTaskState | itemId, 선택적 stageId, 실행 제약 | 최신 업무·단계 상태와 조회 증거 |
| completeStage | 별도 operationId/confirmationId, itemId/stageId, GitHub 성공 증거, 기대한 변경 범위 | ActionResult |
| getChangeOutcome | 기존 Eureka operation과 전송·외부 증거 | ActionResult 또는 unknown 유지 |

Harness 경로는 Harness가, 직접 Eureka 경로는 파이프라인의 Eureka 모듈이 영속 기록과 실행 권한을 소유한다는 잠정 계약이다. operation마다 owner와 revision을 하나로 유지하며 다른 경로는 이미 존재하는 operation의 결과를 참조한다. 두 경로 모두 사용자 확인 정책, 기록·저장 공간 확보와 실행 권한 검사를 거쳐 Gateway를 호출한다. Gateway는 재시도 정책과 외부 상태 검사를 적용한다. 직접 경로의 구체 행위별 확인 정책이 없으면 쓰기를 차단한다. 이 계약이 기존 Swift 구현에 반영됐다는 뜻은 아니다.

전송 경계의 필수 순서는 다음과 같다. 내부 함수/콜백 또는 인증된 메시지로 구현할 수 있으며 Gateway가 저장소 구현에 직접 의존할 필요는 없다.

1. 소유자가 operation/attempt, 검증한 입력·ExpectedOutcome·확인 근거·정책 버전과 복구 공간 예약을 영속 저장하고 실행 권한을 원자적으로 확보한다.
2. Gateway는 실제 전송 직전에 전송 준비를 알린다. 소유자는 취소·deadline·확인 유효성을 다시 검사하고 해당 attempt를 may_have_been_sent로 영속 저장한 뒤 저장 성공 acknowledgement를 준다. acknowledgement 이전에는 전송하지 않는다. acknowledgement는 단순 접수 응답이 아니다.
3. Gateway는 유효한 해당 attempt 권한으로만 전송하고 전송·응답 증거를 보고한다. 보고 유실이나 재시작 뒤 may_have_been_sent는 unknown으로 복구한다. 전송 보고가 없다는 이유만으로 not_sent로 되돌리거나 다시 보내지 않는다. Gateway가 전송하지 않았음을 확실히 입증한 경우만 not_sent와 조건부 1회 재시도를 허용한다.
4. 실행 권한 인계는 owner revision/attempt를 비교해 원자적으로 수행한다. 이전 실행자가 살아 있거나 전송 권한을 행사할 수 있는지 불명확하면 새 쓰기 실행자를 허용하지 않는다. 로컬 lease 만료만으로 외부 전송 가능성이 사라졌다고 간주하지 않는다. 결과 조회 권한은 쓰기 권한과 분리한다.

단계 2의 저장과 외부 전송 사이를 하나의 트랜잭션으로 만들 수 있다고 주장하지 않는다. acknowledgement 유실 등 실제 전송이 없었던 경우도 unknown으로 남을 수 있다. 구체 transport·저장소·실행자 배제 방식은 통합 검증 대상이다.

getApprovalOutcome/getChangeOutcome은 쓰기를 실행하지 않는다. 일치 결과를 찾지 못한 것은 실패 증거가 아니다. 이미 과거에 존재하던 성공 상태와 이번 operation 성공을 구분하며, 필요한 인과 증거가 없으면 현재 상태를 facts로 반환하되 operation은 unknown으로 남긴다.

제출자·SHA·시각 일치는 후보를 좁히는 근거이며 단독으로 충분한 인과 증거를 보장하지 않는다. 실제 제출 응답과 연결된 외부 ID 또는 이번 operation을 유일하게 식별하는 검증된 외부 근거가 필요하다. 외부 ID가 있는 기존 승인도 이번 제출에서 생성됐다는 연결 없이 재사용하지 않는다.

2026-10-03 검토에서 확인한 [공식 GitHub MCP 공개 main의 CreatePullRequestReview](https://github.com/github/github-mcp-server/blob/main/pkg/github/pullrequests.go)는 내부 mutation에서 ID를 선택하지만 도구 응답에는 성공 문구만 반환한다. 따라서 commitID 입력 지원만으로 review ID·상태·SHA 반환까지 보장하지 않는다. [GitHub REST 리뷰 생성](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)은 이 정보를 응답에 포함하는 경로다. Gateway 통합 시 배포 버전과 제출 응답의 증거 능력, 후속 조회의 식별 능력을 고정해 검증한다. 필요한 증거를 반환하는 adapter/API를 사용하거나 검증된 결과 조회를 수행하며, 충분한 연결을 얻지 못하면 성공 문구만으로 succeeded를 만들지 않고 unknown을 유지한다. REST 사용 여부는 아직 확정하지 않았다.

GitHub 승인 결과와 후속 진행 적합성은 별도 사실이다. Eureka 질문 전과 completeStage 실행 직전에 승인 SHA에 대한 최신 head·필요 조건 및 Eureka 변경 가능 상태를 재검증한다. getReviewContext의 기본 PR 조회와 필요한 section 선택을 재사용할 수 있으며 SHA 변경 시 자동 상세 재수집하지 않는다. completeStage에는 승인 operation/externalRefs/승인 SHA와 최신 조건 조회 근거를 연결한다. SHA 변경·조건 확인 불가는 기존 승인 성공을 보존하고 후속 완료만 차단한다. commit_id/commitID는 리뷰 대상 버전 지정이지 현재 head와의 원자적 비교 보장이 아니다. 재검증 뒤에도 외부 경쟁은 가능하므로 최신 PR 검토 완료를 보장한다고 표현하지 않는다.

### Operation Record and Recovery

ActionResult는 결과 계약이며 실행 중 상태를 억지로 unknown에 넣지 않는다. 영속 OperationRecord와 operation.updated는 다음 축을 별도로 표현한다. 이름은 잠정값이다.

| 축 | 값 또는 필수 정보 |
| --- | --- |
| 식별·권위 | owner, operationId, revision, requestId, confirmation 참조, attempt 목록·현재 실행 권한 |
| 실행 단계 executionPhase | prepared / dispatching / awaiting_response / response_received / stopped |
| 판정 상태 assessment | pending / assessed. pending에서는 확정 ActionResult가 없을 수 있음 |
| 결과 | 선택적 ActionResult. unknown은 외부 결과 불명일 때 사용 |
| 복구 상태 recovery | none / needed / running / blocked |
| 후속 진행 | GitHub 성공과 독립적인 eligible / blocked / unverified 및 조건·조회 시각·근거 |

정상 응답 대기 중 중복은 기존 호출에 연결하고 결과 조회를 중복 시작하지 않는다. 센서만 실패하면 응답 증거와 pending 판정을 유지해 검사를 재수행한다. 응답 유실은 unknown 및 recovery=needed로 기록하고 쓰기 없이 조회한다. unknown이 남은 동안 복구 시도가 멈춰도 종료·삭제 가능한 기록이 되지 않는다. Harness 호출 종료는 operation 복구 종료와 다르며 기존 호출 deadline 만료 후에는 별도의 시스템 requestId와 유한한 deadline으로 읽기 복구를 추적한다. 동시에 하나의 복구 담당만 확보하고 원 operation과 연결한다. 자동 복구 주기·횟수 상한은 통합 시 정하며 상한 도달 시 blocked로 남겨 운영 조치를 요청한다.

진행 중·unknown·판정 대기·복구 중에는 ExpectedOutcome/검사 규칙 버전, actualRequest, attempt/dispatch 증거, priorEvidence와 응답의 필요한 근거를 삭제 보호한다. 가이드 입력에는 이 기록에서 필요한 구조화된 사실과 증거 참조를 공급한다. 종료되고 참조가 해제된 기록만 최소 중복 방지 기록으로 축약한다. 수락 시 응답·시도 크기 상한에 맞춰 복구 공간을 예약하며 예약·필수 저장 실패는 전송을 차단한다. 전송 후 저장 장애는 외부 작업 실패가 아니며 영속 전송 가능 기록을 기준으로 복구한다. 공간 부족으로 보호 기록을 삭제하거나 오래된 확인 ID를 새 승인으로 수락하지 않는다.

### ActionResult and Error

| 필드 | 의미 |
| --- | --- |
| operationId, action, target | 작업 식별과 범위 |
| status | succeeded / failed / unknown / cancelled |
| dispatchState | not_sent / may_have_been_sent / sent |
| facts | 확인된 사실. 모델 문장과 분리 |
| externalRefs | review ID 등 외부 증거 |
| observedAt | 결과 확인 시각 |
| error | 발생 단계, 잠정 분류 코드, 설명, 작업·시도 ID, 다음 조치 |

전송 전 차단은 failed + not_sent와 이유로 구분한다. confirmed succeeded에는 연결 가능한 외부 증거가 있어야 한다. cancelled는 전송 전 취소 또는 외부 취소 확인에 한정한다. 코드명은 실제 반환값을 본 뒤 동결한다. 다음 조치는 none / bounded_read_retry / reconcile / user_input으로 구분하며 retryable 하나만으로 쓰기를 반복하지 않는다.

### Output and Projection

OutputRequest는 outputId, 요청 참조, purpose(result/question/progress/reminder), 개별 ActionResult·사실·출처, 필수 의미, 언어·길이·지원 표현 제약을 담는다. 질문이면 pendingId/confirmationId, 리마인더면 description/dueAt/timezone과 연결 ID를 포함한다. 외부 결과 원문 전체를 무조건 모델에 넣지 않는다.

OutputService 반환은 text, displayText, 지원 범위 내 emotion/표정 제안, 검증/fallback 여부다. 업무 status와 사실 식별자는 일반 코드가 복사하며 모델이 수정하지 않는다. 실제 activity=speaking이나 전달 completed는 생성 모델이 확정하지 않는다.

OutputEvent는 content_ready/content_failed와 channel_started/channel_completed/channel_failed를 구분한다. 같은 outputId와 channel로 연결한다. LCD displayed는 해당 채널의 실제 표시 완료 근거다. 웹·음성·장치 실패는 개별로 표시한다.

operation.updated 등 상태 이벤트는 entity ID, revision, 현재 상태, 관련 ID를 포함한다. Projector는 중복/역순을 걸러내고 누락 또는 재연결 시 authoritative snapshot을 받는다. 스냅샷에는 객체별 revision이 필요하다. 웹은 실행 결과와 출력 결과를 독립적으로 반영하며 LLM 완료를 기다리지 않는다.

원본은 Harness의 operation/pending/confirmation, Eureka 모듈의 직접 경로 operation, 파이프라인의 요청·출력 채널 상태로 나뉜다. Projector는 이 원본들의 표시용 투영을 만들며 업무 판정을 소유하지 않는다. 재연결은 먼저 원본별 이벤트 구독을 확보하고 유한한 버퍼에 수집한 뒤 해당 구독 범위의 전체 스냅샷을 받는 순서로 한다. 스냅샷은 scope, epoch, 객체별 revision을 포함하며 포함 시점 이전 상태와 이후 이벤트 사이 누락이 없어야 한다. 그 뒤 버퍼의 더 높은 revision만 적용한다. 버퍼 포화·구독 끊김·epoch 변경이면 불완전 동기화로 표시하고 다시 시작한다. 이 조건을 충족할 수 없는 transport는 같은 경계를 보장하는 snapshot cursor와 이벤트 재생 계약을 제공해야 한다.

스냅샷의 전체 범위는 해당 범위의 기존 투영을 교체하며, 실시간 삭제는 tombstone의 ID/revision으로 반영한다. 삭제 이후 낡은 이벤트가 객체를 되살리지 않도록 동기화 epoch 내 삭제 revision을 유지한다. 재생·tombstone 보존 범위를 벗어난 재연결은 전체 동기화를 요구한다. 원본들 간 하나의 원자적 스냅샷을 보장하지 않으므로 원본별 동기화 상태를 표시한다. 웹은 disposition=completed를 업무 전체 성공으로 변환하지 않는다.

현재 시나리오에 맞춘 MVP에서는 구현의 편의성을 위해서 scope 범위를 source 전체로 제한했다. 차후에 요청단위 구독이 필요해진다면 scope 범위를 더 작게 제한할 수 있다.

## When To Use

DTO·Schema·Gateway adapter·mock 시나리오를 만들기 전 합의 기준으로 사용한다. 실제 타입 선언과 wire format은 팀 공통 계약 검토 후 작성한다.

## Related Concepts

- [[wiki/deskpet_LLM_guide_Liability|김도헌 DeskPet LLM 설계 규칙]]
- [[wiki/deskpet-harness-guide-sensor|Harness Guide and Sensor Contracts]]
- [[wiki/deskpet-interface-contracts|DeskPet Interface Contracts]]
