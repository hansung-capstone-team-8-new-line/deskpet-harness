---
type: framework
topics:
  - deskpet
  - agentic-systems
status: draft
sources:
  - "사용자와의 DeskPet Harness 설계 대화 및 문서 생성 요청 (2026-10-03)"
  - "[[wiki/deskpet-technology-stack|DeskPet Technology Stack]]"
  - "[[wiki/deskpet-interface-contracts|DeskPet Interface Contracts]]"
  - "[[wiki/deskpet-pipeline/module-lifecycle|Module Lifecycle]]"
  - "[[wiki/deskpet-pipeline/resource-reliability-validation|Resource and Validation Policies]]"
  - "[[wiki/deskpet-pipeline/gpu-dispatcher|GPU Dispatcher]]"
  - "[[wiki/deskpet-pr-review-golden-scenario|PR Review Golden Scenario]]"
created: "2026-10-03"
updated: "2026-11-14"
---

# 김도헌 DeskPet LLM 설계 규칙

## Summary

김도헌 담당 Harness·LLM Wiki 활용, MCP·Eureka 연동, 출력 체인, 로컬 웹의 책임과 실행 규칙을 정리한다. 이 문서 자체는 구현 완료나 통합 테스트 통과 기록이 아니다. 구체 필드·메서드·가이드/센서 입출력은 위임받아 구체화한 잠정 계약이다. 2026-10-12 기준 MVP 구현에서 정한 사항과 실제 연결 확인 범위는 Workflow의 Implementation Notes에 모았다.

읽기 순서: 본 문서 → [[wiki/deskpet-harness-message-contracts|Harness Message Contracts]] → [[wiki/deskpet-harness-guide-sensor|Harness Guide and Sensor Contracts]]. 기존 위키를 대체하거나 팀 전체의 계약을 일방적으로 확정하지 않는다.

## Principles

1. LLM의 제안과 실행 권한을 분리한다. 사용자 확인, 중복 방지, SHA, deadline 등 필수 조건은 일반 코드가 검사한다.
2. 사용자 의도는 현재 발화와 선별된 관련 대화, 영속 업무 배경은 Wiki, 현재 외부 상태는 최신 API 조회를 근거로 삼는다. Wiki나 모델 문장을 사용자 승인 증거로 사용하지 않는다.
3. GitHub 승인, Eureka 반영, 음성·화면·웹 전달 결과를 별도로 기록한다.
4. 결과 미확인은 실패가 아니다. 쓰기 전송 후 응답 유실은 `unknown`으로 보존하고 자동 재전송하지 않는다.
5. 자동 롤백하지 않는다. 성공한 단계는 보존하고 실패·미확인 단계만 복구한다.
6. 상태·버퍼·동시 호출·보존 공간에 상한을 둔다. 구체 수치는 실측 후 설정한다.

## Workflow

### Ownership

| 책임 | 소유 범위 |
| --- | --- |
| HarnessService | 추가 해석, Wiki 문맥 활용, 계획, 재질문, 승인 확인, 도구 실행 조율, 작업 기록·복구 |
| GitHubReviewGateway | PR 자료 조회, 승인 제출, 기존 승인 결과 확인; 실제 MCP/API 통신 및 응답 정규화 |
| EurekaGateway | 업무 조회·타입이 정해진 변경·미확인 결과 확인. Harness 외에 파이프라인의 직접 업무 경로도 사용 |
| OutputService | 출력 체인을 감싸 사실 기반 문장·표정 정보 생성, 검증, 고정 문구 fallback. 외부 장치 전달 서비스라는 뜻이 아님 |
| RequestStateProjector | 요청·작업·출력 이벤트를 웹 표시 상태로 변환. 실행을 지시하지 않음 |
| 가이드·센서 | Harness 내부의 행동 제안과 실행 후 검사 책임. 별도 클래스·프로세스 확정 아님 |
| 손한솔의 공통 파이프라인·런타임 | 요청 생명주기, 라우팅, 최근 대상 대화, 리마인더 주기·대기열·상태, 출력 전달 순서, 모델 런타임·GPU 실행 및 원격 fallback 배포 |
| 박종하의 장치 계층 | 실제 장치 제어·드라이버, 지원 표정·모션 범위, 물리 출력 완료·실패 보고 |

