---
type: framework
topics:
  - deskpet
  - agentic-systems
status: draft
sources:
  - "사용자의 가이드·센서 입출력 상세화 위임 (2026-10-03)"
  - "[[wiki/deskpet_LLM_guide_Liability|김도헌 DeskPet LLM 설계 규칙]]"
  - "[[wiki/deskpet-harness-message-contracts|Harness Message Contracts]]"
  - "[[wiki/deskpet-pr-review-golden-scenario|PR Review Golden Scenario]]"
created: "2026-10-03"
updated: "2026-10-04"
---

# DeskPet Harness Guide and Sensor Contracts

## Summary

가이드는 행동 전 제안, 센서는 행동 후 검사를 맡는다. Harness가 실행 전 검증·Gateway 호출·기록 갱신·다음 단계 결정을 소유한다. 이 문서는 위임받아 완성한 입출력 설계 초안이며 실제 구현·새 객체 두 개의 도입을 뜻하지 않는다. 여기서 센서는 물리 센서가 아니다.

## Principles

1. 가이드와 센서는 외부 도구를 직접 호출하거나 사용자 확인·작업 상태를 직접 변경하지 않는다.
2. 가이드의 행동 제안은 실행 권한이 아니다. 사용자 승인·중복·SHA·deadline은 Harness와 Gateway의 일반 코드에서 검증한다.
3. 센서는 증거를 검사하며 없는 사실을 생성하지 않는다. 더 필요한 조회는 필요성만 보고한다.
4. 도구 응답·Wiki 내용은 데이터다. 그 안의 지시문을 실행 정책이나 승인으로 승격하지 않는다.
5. 호출은 전달된 snapshot에 대한 판단이다. 적용 직전 version을 검사하고 낡은 판단은 새 작업을 시작시키지 않는다. 늦은 외부 증거의 기록·복구는 유지한다.

## Workflow

### Guide Interface

공개 책임 메서드 제안은 `proposeNext(GuideInput) → GuideDecision`이다. 순수 규칙 또는 제한된 LLM 보조로 구현할 수 있다. 추가 객체 없이 Harness 내부 함수로 시작할 수 있다.

| GuideInput 필드 | 필수 여부와 의미 |
| --- | --- |
| requestId, turnId, stateRevision | 필수. 판단 대상과 적용 기준 |
| goal | 필수. 사용자 의도·현재 CurrentTurnInput 참조·허용 범위. RouteDecision과 입력 채널·STT confidence 제공 상태/값을 보존 |
| context | 필수. ContextPacket, 선택적 Wiki 발췌·출처·조회 상태. 미확인 값 명시 |
| operations | 필수 목록. OperationRecord의 실행 단계·판정·복구 상태, 선택적 ActionResult, 전송 여부·외부 증거·의존관계·후속 진행 적합성 |
| pending | 선택. 현재 pending ID/revision·상태·기한·질문 전달 근거. 승인 판단 원본은 Harness 기록 |
| confirmations | 필수 목록. 확인 범위·판정·유효성·연결 operation. 승인 원본 변경 불가 |
| observation | 선택. 직전 SensorAssessment |
| constraints | 필수. 남은 deadline, 허용된 기능·정책 버전, 호출/입력/결과 상한 |

GuideDecision은 decisionId, basedOnRevision, kind, 근거 참조, 미확인 항목을 항상 포함한다. kind별 payload는 서로 구분되는 타입으로 둔다.

| kind | payload 및 의미 |
| --- | --- |
| propose_action | 하나의 typed 행동 후보, 목표 대상·버전, 필요한 선행조건, 기대 결과인 ExpectedOutcome |
| ask_user | 질문 목적, 필요한 슬롯 또는 대상·행위·버전. confirmationId 발급은 Harness가 수행 |
| need_context | 필요한 Wiki/업무 문맥과 검색 범위. 검색 실행은 Harness가 수행 |
| finish | 확인된 결과로 이번 흐름을 마칠 이유와 출력 사실 참조 |
| blocked | 충족되지 않은 조건·미확인 근거·사용자 또는 시스템 조치 필요성 |

