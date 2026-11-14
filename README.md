# DeskPet Harness MVP

김도헌 담당 영역(LLM Harness, Eureka/GitHub Gateway, 출력 체인, 웹 상태 투영)의 **실행 가능한 MVP**다.
설계 계약을 코드로 옮기고 골든 시나리오 G-01과 S-04~S-11을 fake Gateway 기반 end-to-end 테스트로 검증한다.
실제 GitHub·Eureka·LLM 연결, SQLite 영속 저장소, WebSocket 서비스 경계, 보기 전용 웹 화면까지 동작한다.

> 아직 아닌 것: 파이프라인(손한솔)·장치(박종하)와의 실제 통합, Eureka 쓰기 시험, Copilot 리뷰 실데이터 검증, GitHub MCP 어댑터, LLM Wiki 저장소 연결.

## 설계 원본 (vault)

| 문서 | 이 저장소에서의 역할 |
| --- | --- |
| `wiki/deskpet_harness_guide_Liability.md` | 실행 정책 원본 (확인·재시도·복구·기록) |
| `wiki/deskpet-harness-message-contracts.md` | DTO·메서드·전송 경계 계약 |
| `wiki/deskpet-harness-guide-sensor.md` | Guide/Sensor 입출력 계약 |
| `wiki/deskpet-pr-review-golden-scenario.md` | G-01, S-01~S-12 |
| `wiki/eureka-process.md`, `eureka-desk-pet-guide.pdf` | Eureka REST API |
| `wiki/deskpet-interface-contracts.md` | 팀 공통 타입 (RouteDecision 등), timeout 제안값 |
| `wiki/deskpet-technology-stack.md` | 담당 범위·기술 후보 |
| `mermaid-diagram.png`, `mermaid-diagram (1).png` | 기록·메시지 / 서비스·Gateway 클래스 다이어그램 |

vault 파일은 원칙적으로 수정하지 않는다. 예외: `deskpet-harness-message-contracts.md`의 투영 절에 snapshot 범위 제한 문장 하나를 사용자 요청으로 추가했다 (D-16). 문서와 코드가 충돌하면 아래 "문서 충돌과 잠정 처리"에 기록하고 보고한다.

## 구조

```
packages/
  contracts/   zod 스키마와 port 타입 (Envelope, Harness, Records, Review, Guide/Sensor, Output, Projection, LLM)
  harness/     HarnessService, RuleFirstGuide(규칙 + LLM 보조), Sensor, OperationStore(메모리 판단 + SQLite 저널), DispatchOwner, policy
  gateways/    eureka/ (REST + fake), github/ (REST transport + fake, ReviewGateway)
  output/      OutputService(검증 + 고정 문구), HarnessOutputMapper, 출력 지침
  projector/   RequestStateProjector (revision, epoch, tombstone, snapshot)
  llm/         Gemini·OpenAI 어댑터, 공급자 중립 출력 모델, 호출 상한, .env 설정
  server/      Harness 서비스 경계 (WebSocket, 인증·역할·재전송·구독)
apps/web/      보기 전용 웹 화면 (Vite + React + Tailwind + shadcn/ui)
demo/          파이프라인 형식 시험 클라이언트 (pnpm demo:adapter) — 서버는 import하지 않음
scripts/       server(pnpm harness), smoke, store 조회(pnpm db), web-fixture
tests/         e2e 시나리오 + 테스트 지원 (fake world, 흐름, 크래시 자식 프로세스)
docs/          연결 이슈 기록, LLM, 영속 저장소, WebSocket 프로토콜, 웹 화면
```

## 빠른 시작 (PC)

Node.js 22.13 이상(`node:sqlite`)과 pnpm이 필요하다.

```bash
pnpm install
cp .env.example .env     # 값 채우기 (아래 표)
pnpm check               # typecheck + lint + test
pnpm harness             # 터미널 1: Harness 서버 (ws://127.0.0.1:8787)
pnpm demo:adapter harness 12   # 터미널 2: 시험 클라이언트로 G-01 흐름 (파이프라인 형식)
pnpm web:dev             # 터미널 3: 웹 화면 http://127.0.0.1:5173 (보기 전용 토큰 입력)
# 또는 한 번에: pnpm start  → 웹 빌드 + Harness 서버, 브라우저에서 http://127.0.0.1:8787 (D-42)
```

## 명령

| 명령 | 내용 |
| --- | --- |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm check` | vitest / tsc(패키지 + 웹) / eslint / 셋 다 |
| `pnpm smoke [eureka\|github\|llm]` | 연결 테스트. Eureka·GitHub는 읽기만, llm은 작은 호출 2번 |
| `pnpm harness [--read-only]` | Harness 서버. 시작 시 보존 정리·결과 불명 쓰기 읽기 확인, Ctrl+C 시 처리 중 요청을 마치고 종료 |
| `pnpm eureka:server [--read-only]` | Eureka 내부 API 서버 (D-31, 기본 ws://127.0.0.1:8789). 직접 Eureka 요청(`eureka.*`)만 별도 프로세스에서 받는다. Harness 서버는 `DESKPET_EUREKA_BRIDGE=external`로 켠다 |
| `pnpm demo:adapter [--fixture] <명령>` | 파이프라인 문서 형식(adapter) 시험 클라이언트: `reminders`, `reminder <itemId>`, `eureka list`, `eureka status "업무"`, `eureka postpone "업무" <ISO+09:00> [--approve]`, `links <itemId>`, `harness [PR] [--item <itemId>]`. `--fixture`는 `pnpm web:fixture` 서버(가짜 GitHub·Eureka)에 붙음 |
| `pnpm wiki "질의" [--dir <vault>]` | LLM Wiki 검색 확인 (읽기 전용). Guide에 넘길 발췌·출처를 그대로 보여 줌 |
| `pnpm db [ops\|op <id>\|pending\|dedup\|turns\|raw …]` | 저장소 조회 (읽기 전용, 기록을 바꾸지 않음) |
| `pnpm demo:seed [--reminders]` | 시연용 실행 기록: 켜 둔 서버에 업무 목록·상태·없는 업무·담당자 조회(미지원)·등록 질문·PR 리뷰·승인 질문→거절을 보내 기록 탭에 여러 결과를 남긴다(외부 변경 없음). `--reminders`면 리마인더 예시 업무 3개(마감 1·3·6일 뒤, 이름 앞에 [시연])를 Eureka에 등록 — 쓰기 |
| `pnpm start [옵션]` | 웹 화면 빌드 + Harness 서버. 서버가 빌드한 화면을 같은 주소·포트(`http://<주소>:8787`)로 내보낸다 (D-42). 옵션은 `pnpm harness`와 같음. 감시 프로세스로 띄워 웹에서 업데이트하면 자동 재시작 (D-50) |
| `pnpm web:dev` / `pnpm web:build` | 웹 화면 개발 서버 / 빌드 |
| `pnpm web:fixture` | 실제 API 없이 여러 상태를 만든 fixture 서버 (웹 화면 확인용) |

`pnpm server`, `pnpm store`는 pnpm 자체 명령과 이름이 겹쳐 쓰지 않는다.

## 환경 변수 (`.env`, 자세한 설명은 `.env.example`)