도헌은 Harness 결과를 출력 입력으로 구성하는 연결 코드를 설계하되 공통 파이프라인 계약을 따른다. 공통 큐·취소·재생 상태·GPU 스케줄러를 중복 소유하지 않는다. 파이프라인이 OutputService를 호출하고 최종 내용을 TTS·장치 경계로 연결한다. Harness는 완성 문장을 반드시 생성하지 않고 사실·질문 목적·출처를 반환한다.

Service/Gateway/Projector는 책임 후보 이름이다. 인터페이스 선언과 구현 객체를 반드시 따로 만들지 않는다. 실행 요청 데이터는 추가 서비스 객체가 아니다.

Harness 경로의 operation·pending·confirmation은 Harness가 권위 있는 기록을 소유한다. Harness를 거치지 않는 Eureka 경로의 operation과 실행 정책 검증·복구 기록은 공통 파이프라인의 Eureka 모듈이 소유한다는 잠정 경계로 둔다. Gateway는 통신과 증거 정규화를 맡고 별도 업무 상태 원본을 만들지 않는다. 두 경로는 같은 영속 기록·전송·중복 방지 계약을 적용하고 operation마다 소유자를 하나로 고정한다. 저장 기능은 재사용할 수 있으며 새 서비스 객체를 요구하지 않는다. 직접 경로도 해당 행위의 사용자 확인 정책을 검증해야 하며 정책이 미정이면 쓰기를 차단한다. GitHub 승인 후 Eureka 단계 완료는 Harness 경로의 별도 확인 정책을 따른다. 이 경계는 공통 파이프라인 담당자와 통합 검토할 제안이며 기존 구현의 보장이 아니다.

### Documentation Boundaries

- 기존 I-07의 Harness 큐 표현과 달리 모듈 생명주기 문서는 Eureka/Harness를 별도 입력 대기 큐 없는 직접 비동기 호출로 설명한다. 이 설계는 후자를 따른다. 본 작업에서 Swift 실제 코드를 검증하지 않았다.
- 기술 스택의 Python 출력 체인 요약과 TypeScript/Node.js 상세 표는 불일치한다. MVP는 상세 담당표대로 TypeScript/Node.js로 구현했다. 출력 체인의 LangChain 사용 여부와 보드 내 transport는 팀 확인이 필요하다(Implementation Notes 참조).
- GPU 및 자원 문서의 수치는 mock 검증 또는 개발용 설정이다. 실제 장치 성능이나 이 Harness 구현의 검증 결과가 아니다.
- P-01~P-05는 시나리오 제안 계약이며 실제 MCP 도구명으로 간주하지 않는다.

### Context and Resume

`handle`은 최초 요청, `resume`은 같은 요청의 후속 사용자 턴을 처리한다. 공개 `resume`은 하나이며 내부에서 정보 보충과 승인 확인을 분리한다. 질문을 반환하면 현재 호출을 종료하고 슬롯을 해제한다. 답변은 새 turn ID와 유효한 pending ID로 연결한다. 새 호출 deadline은 새로 전달하되 승인·대기 기록의 유효성을 자동 연장하지 않는다.

두 호출은 현재 턴의 final 여부·입력 채널·STT confidence 제공 상태와 값을 같은 계약으로 받는다. 음성의 낮은 신뢰도 또는 신뢰도 확인 불가는 쓰기 승인을 차단하며, 비음성 입력의 해당 없음과 구분한다. 이전 턴의 confidence를 재사용하지 않는다.