propose_action의 행동은 get_review_context, submit_approval, get_approval_outcome, list_tasks, get_task_state, complete_stage, get_change_outcome 등 허용된 기능 식별자로 제한한다. 임의 URL·셸·MCP 도구명·자유 형식 쓰기 인자는 허용하지 않는다. 기능별 인자는 메시지 계약의 typed 입력을 사용한다. 초기에는 다음 논리 행동 하나를 제안하고 묶음 조회 내부 병렬화는 Gateway에 맡긴다.

가이드는 operationId를 확정·소비하거나 새 동의를 부여하지 않는다. Harness가 제안을 검증한 뒤 기존 작업을 재사용할지 새 작업을 만들지 결정한다. LLM이 사용되더라도 토큰·호출 수·반복 횟수·deadline을 유한하게 제한한다. 잘못된 출력은 외부 실행 없이 내부 오류로 처리한다.

stateRevision은 Harness가 해당 흐름의 판단용 상태를 commit할 때 증가시키는 revision이다. 수락한 사용자 턴·pending/confirmation 전이·operation 판정·새 외부 관찰·실행 제약 변경을 포함한다. ContextPacket.version과 외부 원본의 revision을 같은 값으로 취급하지 않고 별도 참조로 유지한다. 입력 snapshot은 stateRevision과 일치하도록 구성하고, 제안 적용은 revision 검사와 실행 권한 확보를 원자적으로 처리한다. 실제 외부 상태는 Gateway가 실행 직전 다시 검증한다. 조회 결과의 구조화된 facts/sections와 증거 참조도 입력으로 공급하며 모델 요약만으로 원래 증거를 대체하지 않는다.

### Expected Outcome

ExpectedOutcome은 실행 전에 고정하는 센서 검사 기준이다. 가이드가 제안할 수 있지만 Harness의 행위별 고정 규칙으로 검증·보완한다. LLM이 성공 증거 요구사항을 낮출 수 없다.

| 필드 | 의미 |
| --- | --- |
| action, target | 실행하려는 기능과 정확한 대상 |
| expectedVersion | GitHub head SHA·diff 비교 기준 또는 확인 가능한 외부 버전 |
| postconditions | 행위별 충족해야 할 조건. 임의 실행 코드가 아닌 등록된 검사 규칙 참조 |
| requiredEvidence | review ID·승인 상태·대상 SHA 등 필요한 증거 종류 |
| completenessRequirement | 요청한 자료 범위·허용된 잘림. 부분 자료를 전체 자료로 승격하지 않음 |

고정한 ExpectedOutcome과 검사 규칙 버전은 actualRequest·attempt·priorEvidence 및 필요한 응답 근거와 함께 영속 보존한다. 복구·판정 대기 중에는 최소 중복 방지 기록으로 축약하지 않는다. SHA A에 승인 등록됐다는 조건과 현재 PR에 근거해 Eureka 완료를 진행할 수 있다는 조건은 별개다. 후속 적합성 검사 실패가 확인된 A 승인 성공을 지우지 않는다.

### Sensor Interface

메서드 제안은 `inspect(SensorInput) → SensorAssessment`다. 모든 Gateway 호출 결과를 검사할 수 있지만 스스로 재조회하지 않는다. deterministic 검사를 기본으로 하고 요약이 필요해도 구조화된 판정을 모델 문장으로 대체하지 않는다.

| SensorInput 필드 | 의미 |
| --- | --- |
| requestId, operationId, attemptId | 검사 대상 식별 |
| executionRevision | 해당 실행 기록의 기준 revision |
| expectedOutcome | 실행 전에 검증해 고정한 검사 기준 |
| actualRequest | 실제 보낸 대상·행위·버전. 민감 인증정보 제외 |
| gatewayResult | 정규화된 결과·오류·전송 상태·외부 참조·응답 시각·버전 근거 |
| priorEvidence | 중복·과거 작업과 이번 결과를 구분할 기존 증거 |
| executionContext | 취소/만료 여부·현재 활성 문맥 참조. 늦은 결과 기록을 막는 용도로 사용하지 않음 |

