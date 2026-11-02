# 파이프라인 문서 형식 경계 (`harness.run`, `eureka.*`)

파이프라인(Swift, 손한솔) 문서에 맞춘 Harness·출력 연결. 기존 형식(`harness.request`/`harness.resume`)은 그대로 두고, 같은 WebSocket 서버(`deskpet.harness.v1`)에서 아래 세 종류를 추가로 받는다.

근거 문서: `wiki/deskpet-pipeline/class-diagrams.md` §4·§5 (기준 코드 `84d52f9`), `wiki/deskpet-interface-contracts.md` §4·§6·§7.

원칙 (2026-10-12 사용자 결정): **문서에 적힌 부분은 문서에 맞추고, 없는 부분은 현재 Harness 구현을 따른다. 나중에 맞춰 고칠 수 있게 한 곳(`pipelineBridge.ts`)에 모은다.**

## 메시지

| 봉투 kind | 문서의 호출 | payload → 응답 |
| --- | --- | --- |
| `harness.run` | `HarnessAdapter.run(HarnessRequest)` | `{action, transcript, context, wikiSearchAllowed, mutationApproved}` → `harness.run.result` `{action: ActionResult, question, resultText}` |
| `harness.reconcile` | `HarnessAdapter.reconcile(ActionRequest)` | `{requestId, operationId, decision, deadlineAt}` → `action.result` ActionResult |
| `output.generate` | `OutputModel.generate(OutputRequest)` | `{requestId, outputId, action?, reminder?, requiredText, isQuestion}` → `output.text` `{text}` |

봉투 규칙은 기존과 같다 (`docs/ws-protocol.md`): `harness.run`은 `deadlineAt` 필수, 봉투 `requestId` = `action.requestId`.

## 문서를 따른 부분

- 한 번의 `run`이 결과 하나를 돌려준다. 질문이면 `status: "needs_clarification"` + `question` 문장, 결과면 `resultText`.
- 결과 상태: `succeeded` / `failed` / `needs_clarification` / `unknown` / `cancelled` (interface-contracts §7).
- `ActionResult.operationId`는 파이프라인이 보낸 `operationId`를 그대로 돌려준다. `facts`는 문자열 사전.
- `mutationApproved`는 기본 false. **false면 답변이 "응"이어도 쓰지 않고 다시 묻는다.** true여도 Harness가 답변·STT·라우터 신뢰도를 따로 검사한다 ("변경 도구 승인 여부는 adapter에서도 확인").
- 응답 유실은 `unknown`. `reconcile`은 다시 보내지 않고 조회로만 확인한다.
- 출력 모델은 문자열을 돌려준다. `requiredText`를 기준 문장으로 쓴다.

## 문서에 없어 현재 구현을 따른 부분 (합의 필요)