파이프라인은 질문 전달·발화 시작·대기 종료·요청 취소 사실을 순서가 있는 이벤트로 보고하고, Harness는 pending/confirmation의 최종 전이를 소유한다. 질문 무응답 종료는 해당 pending을 만료시키며 연결된 미소비 확인도 만료시킨다. 기한 내 발화 시작은 무응답 타이머만 종료하고 확인의 절대 유효 기한을 연장하지 않는다. 답변 수락과 만료·거절·취소는 동일 pending revision에 대해 원자적으로 경쟁한다. 상세 순서와 중복 응답 규칙은 메시지 계약을 따른다. 요청 화면 종료나 사용자 취소는 이미 전송된 외부 작업의 결과 기록을 폐기하지 않는다.

파이프라인은 지시 대상·정정·현재 질문에 필요한 관련 대화를 `ContextPacket`으로 선별한다. Harness는 부족한 영속 문맥을 Wiki에서 조회한다. 검색 결과 없음과 검색 실패를 구분하며, 부족한 사실을 추론으로 채워 쓰기를 실행하지 않는다. 현재 PR·업무 상태는 외부 조회로 확인한다.

### Review Collection

`getReviewContext`를 기본 묶음 조회로 잠정 채택한다. PR 기본 정보는 항상 조회하고 diff·checks·reviews는 필요한 항목만 선택한다. 내부 조회는 상한 내 병렬 실행할 수 있다. 묶음 호출 자체가 API 호출 수 감소나 원자적 스냅샷을 보장하지 않는다.

기대 SHA와 최초 SHA가 다르면 상세 조회 전에 반환한다. 수집 중 SHA가 바뀌면 자동 재수집하지 않고 변경 사실과 확보 자료를 반환한다. 버전 근거가 확인된 자료만 같은 버전으로 묶고, 혼합·미확인 자료를 최신 전체 리뷰로 설명하지 않는다. PR diff는 비교 기준도 기록하며 단일 head 커밋 diff로 대체하지 않는다. 같은 SHA에서도 checks·리뷰는 변할 수 있으므로 조회 시각과 완전성을 보존한다.

### Confirmation and Execution

GitHub의 특정 SHA 기준 `APPROVE`는 PR 리뷰 승인 한 건이다. 커밋 승인과 PR 승인을 별도 외부 작업으로 나누지 않는다. GitHub 승인과 Eureka 단계 완료는 서로 다른 쓰기다.

1. PR 승인 가능 조건을 확인한다. 필수 검사 실패·진행 중·판정 불가, SHA 변경, 권한·정책 미확인은 제출을 차단한다. 필수 검사가 없다고 확인한 경우와 설정을 조회하지 못한 경우를 구분한다.
2. 가능할 때 대상 저장소·PR·SHA·행위를 명시해 사용자 확인을 받는다.
3. Harness가 확인 기록을 검증하고 하나의 작업에 원자적으로 연결한다. LLM이 생성한 승인 플래그를 실행 권한으로 인정하지 않는다.
4. Gateway가 실행 직전 외부 상태를 재검증하고 지정한 SHA에 승인을 제출한다. 사전 조회와 제출 사이의 경쟁 상황을 완전히 제거했다고 주장하지 않는다.
5. 센서 검사와 외부 증거로 GitHub 성공을 확인한다. 성공이 아니면 Eureka 완료를 진행하지 않는다.
6. 승인 성공과 후속 진행 적합성을 구분한다. Eureka 질문 전에 최신 PR head와 필요한 실행 조건, Eureka 대상·변경 가능 상태를 조회한다. 승인 SHA와 달라졌거나 조건을 확인할 수 없으면 기존 승인 성공을 보존하고 후속 완료를 보류한다. 조건이 맞을 때만 별도 완료 질문을 제시하며, 동의 뒤 실행 직전에도 재검증한다. 동의한 단계만 완료하며 상위 업무 전체로 확대하지 않는다. 재검증도 서비스 간 원자성을 보장하지 않으며 특정 SHA 승인 성공을 최신 PR 전체 검토 완료로 표현하지 않는다.

