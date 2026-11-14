# Eureka 직접 요청 시험 순서 (2026-11-09)

실제 Eureka에 붙어 직접 Eureka 요청 전체를 순서대로 확인한다. 쓰기는 **시험용으로 새로 만든 업무 하나에만** 한다.
명령은 PC의 `app` 폴더에서 PowerShell로 실행한다. `pnpm demo:adapter`는 파이프라인 대신 같은 형식(라우터 형식, D-33)의 메시지를 보낸다.

## 0. 준비

- `.env`: `EUREKA_API_KEY`, `EUREKA_BASE_URL`(선택), `EUREKA_DEFAULT_PROCESS_ID`(업무 등록용, 예: `general-work-v1@10200`), `HARNESS_WS_TOKEN`, `DESKPET_STORE_PATH`
- 조회·마감 변경·업무 연결·G-01(리뷰 → 승인 → 단계 완료)은 2026-11-09에 업무 1000014로 확인함. 이 문서는 그때 못 한 **등록·단계 기록·업무 완료·작업 번호·결과 조회**를 본다
- 확인 답변은 승인 말(응·네·승인해 등)이 있어야 승인된다. 그 밖의 답은 실행하지 않는다 (D-37)
- 자동 테스트: `pnpm check` → 모두 통과
- 읽기 연결: `pnpm smoke eureka` → ✓만 나오면 통과

## 1. 서버 켜기 (터미널 1)

```powershell
pnpm harness                     # 쓰기 허용이 기본 (D-38)
```

시작 화면에 쓰기 꺼짐 경고(`!`)가 없어야 한다.

## 2. 읽기 (터미널 2)

| # | 명령 | 기대 |
| --- | --- | --- |
| 2-1 | `pnpm demo:adapter eureka list` | `succeeded`, 진행 중 업무 수와 가장 가까운 마감 |
| 2-2 | `pnpm demo:adapter eureka processes` | 업무 유형 이름. `EUREKA_DEFAULT_PROCESS_ID`의 유형이 있는지 확인 |
| 2-3 | `pnpm demo:adapter eureka query "LLM_TEST_1"` | 상태·단계 수·마감 (`status`도 같음) |
| 2-4 | `pnpm demo:adapter eureka query "없는 업무"` | `failed` `EUREKA_NOT_FOUND`, "찾지 못했어요" |

## 3. 쓰기 (시험 업무 하나로)

각 쓰기는 먼저 확인 질문이 나오고, 답을 입력하면(응/아니) 같은 요청을 `mutationApproved=true`로 다시 보낸다.
결과에 찍힌 `requestId`·`operationId`를 적어 둔다.

| # | 명령 | 답 | 기대 |
| --- | --- | --- | --- |
| 3-1 | `pnpm demo:adapter eureka create "DeskPet 시험 1109" 2026-11-20T23:59:00+09:00` | 응 | 질문 "'DeskPet 시험 1109' 업무를 마감 …로 새로 등록할까요?" → `succeeded`, `facts.itemId` 있음. Eureka 웹에 업무가 보임 |
| 3-2 | `pnpm demo:adapter eureka query "DeskPet 시험 1109"` | — | 방금 만든 업무 상태, 마감 11/20 |
| 3-3 | `pnpm demo:adapter eureka postpone "DeskPet 시험 1109" 2026-11-21T18:00:00+09:00` | 아니 | "실행하지 않고 끝냅니다". 다시 조회하면 마감 그대로 |
| 3-4 | 같은 명령 | 응 | `succeeded`, 마감 11/21 18:00. 웹에서도 바뀜 |
| 3-5 | `pnpm demo:adapter eureka note "DeskPet 시험 1109" "PR: https://github.com/<owner>/<repo>/pull/<번호>"` | 응 | `succeeded`, `stageId`·`noteId` 있음. **웹에서 그 단계 기록이 보이는지** 확인 |
| 3-6 | `pnpm demo:adapter links <3-1의 itemId>` | — | `status: linked`, 3-5의 PR과 단계 |
| 3-7 | `pnpm demo:adapter eureka unsupported` | — | `EUREKA_OPERATION_NOT_IMPLEMENTED`, "업무 삭제는 아직 지원하지 않아 …" |

## 4. 작업 번호·결과 조회

| # | 명령 | 기대 |
| --- | --- | --- |
| 4-1 | `pnpm demo:adapter eureka reconcile --req <3-4 requestId> --op <3-4 operationId>` | 3-4와 같은 결과(`succeeded`) |
| 4-2 | `pnpm demo:adapter eureka reconcile --req <3-4 requestId> --op 없는번호` | `unknown` `RECONCILIATION_UNAVAILABLE` |
| 4-3 | `pnpm demo:adapter eureka complete "DeskPet 시험 1109" --req <3-4 requestId> --op <3-4 operationId> --answer 응` | `failed` `OPERATION_ID_REUSED`. 업무는 완료되지 않음 |

## 5. 완료

| # | 명령 | 답 | 기대 |
| --- | --- | --- | --- |
| 5-1 | `pnpm demo:adapter eureka complete "DeskPet 시험 1109"` | 응 | `succeeded`. 웹에서 완료 |
| 5-2 | 같은 명령 | — | `failed` `POLICY_BLOCKED`, "이미 완료돼 있어요" |
| 5-3 | `pnpm demo:adapter eureka list` | — | 시험 업무가 목록에서 빠짐 |

## 6. Eureka 내부 API 서버로 (D-31)

터미널 1을 끄고:

```powershell
pnpm eureka:server               # 쓰기 허용이 기본. EUREKA_STORE_PATH 필요 (DESKPET_STORE_PATH와 다른 파일)
```

| # | 명령 | 기대 |
| --- | --- | --- |
| 6-1 | `pnpm demo:adapter --eureka-server eureka list` | 2-1과 같음 |
| 6-2 | `pnpm demo:adapter --eureka-server eureka query "DeskPet 시험 1109"` | 완료 상태 |

## 정리

- 시험 업무 "DeskPet 시험 1109"는 Harness로 지울 수 없다(삭제 미지원). 5-1에서 완료 처리되므로 목록에서는 빠진다. 필요하면 Eureka 웹에서 지운다
- `--approve`를 붙이면 확인 질문에 답을 묻지 않고 승인한다 (예전 명령과 같은 동작)

## 기록

각 단계의 결과(통과/실패), 실패면 화면 출력, 처리 시간(서버 콘솔 `[timing]` 줄)을 `docs/connection-test-issues.md`에 남긴다.