| # | 항목 | 지금 처리 |
| --- | --- | --- |
| P-01 | JSON 인코딩 | 날짜는 ISO 8601 문자열(UTC), UUID는 문자열. Swift `JSONEncoder`에 `.iso8601` 필요 |
| P-02 | 대상 형식 (`resolvedTarget`, `activeTarget`) | Harness Target 형식일 때만 사용: `{kind:"github_pr", repository:{owner,name}, prNumber}`, `{kind:"eureka_stage", itemId, stageId}` 등. 아니면 대상 없음 → Harness가 "어느 PR인가요?"를 묻는다 |
| P-03 | 대화 ID | 요청의 `conversationId`(확장) → `context.stamp.conversationId` → 기본값 `deskpet-default` |
| P-04 | 질문 문장 | Harness가 코드로 만든 고정 문장을 `question`에 넣는다 (LLM 아님). 범위 문구(저장소·PR·커밋·행위)를 포함 |
| P-05 | 질문 전달 보고 | 기존 `pipeline.event` `question_delivered` + 실제로 말한 `deliveredText` 필수. `pendingId`·`outputId`는 결과 `facts`로 준다. 보고가 없으면 답을 받지 않는다 |
| P-06 | 답변 연결 | ① `pendingClarification.pendingId` ② 같은 `requestId`의 대기 질문 ③ 답변으로 보이는 발화(의도 `confirm*`·없음, 또는 `mutationApproved`)면 같은 대화의 최근 대기 질문 |
| P-07 | 새 요청이 오면 | 같은 대화의 대기 질문을 철회한다. 뒤이은 "네"가 이전 승인 질문에 붙지 않게 하기 위해서다 |
| P-08 | Eureka 업무 연결 | 요청의 `taskRefs`(확장, Harness TaskRef 형식). 없으면 승인 뒤 Eureka 후속 질문은 생략된다 |
| P-09 | 결과 하나로 줄이기 | 쓰기 작업 결과를 우선한다. 승인 성공 뒤 Eureka 확인 질문이면 `needs_clarification` + `facts.action=submit_approval` |
| P-10 | 출력 모델 필수 의미 | `action.facts.requiredMeaning`(줄바꿈 구분)이 있으면 그 문구를, 없으면 `requiredText` 전체를 그대로 지킨다. 성공하지 않은 작업은 다듬지 않고 `requiredText`를 그대로 돌려준다 |
| P-11 | reconcile 대상 | 같은 `requestId`의 쓰기 operation 중 결과 확인이 필요한 것. 없으면 `unknown` + `RECONCILIATION_UNAVAILABLE` |
| P-20 | Eureka 반영 응답 시점 (D-23) | Eureka 동의 답변 뒤 최대 `followUpReplyWaitMs`(기본 3초)만 기다린다. 끝나면 결과를 그대로, 아니면 `status: unknown` + `facts.inProgress: "true"` + `facts.harnessOperationId`를 돌려주고 "진행 중이에요. 끝나면 알려 드릴게요"를 `resultText`로 준다. 끝난 결과는 서버 **notice**로 온다 |
| P-21 | 서버 notice (D-23) | 요청 없이 오는 프레임 `{"type":"notice", notice:{noticeId, source:"late_completion"\|"recovery", requestId, operationId, action, status, result(HarnessResult), pipelineAction(문서 형식 ActionResult), observedAt}, resultText}`. pipeline 연결에만 보낸다. 파이프라인은 `resultText`를 출력 모델 `requiredText`로 써서 사용자에게 알린다. 복구로 GitHub 승인이 성공 확정되고 연결된 Eureka 단계가 반영 가능하면(단계 미완료·보류 아님·승인 뒤 새 커밋 없음, 기록에서 찾은 연결이면 기록에 PR 주소가 남아 있음) `result.pending`에 확인 질문이 실리고 `pipelineAction.status=needs_clarification`, `pipelineQuestion`에 질문 문장이 온다 (D-24). 파이프라인은 일반 질문처럼 말한 뒤 `pipeline.event question_delivered`를 보고하고 답을 `harness.run`으로 보낸다. 연결이 없을 때 온 notice는 버려지며, 같은 변경은 `operation.updated`와 snapshot으로도 확인된다 |
| P-22 | Eureka 반영 다시 하기 (D-23) | 라우터 intention `eureka.retry`(또는 `followup.retry`)로 `harness.run`. 같은 대화에서 가장 최근의 Eureka 단계 완료가 **명시적 실패**일 때만 새 작업으로 다시 보낸다. "다시 해줘" 발화 자체를 동의로 본다(새 확인 기록, 전달 근거 `retry_request`). 결과 불명이면 다시 보내지 않는다. `facts.retryStatus`: `started` / `already_done` / `result_unknown` / `blocked` / `approval_not_confirmed` / `input_blocked` / `nothing_to_retry` |
| P-23 | 처리 시간 (D-26) | `harness.run` 결과 `action.facts.timings` = `{"totalMs":n, "stages":[{"stage":"github.getReviewContext","ms":n,"ok":true}, …]}` (JSON 문자열). `output.generate` 응답은 `{text, modelMs?}`. 파이프라인은 자기 단계(STT·라우터·TTS) 시간과 합쳐 NFR-01 기록을 만든다 |

`facts` 키: `harnessRequestId`, `disposition`, `action`, `harnessOperationId`, `dispatchState`, `questionKind`(clarification|confirmation), `questionPurpose`, `pendingId`, `outputId`, `expiresAt`, `requiredMeaning`, `prNumber`, `repository`, `headSha`, `blockedReasons`.

## EurekaAdapter (`eureka.*`)

| 봉투 kind | 문서의 호출 | 응답 |
| --- | --- | --- |
| `eureka.execute` | `EurekaAdapter.execute(ActionRequest)` | `action.result` ActionResult. deadlineAt 필수 |
| `eureka.reconcile` | `EurekaAdapter.reconcile(ActionRequest)` | `action.result`. 조회만, 재전송 없음 |
| `eureka.reminders` | `EurekaAdapter.reminders()` | `eureka.reminders.result` `{items, skipped, completeness, observedAt}` |
| `eureka.reminder` | `EurekaAdapter.reminder(itemId)` | `eureka.reminder.result` `{item | null}` |
| `eureka.links` (P-19, 문서에 없음) | — | `eureka.links.result` PrLinkLookup `{itemId, itemName, status, links[], observedAt}` |

문서를 따른 부분: 입력·결과 형식, 리마인더는 설명(`description`)과 시간대가 붙은 실제 마감(`dueAt`)만 쓰고 설명이 없으면 업무명으로 대체하지 않고 뺀다 (interface-contracts §9), 쓰기 응답 유실은 `unknown`.