Eureka 질문의 거절·무응답은 정상 종료이며 GitHub 승인을 되돌리지 않는다. 출력 완료는 동의가 아니다. 질문의 필수 의미를 출력 체인이 변경해서도 안 된다. 실행 후 사용자 취소 요청은 별도의 되돌리기 요청이며 지원 여부·권한·영향·새 동의를 검토해야 한다. 되돌리기 API는 아직 정의하지 않는다.

### Retry and Recovery

| 상황 | 정책 |
| --- | --- |
| 일시적 읽기 오류 | deadline 내 최대 1회 자동 재시도 |
| 인증·권한·입력·미지원 오류 | 자동 재시도 없음 |
| SHA 변경 | 자동 재수집 없음 |
| 쓰기 전송 전 실패가 확실함 | 실행 조건이 유효할 때 최대 1회 자동 재시도 |
| 전송 후 timeout·응답 유실·전송 여부 불명 | `unknown`, 재전송 금지, 기존 작업 결과 조회 |
| 명시적인 쓰기 실패 | 초기에는 자동 재시도 없음 |
| 사용자 “다시 해줘” | 기존 결과 확인 후 판단. `unknown`을 재전송 허가로 해석하지 않음. MVP(2026-10-24): 명시적으로 실패한 Eureka 단계 완료는 그 요청 자체를 동의로 보고, 후속 적합성을 다시 확인한 뒤 새 확인 기록·새 작업으로 한 번 더 보낸다 |

Gateway가 호출 재시도 한도를 적용하고 Harness는 Gateway 전체를 자동 반복하지 않는다. SDK/MCP 내장 재시도와 중첩되지 않게 실제 연결 시 확인한다. 하위 deadline은 상위 남은 시간을 넘지 않으며 취소 뒤 새 시도를 시작하지 않는다. 이미 전송한 외부 작업의 늦은 증거는 기록·복구한다.

### Durable Records and Deduplication

Harness는 자신의 경로에서 승인·작업 기록의 책임을 소유하며 직접 Eureka 경로는 위 Ownership의 소유자가 같은 규칙을 적용한다. 승인 검증, operation 연결, 실행 권한 확보를 원자적으로 수행하고 전송 전에 영속 기록한다. 같은 confirmation은 하나의 operation에만 연결한다. 진행 중 중복은 기존 작업에 연결, 성공 중복은 저장 결과 반환, unknown 중복은 기존 결과 확인, 실패·취소 중복은 해당 결과 반환이다. 같은 PR·SHA라는 이유만으로 모든 미래 요청을 영구 중복 처리하지 않는다.

Gateway는 전송 가능 상태의 영속 저장 성공을 확인받은 뒤에만 외부 쓰기를 시작한다. 이 기록 뒤 crash가 나면 실제 전송 여부가 확인되지 않는 한 may_have_been_sent/unknown으로 복구하고 자동 재전송하지 않는다. not_sent는 단순히 전송 보고가 없다는 뜻이 아니라 전송하지 않았다는 확실한 증거가 있는 상태다. 재시작·동시 호출자의 실행 권한 인계는 원자적으로 제한하고, 이전 실행자가 여전히 전송할 수 있는 동안 새 실행자를 허용하지 않는다. 구체 저장소·transport는 미정이다.

(MVP) 저장소는 SQLite(Node 내장 `node:sqlite`)에 판단 결과를 동기 기록하며, 기록 실패 시 메모리 상태도 되돌린다. 위 보존 정책은 이 저장소에 구현했다.