| 묶음 | 변수 |
| --- | --- |
| Eureka | `EUREKA_API_KEY`, `EUREKA_BASE_URL`(선택, 기본 Eureka API 주소), `EUREKA_TEST_ITEM_ID` |
| GitHub | `GITHUB_TOKEN`, `GITHUB_TEST_REPO`, `GITHUB_TEST_PR`, `DESKPET_REQUIRED_CHECKS` |
| 시험 클라이언트 | `HARNESS_WS_URL` (`pnpm demo:adapter`) |
| 저장소 | `DESKPET_STORE_PATH` (예: `.deskpet/harness.db`, 비우면 메모리) |
| LLM | `LLM_PROVIDER`(off·gemini·openai), `GEMINI_API_KEY`, `GEMINI_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `LLM_*` 상한 |
| 서버 | `HARNESS_WS_TOKEN`(실행용), `HARNESS_WS_VIEWER_TOKEN`(웹 화면용), `HARNESS_WS_HOST`/`PORT`, `HARNESS_WS_ALLOWED_ORIGINS`, `HARNESS_WEB_ADMIN_TOKEN`(웹 업데이트, D-50), `DESKPET_HISTORY_PATH`(세션 기록, D-47), `HARNESS_UPDATE_CHECK`(새 버전 알림, D-49) |

비밀값은 `.env`에만 두고(`.gitignore` 대상) 코드는 키를 로그·기록·오류 메시지에 넣지 않는다. 브라우저에는 보기 전용 토큰만 넣는다.

## 쓰기 안전장치

- 기본은 모든 쓰기 비활성. 승인 단계는 "쓰기가 꺼져 있어서 보내지 않았어요"로 끝나고 DurableAck도 요청하지 않는다.
- GitHub 승인 쓰기는 기본으로 켜져 있다(D-38, `--read-only`·`--no-github-writes`로 끔). 승인은 **요청 쪽 사용자 확인**(확인 질문 전달 + 승인 답변)만으로 받는다. 서버 콘솔 `yes` 확인은 없앴다 (D-22).
  - 쓰기 모드는 `DESKPET_STORE_PATH`(영속 저장소)가 있어야 시작하고, 같은 DB는 한 프로세스만 연다 (`<DB>.lock`).
  - 보내기 직전 Gateway가 PR 상태·head SHA·권한·필수 검사를 다시 확인하고, 어긋나면 보내지 않는다.
- 확인 질문의 답은 **실제로 전달한 문장**이 저장된 범위(저장소·PR·커밋·행위)와 맞을 때만 받는다. 출력 모델은 이 범위 문구를 바꿀 수 없고, 성공하지 않은 쓰기 결과는 모델 문장 없이 고정 문장으로만 알린다.
- 봉투 deadline이 지났거나 봉투·payload의 요청 ID가 다르면 실행하지 않는다.
- Eureka 쓰기는 기본으로 켜져 있다(D-38, `--read-only`·`--no-eureka-writes`로 끔). 보내기 직전 단계 상태(이미 완료·보류)를 다시 확인한다.
- 본인이 연 PR은 GitHub 규칙상 승인할 수 없어 확인 질문 전에 막힌다.

## 실제 연결 기록

| 대상 | 결과 |
| --- | --- |
| GitHub | 테스트 저장소에서 리뷰 조회·필수 검사(rulesets/classic + DeskPet 대체 목록)·중복 실행 제거 확인. PR #11(다른 계정 작성)에 실제 승인 성공 (review 5410644915). 승인은 merge가 아니다 |
| Eureka | 읽기 확인 (키 역할 guest, description 필드 없음). 2026-10-12 실제 쓰기 성공: PR #15 승인 뒤 G-01 후속으로 item 1000020의 stage 1000195를 `done`으로 반영 (`--allow-eureka-writes`, 콘솔 yes 2회). Eureka 화면에서도 완료 확인 |
| LLM | Gemini `gemini-3.1-flash-lite`로 Guide 단계 제안·출력 문장 다듬기 확인 |
| 서버·데모 | PC에서 `pnpm harness` + `pnpm demo 12`로 WebSocket 경계 너머 G-01 흐름 확인. 2026-10-12 `pnpm demo 15 --ask`로 리뷰 → GitHub 승인(review 5490862511) → Eureka 단계 완료까지 G-01 전체를 실제 서비스로 확인 |

문제와 해결 과정은 `docs/connection-test-issues.md` (1~17번).

## 구현 원칙 (요약)

1. LLM/Guide 제안 ≠ 실행 권한. 사용자 확인·중복·SHA·deadline·STT confidence 검사는 일반 코드(`harness/policy`)가 한다.
2. 쓰기 전송 후 결과 불명은 `ActionResult.status = unknown`. 자동 재전송·자동 롤백 없음.
3. DispatchOwner 프로토콜: `may_have_been_sent` 영속 저장 ack 이후에만 Gateway가 외부 쓰기를 전송한다.
4. 재시도: 읽기 일시 오류는 deadline 안에서 최대 1회, 쓰기는 `not_sent`가 확실할 때만 조건부 1회.
5. GitHub 승인과 Eureka 단계 완료는 각각 별도 confirmation·operation. MCP 성공 문구만으로 `succeeded`를 만들지 않는다.
6. 문서에 근거가 없는 결정은 코드 주석과 아래 표에 `inference` / `미정`으로 표시한다.

## 잠정 결정

| ID | 결정 | 상태 |
| --- | --- | --- |
| D-01 | 언어는 TypeScript + Node.js 22.13 이상, pnpm, vitest, zod. 기술 스택 문서의 Python 출력 체인 요약과 TS 상세 표가 불일치하며 TS를 따른다 | **잠정** |
| D-02 | 저장소는 메모리에서 판단하고 변경을 SQLite(`node:sqlite`)에 동기 저널로 기록한다. 기록 실패 시 메모리도 되돌린다. 보존 정책으로 기록이 끝없이 쌓이지 않게 한다 (`docs/persistent-store.md`) | 구현 (사용자 요청 2026-10-05) |
| D-03 | LLM은 외부 API (`LlmClient`/`OutputModel` port). 개발 기본은 Gemini `gemini-3.1-flash-lite`, `.env`의 `LLM_PROVIDER`로 OpenAI 전환. 규칙 우선 + LLM 보조 Guide, Sensor는 결정적 (`docs/llm-integration.md` L-01~L-09) | 사용자 결정 2026-10-05 |
| D-04 | 수치(임계값·기한·용량·복구 상한)는 `harness/src/policy/config.ts`의 자리값. 실측 후 조정 | 미정 |
| D-05 | Gateway 쓰기 메서드는 다이어그램의 `ActionResult` 대신 정규화된 `GatewayResult`를 반환한다. guide-sensor 흐름(Gateway → Sensor → Harness commit)을 따르기 위함 | inference |
| D-06 | DispatchHandle·AckResult·Gateway port 타입은 `contracts/src/ports.ts`에 둔다. harness가 gateways 구현에 의존하지 않게 함 | inference |
| D-07 | 리뷰 요청과 승인 요청은 파이프라인이 서로 다른 requestId로 줄 수 있다. 승인 요청부터 GitHub 승인·Eureka 확인·반영·최종 출력까지는 같은 requestId를 유지한다 | inference |
| D-08 | 라우터 intention 값 `pr.review`, `pr.approve`, `confirm.approve`, `confirm.reject`와 확인 답변 키워드 규칙은 잠정값이다. 애매하면 `unclear`, 거절 신호가 우선 | inference |
| D-09 | 요청 메타데이터(intent·taskRefs·취소)는 HarnessService 메모리에 둔다. 재시작 시 pending에서 최소 정보를 복원한다. operation·pending·confirmation은 저장소에 있다 | 잠정 |
| D-10 | Eureka `getChangeOutcome`은 멱등키가 없어 인과 연결을 `candidate_only`로만 보고한다. 응답 유실된 단계 완료는 `unknown` + `recovery=needed`로 남고 운영 조치로 정리한다 | inference (C-09) |
| D-11 | 권한을 조회할 수 없으면 승인을 차단한다 (`permission_unverified`). GitHub 실제 권한 조회 수단은 미정 | inference |
| D-12 | 읽기(`get_review_context`)도 OperationRecord로 기록한다. "사용자가 들은 리뷰 SHA"는 같은 대화의 최근 성공 리뷰 operation에서 찾는다 | inference |
| D-13 | 필수 검사 설정 조회 결과를 `configured`/`none_configured`/`unknown(plan_unsupported·insufficient_permission·lookup_failed)`로 구분한다. rulesets(읽기 권한)와 classic protection(관리자 권한)을 함께 본다. GitHub가 요금제상 보호 기능을 제공하지 않을 때(`plan_unsupported`)만 DeskPet 대체 목록(`DESKPET_REQUIRED_CHECKS`)을 쓰고 출처를 `deskpet_config`로 표시한다. 대체 목록이 없거나 다른 이유면 계속 차단 | 사용자 결정 2026-10-05 |
| D-14 | 필수가 아닌 검사의 실패·진행 중은 승인을 막지 않고 경고(`approvalWarnings`)로 리뷰 요약과 확인 질문에 알린다 | 사용자 결정 2026-10-05 |
| D-15 | Harness 서비스 경계는 WebSocket `deskpet.harness.v1`. 본문은 기존 Envelope, 수신 변환 층은 지금 Harness 입력을 그대로 전달 (`docs/ws-protocol.md`) | 사용자 결정 2026-10-05 |
| D-16 | 투영 snapshot 범위는 source 전체로 제한 (vault message-contracts에 사용자 요청으로 한 문장 추가) | 사용자 결정 2026-10-05 |
| D-17 | 웹 화면은 보기 전용. 서버의 viewer 전용 토큰으로만 접속하고 변경 기능은 없다 (`docs/web-ui.md`) | 구현 |
| D-18 | GitHub 쓰기는 서버 실행 옵션 `--allow-github-writes`일 때만. (콘솔 `yes` 확인은 D-22로 없앰) | 사용자 결정 2026-10-05, 2026-10-24 갱신 (실행 옵션은 D-38로 대체, D-44로 정리) |
| D-20 | Eureka 쓰기는 영속 저장소가 있을 때만. (콘솔 `yes` 확인은 D-22로 없앰, 주소 제한은 2026-11-14에 없앰 — Eureka 주소를 나누지 않음) | 사용자 결정 2026-10-12, 2026-11-14 갱신 (실행 옵션은 D-38로 대체, D-44로 정리) |
| D-29 | **2차 의도 확인**: 라우터가 `llm`·`unclear` 같은 일반 의도로 보낸 요청은 LLM이 한 번 더 보고(`intent-v1`, 선택지 pr_review·pr_approve·other) PR 리뷰·승인이면 규칙 Guide 경로로 보낸다. LLM은 의도 이름만 고르고 대상·실행은 정하지 않는다. 승인은 그대로 승인 전 검사 → 확인 질문 → "응"이 있어야 실행되고, 쓰기 입력 신뢰도 기준(STT 0.85·라우터 0.53, D-35)도 그대로. 실패·other면 원래 의도로 기존 LLM Guide 경로. 결과는 `facts.intentRecheck`. LLM Guide가 막으면 진짜 이유를 `reason:<why>`로 함께 남긴다. `DESKPET_INTENT_RECHECK=off`로 끄고, 신뢰도 기준은 `DESKPET_MIN_STT_CONFIDENCE`·`DESKPET_MIN_ROUTE_CONFIDENCE`로 바꿀 수 있다(비우면 기본값) | 사용자 결정 2026-11-02 (시연) |
| D-34 | **하네스 내부 보완 (2026-11-08, wiki 대조 후 바로 할 수 있는 것)**: ① `eureka.reconcile`은 `operationId`가 정확히 맞는 기록만(다른 작업 결과로 대신하지 않음) ② 같은 `operationId`로 다른 Eureka 요청이 오면 `OPERATION_ID_REUSED`로 거절 ③ 업무 등록 결과에 `facts.itemId` ④ 단계 기록 추가 응답 유실 시 결과 조회가 같은 내용의 기록을 후보로 찾음(다시 보내지 않음) ⑤ `taskRefs`가 없으면 승인 뒤 단계 기록에서 PR 주소로 연결 단계를 찾음(한 곳만, 모호·일부 실패면 추측 안 함) ⑥ LLM 장애 때 대상 PR이 있는 읽기 요청은 리뷰(읽기)만 대신 처리(승인·병합 말이 있으면 안 함, wiki operation-policies "고정 경로로 전환") ⑦ 파이프라인 미연결 때 알림 보관(50건·10분) 후 다음 연결에 전달 ⑧ 업무 `updatedAt` 보존 ⑨ 단계 기록 조회 상한 100건 | 구현 2026-11-08 |
| D-35 | **쓰기 입력 기준·승인 단어 (2026-11-08 사용자 결정)**: ① 라우터 통합 신뢰도(`routeDecision.overallConfidence`) 기본 기준 0.8 → **0.53** (실증값이 나오면 다시 조정, `DESKPET_MIN_ROUTE_CONFIDENCE`로 바꿀 수 있음). STT 기준 0.85는 그대로 ② 확인 답변 승인 단어에 **"반영해"** 추가 (거절 단어가 있으면 거절 우선, "반영하지 마"는 거절) ③ C-06은 Liability대로 Eureka 반영 전 별도 확인을 유지 | 사용자 결정 2026-11-08 |
| D-36 | **허용 저장소 목록 (D-21 보안 보류분)**: `DESKPET_ALLOWED_REPOS=owner/name,…`(대소문자 무시). 목록 밖 저장소 PR은 리뷰(읽기)는 하지만 승인 전 확인에서 `repository_not_allowed`로 막아 승인 질문을 만들지 않는다. `eureka.links`는 목록 밖 PR 주소를 후보에서 빼고 `excludedCount`로 알린다. 승인 뒤 단계 자동 찾기도 목록 안 PR만. 비우면 지금처럼 제한 없음. 형식이 틀리면 서버가 시작하지 않는다 | 사용자 결정 2026-11-08 |
| D-37 | **확인 답변 판정 강화 (2026-11-09 실제 시험 사고)**: 시험 클라이언트가 "거절"·영문 자판 오타("rjwjf")를 승인으로 보내 GitHub 승인과 Eureka 단계 완료가 실제로 실행됐다. ① 거절 말에 거절·거부·안 해·하지 말·reject 추가 ② 라우터가 `confirm.approve`라고 해도 문장에 승인 말이 없으면 unclear(다시 묻기) — 승인은 승인 말이 있어야만 ③ 시험 클라이언트(`demo:adapter`)도 같은 말 목록으로 승인/거절/unclear를 정하고, unclear면 `mutationApproved=false` | 2026-11-09 |
| D-38 | **승인 말 확장·쓰기 기본 허용 (2026-11-09 사용자 결정)**: ① 확인 답변에서 짧은 긍정(어·엉·넹·네네·ㅇㅋ·콜·sure…)과 동의·실행 요청(알겠어·오케이·당연·해줘·해 주세요·부탁해·진행·처리해·go ahead…)을 모두 같은 승인으로 본다. 거절 말(아니·취소·보류·거절·않·별로·그만…)이 있으면 거절 우선, 되묻는 말(…까?, …?)은 승인이 아니다(다시 묻기). 중복 실행은 라우터·DurableAck·작업 번호가 막는다 ② `pnpm harness`·`pnpm eureka:server`는 **쓰기 허용이 기본**. `--read-only`(모두 끔)·`--no-github-writes`·`--no-eureka-writes`로 끈다. 예전 `--allow-*-writes`는 받기만 하고 효과 없음. 영속 저장소가 없으면 그 쓰기를 끄고 경고와 함께 시작한다(D-18·D-20 대체) | 사용자 결정 2026-11-09 |
| D-39 | **승인 요청은 느슨하게 (2026-11-10 사용자 결정, Jetson 음성 시험 뒤)**: 이 STT는 신뢰도 점수가 정확도와 맞지 않았다(틀린 "생일해줘" 0.96, 맞는 "승인해줘" 0.67). ① 승인 '요청' 단계는 STT·라우터 신뢰도로 막지 않고 확인 질문까지 간다(질문이 저장소·PR·커밋을 다시 읽어 줌). 확인 답변 단계는 그대로 엄격(신뢰도·승인 말·거절 우선) ② 대상 PR이 있고 '승인해' 또는 STT가 비슷하게 잘못 듣는 말(성인·생일·승일 등 + 해)이면 LLM 없이 규칙으로 승인 요청(`facts.intentRecheck.by=rule`) ③ 다시 말해 달라는 문장에서 PR 번호 요구를 뺌(PR이 여럿이 되면 다시 넣음). `DESKPET_APPROVAL_REQUEST_INPUT=strict`로 예전 동작. STT 정확도가 오르면 다시 검토 | 사용자 결정 2026-11-10 |
| D-40 | 확인 답변 승인 말에 **"추가"** 추가("추가해", "추가해 줘"). Eureka 단계 완료 확인 질문("…완료로 반영하고, …단계 기록에 추가할까요?")에 "반영해"·"추가해"로 답할 수 있게. "반영"은 D-38부터 있음. 거절 말 우선은 그대로("추가하지 마", "반영 안 해"는 거절). 파이프라인 승인 정규식에도 같은 말이 있어야 `mutationApproved=true`가 온다 | 사용자 결정 2026-11-10 |
| D-41 | **리뷰 뒤 다음 질문 (2026-11-10 사용자 결정)**: 리뷰만 하고 끝나 승인 요청이 어색하던 문제. ① 승인 조건이 맞으면 리뷰 요약 끝에 확인 질문("…이 커밋을 승인할까요?")을 붙여 "응"만으로 승인까지 이어지게(답변 단계 규칙은 그대로 엄격) ② 본인 PR·권한 없음·초안·닫힘·병합·허용 저장소 밖·필수 검사 실패/진행 중이면 질문 없이 이유 한 문장 ③ Copilot 리뷰는 있을 때만 말함(없음·목록 못 읽음은 생략), 차단 수준 지적이 있으면 "그래도 …승인할까요?" ④ 변경 규모에 따른 질문은 나중에. 서버 기본 켜짐(`DESKPET_OFFER_APPROVAL_AFTER_REVIEW=off`로 끔), 라이브러리 기본 꺼짐 | 사용자 결정 2026-11-10 |
| D-42 | **웹 화면을 Harness 서버가 서빙 (2026-11-13 사용자 결정)**: Jetson에서 쓰기 위해 빌드한 웹(`apps/web/dist`)을 Harness 서버와 같은 주소·포트의 HTTP로 내보낸다(`HARNESS_WEB`, 기본 on / `HARNESS_WEB_DIR`, 상대경로는 app 폴더 기준). 이 서버가 내보낸 화면은 Origin이 같은 IP·localhost 주소면 `HARNESS_WS_ALLOWED_ORIGINS` 없이 WebSocket 접속을 받는다(도메인 이름은 DNS rebinding 때문에 제외 → 목록에 넣어야 함). HTTP 요청도 `HARNESS_WS_ALLOWED_CLIENTS` 규칙을 따른다. GET/HEAD만, root 밖 파일·심볼릭 링크 거부, 보안 헤더(CSP 등). 웹을 끄면 예전처럼 HTTP는 426. `pnpm web:dev`는 개발용으로 그대로 | 구현 2026-11-13 |
| D-43 | **LLM Wiki 경로 고정 (2026-11-13 사용자 결정)**: `DESKPET_WIKI_DIR` 기본값 `../knowledge`, 상대경로는 실행 위치가 아니라 **app 폴더 기준**으로 해석한다(`scripts/wikiPath.ts`, 서버·`pnpm wiki` 공통). 저장소들을 한 폴더에 나란히 받으면 기기마다 설정할 필요가 없다. 그 위치에 `wiki/`가 없으면 Wiki를 끄고 이유를 시작 화면에 표시, `off`로 끔 | 구현 2026-11-13 |
| D-44 | **쓰지 않는 명령 정리 (2026-11-13 사용자 결정)**: `pnpm demo`(파이프라인 흉내 G-01 데모, `demo/client.ts`) → `pnpm demo:adapter harness`로 대체, `pnpm eureka:fields`(Eureka 필드 조사 도구), `pnpm web:dev:lan`(D-42 웹 서빙으로 대체), POC 장애 주입 `--poc`·`DESKPET_POC_FAULTS`·`scripts/poc-faults.ts`·`docs/poc-d21-d27.md`(D-27), 효과 없던 `--allow-github-writes`·`--allow-eureka-writes` 안내, 쓰지 않던 `ConsoleOperatorConfirm`(`operatorGate.ts`, D-22), `.env`의 `DEMO_EUREKA_*` 삭제. 위 결정 표의 해당 항목은 기록으로 남긴다 | 구현 2026-11-13 |
| D-45 | **보기 전용 토큰 없이 웹 접속 (2026-11-14 사용자 결정)**: `HARNESS_WS_VIEWER_TOKEN`을 비우면 웹 화면(viewer 역할)은 토큰 없이 접속한다. 구독만 되고 실행 요청은 거부(forbidden). pipeline(실행)은 그대로 `HARNESS_WS_TOKEN` 필요. 접속 IP 허용 목록·Origin 검사는 그대로. Harness 서버가 내보낸 화면은 토큰 없이 바로 연결을 시도하고, 서버가 토큰을 요구하면 입력 화면으로 돌아간다. 다른 기기 접속(LAN)에서 토큰을 비우면 허용 IP 안의 누구나 작업 목록을 볼 수 있으므로 시작 화면에 경고. 공용 네트워크에서는 토큰을 넣는다 | 사용자 결정 2026-11-14 |
| D-46 | **`--web` (임시, 2026-11-14 사용자 결정)**: `pnpm start -- --web`(또는 `pnpm harness --web`)이면 서버가 뜬 뒤 이 기기의 기본 브라우저로 `http://127.0.0.1:<포트>/`를 연다(Windows `start`, macOS `open`, Linux `xdg-open`; 화면 없는 SSH에서는 `DISPLAY=:0`로 시도). 실패해도 서버는 그대로, 웹이 꺼졌거나 빌드가 없으면 열지 않고 안내 | 사용자 결정 2026-11-14 |
| D-47 | **웹 세션 기록 (2026-11-14 사용자 결정)**: 실행 요청(`harness.request`·`harness.resume`·`harness.run`·`eureka.execute`)이 끝나면 발화 문장·라우터 의도·결과 상태·사용자에게 전한 문장(고정 문구)·실행한 동작·오류 코드·처리 시간을 한 줄씩 남긴다. 세션 = 서버 한 번 실행. 토큰·facts 원문은 남기지 않음. `DESKPET_HISTORY_PATH`(기본: 저장소 옆 `history.jsonl`, 저장소가 메모리면 메모리만, `off`로 끔), 메모리에는 최근 1000건. 웹 '기록' 탭에서 세션별로 보고 검색·결과 필터·더 보기, 새 기록은 실시간으로 추가 (`history` / `history.appended` 프레임, viewer 가능). 실행 전에 거부된 형식 오류 요청은 남기지 않음 | 사용자 결정 2026-11-14 |
| D-48 | **웹 설정 (2026-11-14 사용자 결정)**: 연결(서버 주소·관리 토큰 — 관리 토큰은 sessionStorage, 보기 전용 토큰은 서버가 요구할 때 연결 화면에서만), 표시(완료·취소 작업 숨기기, 업데이트 뒤 자동 새로 고침 — localStorage), 서버 정보(버전·시작 시각·업데이트 상태·자동 재시작·기록 저장 방식) | 사용자 결정 2026-11-14 |
| D-49 | **새 버전 알림 (2026-11-14 사용자 결정)**: 서버가 `HARNESS_UPDATE_CHECK_MINUTES`(기본 30)분마다 app 폴더에서 `git fetch` → upstream보다 뒤처진 커밋 수·제목(최대 10개)을 `server.info`로 모든 웹 화면에 알림. 인증 창이 뜨지 않게 `GIT_TERMINAL_PROMPT=0`, 실패는 '확인 실패'로만 표시. 서버가 새 버전으로 다시 켜졌는데 화면이 옛 버전이면 새로 고침 안내 | 사용자 결정 2026-11-14 |
| D-50 | **웹 업데이트 버튼 (2026-11-14 사용자 결정 — 관리 토큰 입력 시)**: `HARNESS_WEB_ADMIN_TOKEN`(16자 이상·LAN 24자 이상, 다른 토큰과 다름)이 있고 웹 설정에 같은 값을 넣은 화면에서만 버튼이 보인다. 서버는 `admin` 프레임마다 토큰을 확인하고 5번 틀리면 연결을 닫는다. 순서: 처리 중 요청 없음 → 커밋 안 한 변경(추적 파일) 없음 → `git merge --ff-only`(갈라졌으면 안 함) → package.json·lock이 바뀌었으면 `pnpm install --frozen-lockfile` → `pnpm web:build` → 재시작. `pnpm start`는 감시 프로세스(`scripts/supervise.ts`)로 서버를 띄워 종료 코드 75면 새 코드로 다시 띄운다. `pnpm harness`로 켰으면 '다시 실행 필요'. 실패하면 단계·이전 커밋·출력 끝부분(인증 정보 가림)을 보여 주고 되돌리지는 않음 | 사용자 결정 2026-11-14 |
| D-51 | **웹 현황 (2026-11-14 사용자 결정)**: 작업 탭 위 '현재 업무' 카드와 아래 '리마인더·링크'. 서버 시작 때와 `DESKPET_OVERVIEW_MINUTES`(기본 10)분마다 Eureka 열린 업무·단계 기록의 PR 주소·PR 상태, GitHub 저장소의 열린 PR(최근 수정 순 20개, 리뷰 요청 여부)을 읽기만 해서 보낸다(`overview` 프레임, 웹의 새로 고침은 `overview.refresh` — 30초 안에 다시 누르면 건너뜀). 현재 업무는 진행 중 단계가 있는 업무 → 마감 가까운 순으로 자동 선택, 웹에서 바꾸면 그 브라우저에만 기억. 리마인더는 마감이 지났거나 `DESKPET_REMINDER_DAYS`(기본 7)일 안. 링크는 Eureka 내 업무 화면(`https://flow.eureka.codes/apps/process#/my-work`)과 승인 허용 저장소(D-52, 웹 설정) + 업무에 연결된 PR의 저장소. 허용 저장소 밖 PR은 뺀다. 한쪽이 실패해도 나머지는 보여 주고 이유를 붙인다. `DESKPET_OVERVIEW=off`로 끔 | 사용자 결정 2026-11-14 |
| D-52 | **웹 설정에서 승인 허용 저장소 관리 (2026-11-14 사용자 결정)**: 설정 탭 '승인 허용 저장소'에서 목록 보기·추가·빼기·저장을 사용자가 직접 한다(관리 토큰 없이, `settings.set` 프레임 — 보기 전용 연결도 가능). 저장하면 `settings.json`(기본: 저장소 옆, `DESKPET_SETTINGS_PATH`)에 남고 서버 전체(승인 확인·단계 기록 PR 후보·현황)가 바로 같은 목록을 쓴다. 파일이 없으면 `.env DESKPET_ALLOWED_REPOS`가 처음 값. 비어 있으면 제한 없음(D-36과 같음). 저장소가 메모리면 적용만 되고 서버를 끄면 .env 값으로 돌아감 | 사용자 결정 2026-11-14 |
| D-53 | **Eureka 업무 삭제 (2026-11-14 사용자 결정)**: 라우터 `delete` 라벨(`eureka.delete`)을 받는다. 업무를 이름·대상으로 찾고(완료된 업무 포함) "'X' 업무를 삭제할까요? 삭제하면 되돌릴 수 없어요."로 묻고, 승인(`mutationApproved`) 뒤 `DELETE /_api_/items/{id}` 1번. 다른 쓰기와 같이 기록 → DurableAck → 전송, 응답 유실이면 unknown(다시 보내지 않음, 목록에서 사라졌는지로 후보 확인). 2026-11-14 실제 Eureka에서 삭제 확인(FOR_DELETE) | 사용자 결정 2026-11-14 |
| D-54 | **Eureka 업무 보류·재개 (2026-11-14 사용자 결정)**: 라우터 `hold`·`resume` 라벨. 완료된 업무·이미 보류(보류)·보류 아님(재개)이면 보내지 않고 이유를 말한다. 확인 질문 → 승인 뒤 `PUT /_api_/items/{id}` `{status}` 1번(보류 `hold`, 재개는 시작한 단계가 있으면 `doing` 아니면 `todo`). 응답의 status가 보낸 값과 같을 때만 반영 확인, 아니면 결과 불명으로 두고 목록의 업무 상태로 후보 확인. 위키에는 '업무 정보 변경'으로만 있어 실제 시험 필요 | 사용자 결정 2026-11-14 |
| D-55 | **Eureka 단계 상태·우선순위·이름 변경 (2026-11-14 사용자 결정)**: 라우터 `start_stage`(→doing)·`reset_stage`(→todo)·`skip_stage`(→skip)·`update_stage`(task·note 헤드의 상태 낱말, 없으면 되묻기)는 `POST /_api_/stages/{id}/status`, `update_priority`(priority 헤드: 낮음·보통·높음·긴급)·`update_item`(task 헤드 = 새 이름)은 `PUT /_api_/items/{id}`. 단계 이름이 없으면 시작은 첫 대기 단계, 되돌리기는 진행 중 단계, 건너뛰기는 진행 중 → 첫 대기 단계. 이미 그 상태·같은 값·보류 중 업무면 보내지 않음. 모두 확인 질문 → 승인 뒤 1번, 응답 값이 보낸 값과 같을 때만 반영 확인. done 말고 다른 단계 상태를 Eureka가 받는지는 실제 시험 필요. 단계 추가·삭제·이동은 D-56 | 사용자 결정 2026-11-14 |
| D-56 | **Eureka 단계 추가·삭제·순서·단계 마감 (2026-11-14, Eureka 웹 '전체 단계 편집' 요청으로 API 확인)**: `PUT /_api_/items/{id}/stages` `{stages:[{id?, name, actorId, toolId, dueAt, guideText, isRequired}]}` — 단계 목록 전체, 배열 순서가 순서, id 없으면 새 단계, 빠진 단계는 삭제. 라우터 `add_stage`(name·task 헤드 = 이름, dueAt = 단계 마감, 끝에 붙임)·`delete_stage`(되돌릴 수 없다고 묻기, 마지막 단계는 안 지움)·`move_stage_up`/`down`, `postpone`에 실제 단계 이름이 있으면 그 단계 마감. 지금 목록의 값을 그대로 다시 보내고 바꿀 곳만 고치며, 단계 값을 다 읽지 못했으면 보내지 않음. 응답의 단계 이름 순서가 같을 때만 반영 확인. 현황 리마인더에 끝나지 않은 단계의 마감도 '단계 · 업무'로, 현재 업무 카드 단계에 D-day. `demo:seed --reminder`는 업무 1개에 단계 3개(마감 1·3·6일 뒤)를 넣고 템플릿 기본 단계를 지운다. `demo:adapter eureka … --item <번호>`로 같은 이름 업무를 번호로 고름 | 사용자 결정 2026-11-14 |
| D-33 | **라우터 헤드 의미 (wiki interface-contracts 2026-11-01)**: 새 형식(`modelIntention` 헤드가 있음)에서 `target` = 업무 이름 원문, `name` = 단계 이름 원문, `task` = 새 업무 이름·요약, `note` = 기록 내용. 업무는 `target`(또는 `resolvedTarget`)으로 찾고, 단계 기록 추가의 단계는 `name`, 등록할 업무 이름은 `task`(없으면 `target`)로 정한다. 업무 유형은 `EUREKA_DEFAULT_PROCESS_ID`만 쓴다. 구형 형식(`modelIntention` 없음)은 지금처럼 `name` = 업무 이름. 라우터 24개 라벨 중 아직 실행하지 않는 동작은 `EUREKA_OPERATION_NOT_IMPLEMENTED`(목록에 없는 값은 `POLICY_BLOCKED`) | 구현 2026-11-03 |
| D-32 | **wiki 정렬 (2026-11-03)**: ① 출력 감정은 `neutral`·`happy`·`sad`만 쓰고(모델이 다른 이름을 내면 정규화), 업무 결과는 `OutputContent.actionStatus`(마지막 쓰기 작업의 succeeded·failed·unknown, 조회만 했으면 없음)로 따로 준다. 결과가 있으면 감정을 결과에 맞춘다(성공 happy, 실패 sad, 미확인 neutral) — wiki deskpet-display-interface ② 실행된 검사가 없으면 "모든 검사가 통과"라고 하지 않는다 ③ 미지원 요청은 "실행하지 않음 → 지원 범위 → 대안" 순서로 답한다 — wiki deskpet-operation-policies §3 ④ EurekaBridge는 라우터 형식(intention=`eureka` + operation 24개 라벨)을 받는다. 지원: query(대상 있으면 상태, 없으면 목록)·create·complete·postpone·add_note(단계 기록 추가, 확인 후)·query_processes. 나머지 라벨은 실행하지 않고 무엇을 안 했는지·지원 범위를 말한다 — wiki small-router-model | 구현 2026-11-03 |
| D-31 | **Eureka 내부 API 분리**: `pnpm eureka:server`가 직접 Eureka 요청(`eureka.execute·reconcile·reminders·reminder·links`)만 별도 프로세스·포트(기본 8789)에서 받는다. 메시지 형식은 Harness 서버와 같아 파이프라인은 주소만 바꾼다. 작업 기록은 따로(`EUREKA_STORE_PATH`, Harness 저장소와 다른 파일). Harness 서버는 `DESKPET_EUREKA_BRIDGE=external`이면 `eureka.*`를 받지 않는다(기본 internal: 지금처럼 함께). G-01의 단계 완료는 계속 Harness가 직접 쓴다 — wiki deskpet-pipeline §4 | 구현 2026-11-03 |
| D-30 | **PR CI 검사 조회 생략**: 서버 기본 `DESKPET_PR_CHECKS=skip` — 리뷰·승인 전 확인에서 검사(check runs·필수 검사 설정)를 조회하지 않고 승인 조건에서도 뺀다. PR 상태·SHA·권한·본인 PR 조건은 그대로. `enforce`로 되돌린다(라이브러리 기본 enforce). Liability 문서의 승인 조건 1번(필수 검사 확인)과 다르다 → vault 반영 필요 | 사용자 결정 2026-11-03 (wiki deskpet-pipeline 10/27 요청) |
| D-28 | **완료 근거 기록**: Eureka 단계 완료가 성공하면 그 단계 기록(note)에 `[DeskPet 완료 근거] <PR 주소> 승인 후 단계 완료 (커밋 7자리, 리뷰 ID)`를 남긴다. API `POST /_api_/stages/{stageId}/note {content, actorId?}` (PDF에 없음, 2026-11-01 웹 요청으로 확인). 동의는 단계 완료 확인 질문에 함께 받는다("…완료로 반영하고, 승인한 PR 주소를 단계 기록에 추가할까요?"). 쓰기 전에 기록을 읽어 같은 PR·커밋 근거가 있으면 쓰지 않고, 기록을 못 읽으면 쓰지 않는다. 응답을 못 받으면 결과 미확인으로 두고 다시 보내지 않는다. 실패해도 단계 완료는 그대로. `EUREKA_EVIDENCE_NOTE=off`로 끄고, 작성자는 `EUREKA_NOTE_ACTOR_ID`(선택) | 사용자 요청 2026-11-01 |
| D-27 | POC 장애 주입: `--poc` + `DESKPET_POC_FAULTS`일 때만. `eureka_stage_slow`, `eureka_stage_fail_once`, `github_approve_drop_once`, `sensor_fail_once`. 운영 코드가 아닌 `scripts/poc-faults.ts`에서 fetch·센서를 감싼다. 시나리오는 `docs/poc-d21-d27.md` | 구현 2026-10-24 (D-44로 삭제) |
| D-26 | 단계별 응답 시간 기록 (NFR-01): 외부 호출(GitHub·Eureka·LLM Guide·Wiki)을 port 경계에서 재어 `HarnessResult.facts.timings` `{totalMs, stages:[{stage, ms, ok}]}`에 담는다. 파이프라인 형식은 `facts.timings`(JSON 문자열), 출력 모델은 `modelMs`. 서버 콘솔에 요청마다 `[timing]` 한 줄 (`DESKPET_TIMING_LOG=off`로 끔) | 구현 2026-10-24 |
| D-25 | 다른 기기 접속: 기본은 이 기기에서만. `HARNESS_WS_HOST`를 열 때는 `HARNESS_WS_ALLOWED_CLIENTS`(IP·CIDR) 필수, 토큰 24자 이상, 선택 TLS(`wss://`). loopback은 항상 허용. 연결 단계에서 주소를 거부한다 (`docs/remote-access.md`) | 사용자 요청 2026-10-24 (Jetson 시험) |
| D-24 | **자원별 동시 호출 상한**: LLM 2건(자리 대기 0.5초, 안 나면 호출 없이 규칙·고정 문구), GitHub·Eureka 각 4건(남은 시간 안에서 대기, 안 나면 `not_sent`). 서버 입구는 칸(work/eureka/control)으로 나누고 질문 전달 보고·취소·reconcile(control)은 다른 칸 상한과 별도. **복구 뒤 후속 질문**: 주기 복구로 GitHub 승인이 성공 확정되면 연결된 Eureka 단계 상태와 기록(note의 PR 주소)을 다시 보고 반영 가능할 때만 확인 질문을 notice에 실어 보낸다. 연결 단계·대화·문맥 ID는 승인 operation에 남겨 재시작 뒤에도 쓴다. 수치는 미정 | 사용자 결정 2026-10-24 |
| D-23 | **후속 작업 분리**: ① Eureka 반영은 동의 뒤 최대 3초만 기다리고, 늦으면 '진행 중'으로 답한 뒤 끝난 결과를 서버 notice로 알린다 ② 서버 안의 `RecoveryWorker`가 결과 불명·판정 대기 작업을 주기적으로(기본 30초, 작업별 간격 2배씩 최대 10분) 조회만 하고, 확정되면 notice. 상한에 닿으면 `blocked` ③ 명시적으로 실패한 Eureka 반영은 "다시 해줘"(`eureka.retry`) 발화 자체를 동의로 보고 새 작업으로 다시 보낸다. 결과 불명은 다시 보내지 않는다 | 사용자 결정 2026-10-24 |
| D-22 | 서버 콘솔 이중 확인(`yes`)을 없앤다. 쓰기 승인은 요청 쪽(파이프라인이 전달한 확인 질문과 사용자 답변, `mutationApproved`)에서만 받는다. 쓰기 옵션·전송 직전 상태 재확인·DurableAck는 그대로. `ConsoleOperatorConfirm` 코드는 남겨 두되 서버에서 쓰지 않는다 | 사용자 결정 2026-10-24 (피드백 반영) |
| D-21 | G-01 시작부의 업무 → PR 연결은 Eureka **단계 기록(note)**의 PR 주소로 한다. 기록이 붙은 단계가 승인 후 완료할 단계다. 서로 다른 후보가 둘 이상이면 추측하지 않는다 (`eureka.links`, pipeline-bridge P-19). 허용 저장소 목록은 D-36으로 추가, 작성자 제한은 나중에 | 사용자 결정 2026-10-24 |
| D-19 | LLM Wiki: `wiki/` + 프로젝트 README만 키워드·frontmatter로 검색. Guide 판단 참고와 **출력 모델의 배경 설명**에 쓰고(2026-10-12 갱신), LLM에는 발췌 3개·1,500자까지. 대상 특정·승인 근거로는 쓰지 않음 (`docs/llm-integration.md` L-10). `FileWikiReader` + Guide `search_wiki` 단계, `.env` `DESKPET_WIKI_DIR` | 사용자 결정 2026-10-12 / 구현 |