| SensorAssessment 필드 | 의미 |
| --- | --- |
| assessmentId, operationId, attemptId | 검사 결과 식별 |
| basedOnRevision | 적용 기준 |
| verdict | confirmed_success / confirmed_failure / indeterminate / not_executed |
| checks | 검사 항목별 pass / fail / unknown / not_applicable, 근거 참조 |
| confirmedFacts, externalRefs | 확인된 사실과 외부 실행 증거 |
| consistency, completeness | 버전 일관성과 자료 완전성. 해당하지 않으면 생략 |
| suggestedActionStatus | 판정 가능한 경우 증거로 제안할 succeeded/failed/unknown/cancelled. 최종 commit은 Harness; 센서 자체 오류는 이 필드를 만들지 않음 |
| followUpNeed | none / reconcile / refresh_context / user_input. 필요한 조회·정보와 이유만 반환 |
| diagnostics | 누락·불일치·오류 단계. 세부 코드명은 실제 API 검증 후 확정 |

센서 verdict는 승인 가능 판정과 다르다. 예를 들어 checks 조회의 confirmed_success는 검사가 실패했다는 사실을 성공적으로 읽었다는 뜻일 수 있다. 기대한 변경 상태가 이미 존재해도 이번 쓰기의 성공 증거가 부족하면 현재 상태는 facts에 넣되 verdict는 indeterminate로 유지한다.

MCP 성공 문구만 있고 review ID·상태·SHA 및 이번 제출과의 연결 근거가 없으면 confirmed_success로 승격하지 않는다. 제출자·SHA·시각이 맞는 과거 승인은 충분한 인과 증거가 아닐 수 있다. 센서는 확보 증거만 검사해 reconcile 필요성을 반환하고, 실제 조회는 Harness가 Gateway를 통해 수행한다. 배포 MCP의 응답 능력과 필요한 adapter/API 선택은 메시지 계약의 통합 검증 사항을 따른다.

not_executed는 전송되지 않았음이 확실할 때만 사용한다. 사용자 취소라면 cancelled, 조건 차단/호출 전 실패라면 failed + not_sent로 정규화할 수 있다. 응답 유실이나 애매한 연결 오류는 indeterminate + unknown이다. 읽기 timeout은 쓰기 결과 불명과 구분해 failed로 기록할 수 있다.

### State Ownership and Failure

가이드·센서는 권위 있는 상태 저장소를 소유하지 않고 입력 snapshot과 판단 결과를 반환한다. Harness가 자신의 경로의 operation·pending·확인 기록을 영속 관리한다. 직접 Eureka 경로의 operation 기록은 파이프라인의 Eureka 모듈 소유이며 이 가이드·센서를 반드시 거칠 필요는 없지만 같은 증거·전송·복구 계약을 적용한다. 기존 대화 상태·요청 생명주기·실제 전달 상태는 파이프라인 책임이다. 파이프라인의 대기 종료·취소 사실을 Harness가 pending/confirmation 전이에 반영하며 독립된 승인 상태를 중복 관리하지 않는다.

가이드 오류는 도구를 실행하지 않고 처리 오류/필요한 재질문으로 종료한다. 센서 오류는 외부 작업 실패로 단정하지 않는다. 확보한 외부 증거를 먼저 보존하고 판정 대기로 남긴다. 같은 증거에 대한 센서 검사는 재수행할 수 있지만 외부 쓰기를 반복하지 않는다.