외부 서버의 idempotency 지원이 없다면 로컬 operation ID만으로 정확히 한 번 실행을 보장할 수 없다. 전송 직후 재시작 등으로 경계가 불명확하면 unknown으로 복구한다. 기존 승인이 조회됐다는 사실만으로 이번 작업 성공이라고 단정하지 않고 제출자·SHA·시각·외부 ID 등으로 연결한다.

저장 정책은 상태별 삭제 보호, 최소 보존 기간, 용량 상한, 삭제 가능한 기록의 LRU 순서다. 진행 중·unknown·판정 대기·복구 중 작업과 유효 확인은 삭제하지 않는다. 보호 작업에는 고정한 ExpectedOutcome과 검사 규칙 버전, actualRequest, attempt·전송 증거, priorEvidence와 확보 응답의 필요한 근거까지 보존한다. 복구·센서 재검사에 필요한 근거를 단순 상세 로그로 분류해 지우지 않는다. 종료되고 복구·확인 참조가 없는 기록만 더 작은 중복 방지 기록으로 축약하며 작업/확인 ID, 대상·행위·SHA, 결과, 외부 ID, 주요 시각을 보존한다. raw 인증키는 저장하지 않는다.

삭제 직전 상태와 참조를 함께 검사한다. 웹 조회가 LRU 수명을 무조건 늘리지 않도록 접근 기준을 구분한다. 정리 후에도 용량을 확보하지 못하면 새 쓰기를 차단한다. 복구 증거를 기록할 여유 공간을 확보하고 그 한계도 모니터링한다. 최소 기록 삭제 후 무기한 중복 방지를 주장하지 않으며 없는 오래된 확인 ID로 새 실행을 허용하지 않는다.

쓰기 수락 시 유한한 응답·시도 상한에 맞춘 복구 기록 공간을 원자적으로 예약한다. 예약 또는 필수 기록 저장이 실패하면 dispatch하지 않는다. 전송 후 저장 실패는 외부 실패로 바꾸지 않고 기존 전송 가능 기록을 유지해 복구한다. 보호 기록 누적으로 예약을 충족하지 못하면 새 쓰기를 계속 차단하고 운영자에게 알린다. 무제한 수락과 무기한 보호를 동시에 보장하지 않는다. ActionResult는 결과만 표현하고 실행 중·판정 대기·복구 진행은 별도 OperationRecord로 관리한다.

### Output and Monitoring

웹은 업무 결과와 출력 결과를 각각 받으며 문장 생성을 기다리지 않고 업무 상태를 표시할 수 있다. Projector는 이벤트 ID·revision으로 중복·역순을 처리하고 재연결 때 스냅샷으로 복구한다. 웹 실패는 업무 재실행으로 이어지지 않는다. 오래된 출력의 현재 화면 적용을 막는 것과 외부 결과 기록을 폐기하는 것은 다르다.

스냅샷은 객체별 revision만으로 충분하지 않다. 이벤트 구독과 스냅샷 사이 누락을 막는 순서, 삭제된 객체의 제거, 재시작 동기화를 메시지 계약에 정의한다. Projector는 표시용 상태만 소유하며 Harness/Eureka 모듈의 operation과 파이프라인의 요청·출력 상태를 대신 확정하지 않는다.

출력은 개별 사실을 보존하고 모델 실패 시 고정 문구를 사용한다. 리마인더는 하나씩 설명과 실제 마감 날짜·시간·시간대를 전달하며 남은 시간만으로 대체하지 않는다. 실제 전달된 문장의 라우터 대화 반영은 파이프라인이 담당한다. 출력 전용 문맥은 도헌 출력 체인 범위지만 최근 대상 대화를 복제하지 않는다.

모니터링 항목은 작업별 결과·시도 횟수·마지막 갱신, unknown 경과 시간, 복구 상태, 출력 채널 결과, 동시 호출/포화/timeout/중복 차단, 저장 사용량·보호 기록 크기·정리 결과다. 값이 오래 갱신되지 않았다고 자동 실패나 재실행으로 전환하지 않는다.