## 문서 충돌과 잠정 처리

| # | 내용 | 잠정 처리 |
| --- | --- | --- |
| C-01 | 지시서에 있는 `mermaid-diagram-ko.mmd`가 vault 루트에 없다 | PNG 두 장을 근거로 사용 |
| C-02 | Envelope: interface-contracts는 `parentId`·`conversationId`·`turnId`, message-contracts는 `causationId`로 통일하고 대화·턴 ID는 payload에 둔다 | message-contracts를 따른다 |
| C-03 | ActionResult.status: interface-contracts는 `needs_clarification` 포함, message-contracts는 pending으로 분리 | message-contracts를 따른다. 호환 매핑은 구현하지 않음 |
| C-04 | S-05는 거절 시 pending `cancelled`라 하나 pending 상태는 waiting/consumed/expired/revoked | pending=consumed, confirmation=rejected, operation 없음 |
| C-05 | S-04는 라우터 action confidence로도 차단, message-contracts는 RouteDecision confidence로 STT confidence 대체 금지 | 두 검사를 독립적으로 두고 둘 다 통과해야 승인 |
| C-06 | G-01 원문은 승인 후 Eureka 자동 반영, Liability는 별도 확인 요구 | Liability를 따른다 (2026-11-08 사용자 재확인: 승인 뒤 Eureka 반영은 별도 확인 질문) |
| C-07 | Eureka 직접 경로 메서드명: 지시서 `createItem`, 다이어그램 `registerItem` | 다이어그램을 따른다 |
| C-08 | 리마인더용 `description`(interface §9)이 Eureka PDF 응답 예시에는 없다 | optional로 정규화하고 `name`으로 대체하지 않음 (미정) |
| C-09 | golden-scenario P-04는 idempotency key를 가정하나 Eureka PDF에 멱등성 지원이 없다 | completeStage 응답 유실은 unknown. getChangeOutcome의 인과 연결은 inference |
| C-10 | 공식 GitHub MCP 승인 도구 응답은 성공 문구만 반환한다 | Fake transport에 MCP형/REST형 모드를 두고 MCP형은 unknown→reconcile |
| C-11 | message-contracts·guide-sensor의 위키링크 `deskpet_LLM_guide_Liability`가 실제 파일명과 다르다 | 2026-10-12 사용자 승인으로 vault 링크 수정 (담당 문서 3개에 MVP 구현 현황도 반영) |
| C-12 | LLM 호출 경로: OpenAI·Gemini 직접 호출 vs 손한솔 담당 원격 fallback API | 직접 어댑터로 개발. fallback은 어댑터 추가로 전환 (미정) |
| C-13 | 기술 스택 문서는 출력 체인을 LangChain으로 정함 | 기본 출력 경로는 공급자 중립 `LlmOutputModel`, LangChain은 `LLM_OUTPUT_CHAIN=langchain`(openai) 옵션 (보고) |
| C-14 | 기술 스택 문서의 보드 내 프로세스 통신 후보는 gRPC·ZeroMQ, 구현은 WebSocket | 변환 층을 전송과 분리. 파이프라인 담당자와 합의 필요 |
| C-15 | pipeline·interface-contracts 문서는 Harness가 `question` 문장과 `mutationApproved`로 승인을 주고받는다. message-contracts·Liability는 Harness가 완성 문장을 만들지 않고 pending·confirmation·전달 증거를 요구한다 | 경계 형식은 pipeline 문서를 따르고(`harness.run`), 문장은 고정 문구로 만들며, 승인은 `mutationApproved`와 Harness 검사·전달 증거를 모두 요구 (사용자 결정 2026-10-12) |