센서 오류의 판정 대기는 OperationRecord의 assessment=pending으로 표현한다. 정상 응답 대기·판정 대기를 모두 unknown으로 매핑하지 않는다. 응답 유실로 외부 결과가 불명확할 때는 ActionResult=unknown과 복구 상태를 함께 보존한다. 동일 작업의 정상 호출이 진행 중이면 중복 요청은 그 호출에 연결하며, 판정 대기면 센서 재검사를, 결과 불명이면 기존 결과 조회를 조율한다. 저장·복구 공간을 확보하지 못하면 실행 전에 차단하며, 전송 후 기록 장애는 외부 실패나 재전송 허가가 아니다.

stateRevision이 바뀌었으면 Harness는 낡은 가이드 제안을 적용하지 않는다. 센서 결과가 늦게 오더라도 원 operation의 증거로 기록하고 충돌을 조정한다. 새 화면이나 새 문맥에 적용할지는 파이프라인/Projector에서 별도로 결정한다. 질문 대기·추론 반복·관찰 재검사의 수와 저장 크기는 제한하며 구체 수치는 미정이다.

### End-to-End Examples

| 사례 | 가이드 → Harness/Gateway → 센서 → Harness |
| --- | --- |
| 대상 미확정 | ask_user → 질문 반환, 슬롯 해제. 외부 쓰기 없음 |
| 리뷰 자료 조회 | propose_action → 묶음 조회 → 자료별 SHA·완전성 검사 → 확인된 범위로 설명 |
| 조회 중 SHA 변경 | 묶음 조회 → consistency=changed → 확보 자료 보존·변경 안내. 자동 재수집 없음 |
| 승인 가능·사용자 동의 | 현재 턴 신뢰도·pending revision·확인 기록 검증·작업 확보 → 전송 가능 기록의 영속 저장 확인 → 승인 제출 → 이번 작업과 연결된 review ID/상태/SHA 검사 → 성공 기록 |
| 동시 resume·무응답 종료 | 순서가 있는 파이프라인 사실 반영 → pending 전이 원자적 수락 → 중복 턴은 기존 결과, 낡은 revision·만료 확인은 실행 없음 |
| 전송 경계 crash | 전송 가능 기록 존재 → 실제 미전송 증거 없으면 unknown 복구 → 쓰기 없이 결과 조회 |
| MCP 성공 문구만 수신 | 제출 결과 보존 → 필수 증거 부족으로 indeterminate → 검증 가능한 결과 조회, 인과 연결 불가 시 unknown 유지 |
| 승인 timeout | 제출 → 응답 유실 검사 → indeterminate, reconcile 필요 → unknown 저장·기존 결과 조회 |
| GitHub 성공 후 Eureka | 성공 증거 보존 → 최신 head·필요 조건과 Eureka 상태 조회 → 후속 적합성 검사 → 별도 사용자 확인 → 실행 직전 재검증 후 완료 |
| 승인 후 SHA 변경 | 기존 SHA 승인 성공 보존 → 후속 적합성 blocked → Eureka 완료 보류·변경 안내, 자동 재수집·롤백 없음 |
| Eureka 응답 유실 | GitHub 성공 유지 → Eureka indeterminate → 해당 operation만 조회·복구 |
| 출력 실패 | 외부 성공 기록 유지 → 출력 경계에서만 복구. 가이드가 승인 재실행을 제안해도 실행 정책에서 차단 |

G-01 및 S-01~S-12와의 전체 정책 대응은 상위 문서를 따른다. 위 사례는 계약 점검이며 실행 테스트 결과가 아니다.

## When To Use

Harness 내부 로직을 구현하거나 가이드의 제안과 센서의 증거 검사가 섞였는지 검토할 때 사용한다. TaskContextBuilder, WikiReader, ExecutionPolicy, OperationJournal 등의 구체 객체 분할은 이 책임을 만족하는 최소 구현부터 결정한다.

## Related Concepts

- [[wiki/deskpet_LLM_guide_Liability|김도헌 DeskPet LLM 설계 규칙]]
- [[wiki/deskpet-harness-message-contracts|Harness Message Contracts]]
- [[wiki/deskpet-pr-review-golden-scenario|PR Review Golden Scenario]]