### Review Coverage

| 시나리오 | 계약상 기대 동작 |
| --- | --- |
| G-01 | 리뷰 조회 → GitHub 별도 확인·승인 → Eureka 별도 확인·반영. 기존 골든 예시의 자동 후속 반영은 본 설계에서 분리 |
| S-01, S-02 | 대상 모호·다중 후보는 필요한 정보만 재질문 |
| S-03 | 리뷰 없음·오래됨·조회 불가 분리 |
| S-04, S-05 | 낮은 신뢰도에서 승인 차단, 거절은 쓰기 없음 |
| S-06, S-07 | 인증 실패와 전송 후 unknown 분리, 쓰기 자동 재전송 없음 |
| S-08, S-11 | SHA 변경·승인 불가 상태 차단 |
| S-09, S-10 | 부분 성공·출력 실패 분리, 성공 작업 보존 |
| S-12 | 쓰다듬기는 로컬 상호작용. Harness·외부 업무 호출 없음 |

이 표는 설계 검토 결과이며 테스트 통과 기록이 아니다. 2026-10-12 MVP에서 G-01, S-01, S-04~S-11은 fake Gateway 자동 테스트로, S-02·S-03은 단위 수준으로 확인했다. 실제 서비스로는 G-01 전체(리뷰 → GitHub 승인 → Eureka 단계 하나 완료)를 개발 환경에서 1회 확인했다. 실제 MCP 버전·권한·반환 스키마, Eureka 멱등성·복구 가능성, 보드 내 transport, 수치 한도는 통합 시 검증한다.

### Implementation Notes (2026-10-12, 2026-10-24·2026-11-03 갱신)

MVP 구현에서 정한 사항이다. 팀 공통 계약을 확정하지 않으며, 파이프라인 문서에 적힌 부분은 그 문서를 따르고 없는 부분만 아래처럼 정했다.