## 시나리오 커버리지 (fake Gateway, `tests/e2e`)

| 시나리오 | 테스트 | 검증 내용 |
| --- | --- | --- |
| G-01 | `g01.test.ts` | 리뷰 조회 → 승인 확인 → 승인 1회 → 후속 적합성 확인 → 별도 확인 → Eureka 단계 하나만 완료. operation·confirmation 분리, 웹 투영, 음성 실패 독립 |
| S-01 | `harness.test.ts` | 대상 미확정 → 필요한 슬롯만 재질문, GitHub 호출 0회, 같은 requestId로 이어짐 |
| S-04 | `scenarios.test.ts` | 낮은 STT 신뢰도 명령 → 재발화 요청. 확인 답변 신뢰도 확인 불가 → unclear → 새 확인 |
| S-05 | `scenarios.test.ts` | 거절 → 쓰기 0회, 늦은 승인 무효. Eureka 질문 거절은 GitHub 승인 보존 |
| S-06 | `scenarios.test.ts` | 읽기·승인 인증 오류 → failed, 자동 재시도 없음, Eureka 없음 |
| S-07 | `scenarios.test.ts` | 응답 유실 → unknown, 재전송 없음, 읽기 복구, 복구 상한 → blocked. MCP 성공 문구만 → unknown. 연결 거부 → 조건부 1회 재시도. 재시작 → unknown |
| S-08 | `scenarios.test.ts` | 리뷰 후 / 확인 후 / 승인 직후 / Eureka 동의 후 SHA 변경 각각 차단, 기존 승인 보존 |
| S-09 | `scenarios.test.ts` | GitHub 성공 유지, Eureka만 unknown |
| S-10 | `g01.test.ts`, `projector.test.ts` | 출력 채널 실패와 업무 결과 분리 |
| S-11 | `scenarios.test.ts`, `github.test.ts` | 병합된 PR 승인 차단 |