| # | 문서에 없어 정한 것 | 지금 처리 |
| --- | --- | --- |
| P-12 | 의도 값 | `eureka.list`(·`query`), `eureka.status`, `eureka.postpone`(·`update_due_date`), `eureka.register`(·`create`), `eureka.complete`. 그 외는 `failed` + `POLICY_BLOCKED` |
| P-13 | 슬롯 | 헤드 `name`(업무 이름, 정확히 일치), `dueAt`(시간대 포함 ISO만), `task`(등록 시 프로세스 이름). 대상은 `resolvedTarget`이 `{kind:"eureka_item", itemId}`면 우선 |
| P-14 | 쓰기 확인 | 직접 경로 쓰기는 `mutationApproved: true`(확장)일 때만 보낸다. 아니면 `needs_clarification` + `facts.question`(고정 확인 문장). 사용자 확인 정책 자체는 파이프라인 Eureka 모듈 소유 |
| P-15 | 기록 | 쓰기는 operation 기록(`owner=pipeline_eureka_module`)과 DurableAck를 거친다. 같은 `operationId` 재요청은 다시 보내지 않고 기록된 결과를 준다 |
| P-16 | 결과 문장 | `facts.resultText`에 고정 문장. 파이프라인은 출력 모델의 `requiredText`로 쓴다 |
| P-17 | 리마인더 형식 | `{itemId, reminderKey(itemId:dueAt), name, description, dueAt(+09:00), timezone, state}`. 24시간 필터·주기·중복 방지는 파이프라인 담당(문서) |
| P-18 | 등록 프로세스 | `.env` `EUREKA_DEFAULT_PROCESS_ID` 또는 `task` 헤드 값과 이름이 같은 프로세스. 둘 다 없으면 등록하지 않음 |
| P-19 | 업무 → PR 연결 | Eureka에는 PR 필드가 없어, **단계 기록(note)** 본문의 `https://github.com/{owner}/{repo}/pull/{번호}`로 연결한다. `eureka.links {requestId, itemId}`가 기록이 있는 단계만 `GET /_api_/notes/0/list?sites&detail=true&stageId=`로 읽는다. 결과 `status`: `linked`(PR·단계 조합 1개) / `ambiguous`(2개 이상, 추측 안 함) / `none` / `partial`(일부 기록 조회 실패) / `failed` / `not_found`. 기록 원문은 결과에 넣지 않는다. 파이프라인은 `links[0]`으로 `resolvedTarget`(github_pr)과 `taskRefs`(`itemId`, 기록이 붙은 `stageId`)를 채워 `harness.run`을 보낸다 (서버 `harnessContextFromLink`). 허용 저장소 목록·작성자 제한은 아직 없음 (사용자 결정 2026-10-24, 나중에 추가) |

Eureka 쓰기는 서버에서 계속 꺼져 있다 (`allowWrites=false`). 승인돼도 "쓰기가 꺼져 있어서 … 보내지 않았어요"로 끝난다. 실제 개발 환경 Eureka에는 `description` 필드가 없어서(C-08) 지금은 리마인더 대상이 0건일 수 있다 — `pnpm smoke eureka`로 확인.

시험: `tests/e2e/eurekaBridge.test.ts`, `tests/e2e/prLinks.test.ts`(기록 → PR → 승인 → 그 단계 완료).

Eureka 쓰기는 이후 `pnpm harness --allow-eureka-writes`로 개발 환경에서만 켤 수 있다 (D-20).

## 흐름 예 (G-01)

1. `harness.run` "그 PR 리뷰해줘" → `succeeded`, `resultText`에 리뷰 요약
2. `harness.run` "승인해줘" → `needs_clarification`, `question` = "NewLine/DeskPet PR 42번, 현재 커밋 a1b2c3d을 승인할까요?"
3. `output.generate` (requiredText = 위 질문) → 말할 문장 → 재생 후 `pipeline.event` `question_delivered` + `deliveredText`
4. `harness.run` "응, 승인해" + `mutationApproved: true` → GitHub 승인 → `needs_clarification`, Eureka 반영 질문
5. 3과 같이 전달 보고 → `harness.run` "네" + `mutationApproved: true` → `succeeded` (`complete_stage`)

시험: `tests/e2e/pipelineBridge.test.ts`.

## 문서끼리 다른 점 (보고)

- interface-contracts·pipeline 문서는 Harness가 `question` 문장을 준다. message-contracts·Liability는 "Harness는 완성 문장을 만들지 않는다". → 문서 형식을 따르되 문장은 LLM이 아닌 고정 문구로 만든다 (P-04).
- pipeline 문서는 `mutationApproved` 하나로 승인을 표시한다. message-contracts는 pending·confirmation 기록과 전달 증거를 요구한다. → 둘 다 적용한다 (`mutationApproved` AND Harness 답변 검사 AND 전달 증거).