| 항목 | MVP 처리 |
| --- | --- |
| 언어·런타임 | TypeScript, Node.js 22, pnpm 모노레포. 별도 저장소에서 관리 |
| LLM | 외부 API. 개발 기본은 Gemini `gemini-3.1-flash-lite`(생각 수준 minimal), 설정으로 OpenAI 전환. 규칙 우선 + LLM 보조 가이드, 센서는 결정적 규칙 |
| 출력 체인 | 공급자 중립 출력 모델 + 결과 검증 + 고정 문구 fallback. LangChain은 선택 경로로만 둔다 (기술 스택 문서와 다름, 팀 확인 필요) |
| 서비스 경계 | WebSocket `deskpet.harness.v1` + 기존 Envelope. 보드 내 transport 후보(gRPC·ZeroMQ)와의 정렬은 미정 |
| 파이프라인 형식 | 파이프라인 문서의 HarnessAdapter·EurekaAdapter 형식(`needs_clarification` + 질문 문자열, `mutationApproved`)을 변환 층에서 받는다. 질문 문장은 고정 문구로 만들고, 승인은 `mutationApproved`와 Harness의 pending·확인 기록·질문 전달 증거 검사를 모두 통과해야 한다 |
| LLM Wiki | 검색 대상은 `wiki/`와 `projects/**/README.md`, 방식은 키워드 + frontmatter. LLM에는 발췌 최대 3개·합계 1,500자와 출처만 준다. Guide 판단 참고와 출력 모델의 배경 설명에 쓰고, 대상 특정·승인 근거로는 쓰지 않는다. 배경을 못 찾거나 LLM이 응답하지 않아도 확보한 PR 자료가 있으면 그 자료로 답한다 |
| 승인 조건 | 필수 검사 설정을 rulesets와 branch protection으로 조회한다. 요금제상 보호 기능이 없을 때만 DeskPet 대체 목록을 쓰고 출처를 표시한다. 필수가 아닌 검사의 실패·진행 중은 차단하지 않고 경고로 알린다. 권한을 확인할 수 없으면 차단한다 |
| PR 변경 자료 | 현재는 파일 목록과 증감 줄 수만 수집한다. diff 본문 수집 범위·상한은 미정 |
| 개발 단계 실제 쓰기 | GitHub·Eureka 쓰기는 서버 실행 옵션을 켰을 때만 허용한다. 승인은 요청 쪽 사용자 확인(확인 질문 전달과 승인 답변)만으로 받으며, 서버 운영자 콘솔 확인은 두지 않는다(2026-10-24). 보내기 직전 대상 상태를 다시 확인하고, Eureka 쓰기는 개발판(`flw-d1`)·운영판(`flw-v1`, 배포 전 닫힌 시험 환경) 주소로 제한하고 그 밖의 주소는 거부한다(2026-11-03) |
| 웹 | 보기 전용. 별도 viewer 토큰으로 상태 snapshot + 이벤트를 구독하며 변경 기능은 없다 |
| 업무 → PR 연결 | Eureka에는 PR 필드가 없어 단계 기록(note) 본문의 GitHub PR 주소로 연결한다. 기록이 붙은 단계가 승인 후 완료할 단계다. 후보가 둘 이상이면 추측하지 않는다. 허용 저장소 목록·작성자 제한은 나중에 추가한다 |
| 후속 작업 | Eureka 반영은 동의 뒤 짧게(기본 3초) 기다리고, 늦으면 '진행 중'으로 답한 뒤 끝난 결과를 서버 알림(notice)으로 보낸다. 서버 안의 복구 작업이 결과 불명·판정 대기 작업을 주기적으로 조회만 하고(간격을 늘려 가며), 상한에 닿으면 blocked로 남긴다 |
| 복구 뒤 후속 질문 | 복구로 GitHub 승인이 성공 확정되면 연결된 Eureka 단계의 상태와 기록(PR 주소가 남아 있는지)을 다시 보고, 반영 가능할 때만 별도 확인 질문을 알림에 실어 보낸다. 연결 단계·대화·문맥 ID는 승인 작업 기록에 남겨 재시작 뒤에도 쓴다 |
| 동시 호출 상한 | 서버 입구가 아니라 자원별로 둔다. LLM은 자리가 짧게 안 나면 호출하지 않고 규칙·고정 문구로 대신하고, GitHub·Eureka는 호출의 남은 시간 안에서 기다리다 끝내 자리가 없으면 보내지 않음(not_sent)으로 처리한다. 입구는 칸을 나눠 질문 전달 보고·취소·결과 조회가 다른 요청 때문에 막히지 않게 한다. 수치는 실측 전 자리값 |
| 완료 근거 기록 | Eureka 단계 완료가 성공하면 그 단계 기록(note)에 승인한 PR 주소·커밋·리뷰 ID를 남긴다. 동의는 단계 완료 확인 질문에 함께 받는다. 쓰기 전에 기록을 읽어 같은 근거가 있거나 읽지 못하면 쓰지 않고, 응답을 못 받으면 다시 보내지 않는다. 실패해도 단계 완료는 유지한다 |
| 2차 의도 확인 | 라우터가 일반 의도(`llm`·`unclear`)로 보낸 요청은 LLM이 PR 리뷰·PR 승인·그 밖 중 하나로 다시 분류해, 해당하면 규칙 경로로 보낸다. LLM은 의도 이름만 고르며, 승인은 승인 전 검사·확인 질문·입력 신뢰도 기준을 그대로 거친다(시연 대응, 2026-11-02) |
| 입력 신뢰도 기준 | 쓰기 요청과 확인 답변의 STT·라우터 신뢰도 기준은 기본 0.85·0.8이며, 시연 환경에 맞춰 설정으로 바꿀 수 있다. 확정 수치는 실측 후 정한다 |