S-02(다중 후보), S-03(Copilot 리뷰 없음·오래됨), S-12(쓰다듬기)는 단위 수준으로만 다룬다. S-12는 Harness 범위 밖이다.

그 밖의 테스트

| 영역 | 테스트 |
| --- | --- |
| 영속 저장소 | `store.test.ts`(메모리·SQLite 두 경로), `durable.test.ts`(다시 열기, 기록 실패 되돌리기, 자식 프로세스 SIGKILL 후 복구), `retention.test.ts`(보존 정책, 400회 요청 시 크기 고정) |
| Sensor 오류 | `scenarios.test.ts` — 판정 대기(assessment=pending), 재전송 없는 재판정, 복구 담당 해제 |
| LLM | `llm.test.ts`(어댑터 공통 계약: scripted·OpenAI·Gemini, 호출 상한, 설정), `llmGuide.test.ts`(규칙 의도는 LLM 미호출, 쓰기 선택지 없음, 깨진 출력·장애 시 차단) |
| 서비스 경계 | `ws.test.ts` — 실제 localhost WebSocket: 인증·역할·Origin, Envelope 거부, 크기 상한, G-01 흐름, 끊김 후 같은 turnId 재전송(전송 1회), messageId 재전송, 취소, snapshot→이벤트 |
| 웹 화면 | `apps/web/test/model.test.ts` — 상태 매핑, 정렬, 검색·필터 |