실제 연결 확인(개발 환경): GitHub 다른 계정 PR 승인(REST, review ID·상태·commit 확인), Eureka 읽기와 단계 완료 쓰기, Gemini 가이드·출력, Wiki 발췌를 반영한 출력 문장, Eureka 단계 기록의 PR 주소로 대상 PR을 찾아 G-01 진행(2026-10-24). 후속 작업·복구 뒤 질문·동시 호출 상한은 자동 테스트로만 확인했다. 2026-11-02~03 파이프라인 실연결에서 PR 조회·승인과 Eureka 반영 확인 질문까지 확인했다. 확인 답변 판정과 완료 근거 기록은 확인 중이다.

### 2026-11-14 아키텍처 전환 — 헤드리스 바이브 코딩 플랫폼용 범용 MCP & Agent Swarm

기존 MVP의 GitHub 전용 가정과 중앙 독점 실행 구조를 정리해 다음과 같이 책임을 재정의한다(`deskpet-pipeline` 무수정 원칙 유지):

1. **Router–Harness 진입 경계 정규화:**
   - 온디바이스 라우터의 실제 의도는 `eureka | llm | talk | unclear`이며, `pr.review`, `pr.approve`, `eureka.retry`, `followup.retry` 등 합의되지 않은 의도 전제는 폐기한다.
   - `llm` 및 `unclear`만 Harness로 진입하며, `unclear`는 `IntentTriage`가 의도를 우선 해석해 ① 파악 불가 → 재질문(`clarify`), ② 일상 대화 → `reroute: 'talk'` 반환(파이프라인 `outputQueue` 전달용), ③ 유레카 조작 → Harness의 기존 `EurekaGateway` 직접 조작 경로 실행(`direct_eureka`), ④ 코딩/MCP/추론 작업 → `llm` Agent Swarm 합류(`delegate_swarm`)로 처리한다.
2. **자율 실행형 Agent Swarm과 분산 허가:**
   - `SwarmCoordinator`가 작업을 분해하고 각 `SwarmWorker`가 MCP 서버(`McpClientManager`) 및 선택적 `FastPathAdapter`를 직접 실행한다. 중앙 `HarnessService`가 모든 도구 실행을 소유·직렬화하지 않는다.
   - 사용자 허가가 필요한 경우(Guide에 명시된 조건에 한함), 각 Worker가 `PipelinePermissionQueue`를 통해 기존 `Pending`/`Notice` 계약으로 파이프라인에 허가 요청을 큐잉하고 응답 수신 시 해당 Worker를 재개한다.
3. **Guide 외 임의 제한 금지 및 자유로운 MCP 활용:**
   - 신뢰도 임계값, 확인 필요 행위, 차단 기준 등 제한 사항은 **각 MCP의 `McpGuide`에 직접 명시된 내용만 적용**한다. 코어 코드가 Guide 밖의 임의 제한이나 폐쇄형 도구 목록을 강제하지 않으며, 헤드리스 바이브 코딩 플랫폼 목적에 맞게 MCP를 자유롭게 호출한다(단, 직접 호출보다 효율적인 경우에 한해 중간 Fast-Path 어댑터 사용 가능).

## When To Use

Harness·Gateway·출력·웹의 책임을 나누거나 실패 복구와 사용자 확인 정책을 구현·검토할 때 사용한다. 구체 클래스 분할과 보조 구성요소 선택은 아래 상세 계약을 만족하는 범위에서 결정한다.

## Related Concepts

- [[wiki/deskpet-harness-message-contracts|Harness Message Contracts]]
- [[wiki/deskpet-harness-guide-sensor|Harness Guide and Sensor Contracts]]
- [[wiki/deskpet-interface-contracts|DeskPet Interface Contracts]]
- [[wiki/deskpet-pipeline|DeskPet Pipeline]]
- [[wiki/deskpet-pr-review-golden-scenario|PR Review Golden Scenario]]