테스트는 fake Gateway와 mock LLM으로 돌린다. 실제 연결 결과는 아래 "실제 연결 기록"과 `docs/connection-test-issues.md`를 본다.



## 미정 목록

- STT/라우터 confidence 임계값, confirmation 유효 기한, 질문 대기 정책 수치
- 자동 복구 주기·횟수 상한, 저장 용량·보존 기간 수치 (지금은 자리값)
- 에러 코드명(실제 API 응답을 본 뒤 동결), 직접 Eureka 경로의 행위별 사용자 확인 정책
- GitHub MCP 사용 여부 (지금은 REST), Eureka 응답 스키마 세부와 페이지네이션(limit=100 초과)
- 파이프라인 문서에 없는 경계 항목 P-01~P-18 (`docs/pipeline-bridge.md`)
- 파이프라인과의 transport (C-14), LLM 호출 경로·외부로 보내는 데이터 범위 (C-12), 출력 체인 (C-13)
- 라우터 intention 값 목록과 그중 LLM이 맡을 의도, 확인 답변 허용 단어
- 자원별 동시 호출 상한·입구 칸 상한 수치 (D-24, 지금은 자리값)
- 파이프라인 연결이 없을 때 생긴 notice 보관·재전송 (지금은 버리고 snapshot으로만 확인)
- PR 변경 내용(diff) 수집 범위와 상한 (지금은 파일·증감 줄 수만, `docs/audit-fixes.md`)

## 문서

- `docs/pipeline-handoff.md` — 파이프라인 연결 안내 (한 장)
- `docs/remote-access.md` — 다른 기기 접속, Jetson 준비

| 문서 | 내용 |
| --- | --- |
| `docs/pipeline-bridge.md` | 파이프라인 문서 형식(`harness.run`·`output.generate`·`eureka.*`) 연결, 문서에 없어 임시로 정한 P-01~P-18 |
| `docs/audit-fixes.md` | 2026-10-05 구현 감사 F-01~F-07 처리와 남은 결정 |
| `docs/connection-test-issues.md` | 실제 연결에서 나온 문제와 해결 (1~14) |
| `docs/llm-integration.md` | LLM 결정 L-01~L-09, 안전 경계, 어댑터 추가 방법 |
| `docs/persistent-store.md` | SQLite 저널, 재시작 복구, 보존 정책, `pnpm db` |
| `docs/ws-protocol.md` | WebSocket 프레임, 인증·역할, 끊김·재전송, 구독 |
| `docs/web-ui.md` | 웹 화면 구성과 디자인 규칙 적용 |
