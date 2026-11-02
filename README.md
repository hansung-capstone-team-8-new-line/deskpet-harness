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
demo/          파이프라인 흉내 WebSocket 클라이언트 — 파이프라인 연결 후 폴더째 삭제 가능
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
pnpm demo 12             # 터미널 2: 데모 클라이언트로 G-01 흐름
pnpm web:dev             # 터미널 3: 웹 화면 http://127.0.0.1:5173 (보기 전용 토큰 입력)
```

## 명령

| 명령 | 내용 |
| --- | --- |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm check` | vitest / tsc(패키지 + 웹) / eslint / 셋 다 |
| `pnpm smoke [eureka\|github\|llm]` | 연결 테스트. Eureka·GitHub는 읽기만, llm은 작은 호출 2번 |
| `pnpm harness [--allow-github-writes]` | Harness 서버. 시작 시 보존 정리·결과 불명 쓰기 읽기 확인, Ctrl+C 시 처리 중 요청을 마치고 종료 |
| `pnpm demo:adapter [--fixture] <명령>` | 파이프라인 문서 형식(adapter) 시험 클라이언트: `reminders`, `reminder <itemId>`, `eureka list`, `eureka status "업무"`, `eureka postpone "업무" <ISO+09:00> [--approve]`, `links <itemId>`, `harness [PR] [--item <itemId>]`. `--fixture`는 `pnpm web:fixture` 서버(가짜 GitHub·Eureka)에 붙음 |
| `pnpm demo --ask "Eureka 다시 반영해줘" --intent eureka.retry` | 실패한 Eureka 반영 다시 하기 (D-23) |
| `pnpm demo --item <itemId>` | 데모를 Eureka 업무에서 시작: 단계 기록의 PR 주소로 대상 PR과 완료할 단계를 찾는다 (`.env` `DEMO_EUREKA_*`·PR 번호 불필요) |
| `pnpm eureka:fields [itemId] [--objects] [--notes]` | Eureka 응답 필드 확인 (읽기 전용, flw-d1만). `--notes`는 단계 기록 본문 조회 |
| `pnpm wiki "질의" [--dir <vault>]` | LLM Wiki 검색 확인 (읽기 전용). Guide에 넘길 발췌·출처를 그대로 보여 줌 |
| `pnpm demo [PR] [--answer "…"] [--ask "…" --intent …]` | 데모 클라이언트 (서버가 켜져 있어야 함) |
| `pnpm db [ops\|op <id>\|pending\|dedup\|turns\|raw …]` | 저장소 조회 (읽기 전용, 기록을 바꾸지 않음) |
| `pnpm web:dev` / `pnpm web:build` | 웹 화면 개발 서버 / 빌드 |
| `pnpm web:dev:lan` | 웹 화면을 다른 기기 브라우저에서 열 때 (Vite를 0.0.0.0으로, D-25) |
| `pnpm web:fixture` | 실제 API 없이 여러 상태를 만든 fixture 서버 (웹 화면 확인용) |

`pnpm server`, `pnpm store`는 pnpm 자체 명령과 이름이 겹쳐 쓰지 않는다.

## 환경 변수 (`.env`, 자세한 설명은 `.env.example`)

| 묶음 | 변수 |
| --- | --- |
| Eureka | `EUREKA_API_KEY`, `EUREKA_BASE_URL`(기본 개발 환경 flw-d1), `EUREKA_TEST_ITEM_ID` |
| GitHub | `GITHUB_TOKEN`, `GITHUB_TEST_REPO`, `GITHUB_TEST_PR`, `DESKPET_REQUIRED_CHECKS` |
| 데모 | `DEMO_EUREKA_ITEM_ID`, `DEMO_EUREKA_STAGE_ID`, `HARNESS_WS_URL` |
| 저장소 | `DESKPET_STORE_PATH` (예: `.deskpet/harness.db`, 비우면 메모리) |
| LLM | `LLM_PROVIDER`(off·gemini·openai), `GEMINI_API_KEY`, `GEMINI_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `LLM_*` 상한 |
| 서버 | `HARNESS_WS_TOKEN`(실행용), `HARNESS_WS_VIEWER_TOKEN`(웹 화면용), `HARNESS_WS_HOST`/`PORT`, `HARNESS_WS_ALLOWED_ORIGINS` |

비밀값은 `.env`에만 두고(`.gitignore` 대상) 코드는 키를 로그·기록·오류 메시지에 넣지 않는다. 브라우저에는 보기 전용 토큰만 넣는다.

## 쓰기 안전장치

- 기본은 모든 쓰기 비활성. 승인 단계는 "쓰기가 꺼져 있어서 보내지 않았어요"로 끝나고 DurableAck도 요청하지 않는다.
- `pnpm harness --allow-github-writes`일 때만 GitHub 승인을 보낼 수 있다. 승인은 **요청 쪽 사용자 확인**(확인 질문 전달 + 승인 답변)만으로 받는다. 서버 콘솔 `yes` 확인은 없앴다 (D-22).
  - 쓰기 모드는 `DESKPET_STORE_PATH`(영속 저장소)가 있어야 시작하고, 같은 DB는 한 프로세스만 연다 (`<DB>.lock`).
  - 보내기 직전 Gateway가 PR 상태·head SHA·권한·필수 검사를 다시 확인하고, 어긋나면 보내지 않는다.
- 확인 질문의 답은 **실제로 전달한 문장**이 저장된 범위(저장소·PR·커밋·행위)와 맞을 때만 받는다. 출력 모델은 이 범위 문구를 바꿀 수 없고, 성공하지 않은 쓰기 결과는 모델 문장 없이 고정 문장으로만 알린다.
- 봉투 deadline이 지났거나 봉투·payload의 요청 ID가 다르면 실행하지 않는다.
- Eureka 쓰기는 `pnpm harness --allow-eureka-writes`일 때만, 개발 환경(flw-d1)에서만 보낼 수 있다 (D-20). 보내기 직전 단계 상태(이미 완료·보류)를 다시 확인한다.
- 본인이 연 PR은 GitHub 규칙상 승인할 수 없어 확인 질문 전에 막힌다.

## 실제 연결 기록

| 대상 | 결과 |
| --- | --- |
| GitHub | 테스트 저장소에서 리뷰 조회·필수 검사(rulesets/classic + DeskPet 대체 목록)·중복 실행 제거 확인. PR #11(다른 계정 작성)에 실제 승인 성공 (review 5410644915). 승인은 merge가 아니다 |
| Eureka | 개발 환경 읽기 확인 (키 역할 guest, description 필드 없음). 2026-10-12 flw-d1 실제 쓰기 성공: PR #15 승인 뒤 G-01 후속으로 item 1000020의 stage 1000195를 `done`으로 반영 (`--allow-eureka-writes`, 콘솔 yes 2회). Eureka 화면에서도 완료 확인 |
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
| D-18 | GitHub 쓰기는 서버 실행 옵션 `--allow-github-writes`일 때만. (콘솔 `yes` 확인은 D-22로 없앰) | 사용자 결정 2026-10-05, 2026-10-24 갱신 |
| D-20 | Eureka 쓰기는 `--allow-eureka-writes`일 때만, **개발 환경(flw-d1)에서만**. 영속 저장소 필수. (콘솔 `yes` 확인은 D-22로 없앰) | 사용자 결정 2026-10-12 (실제 시험 허락) |
| D-27 | POC 장애 주입: `--poc` + `DESKPET_POC_FAULTS` + flw-d1일 때만. `eureka_stage_slow`, `eureka_stage_fail_once`, `github_approve_drop_once`, `sensor_fail_once`. 운영 코드가 아닌 `scripts/poc-faults.ts`에서 fetch·센서를 감싼다. 시나리오는 `docs/poc-d21-d27.md` | 구현 2026-10-24 |
| D-26 | 단계별 응답 시간 기록 (NFR-01): 외부 호출(GitHub·Eureka·LLM Guide·Wiki)을 port 경계에서 재어 `HarnessResult.facts.timings` `{totalMs, stages:[{stage, ms, ok}]}`에 담는다. 파이프라인 형식은 `facts.timings`(JSON 문자열), 출력 모델은 `modelMs`. 서버 콘솔에 요청마다 `[timing]` 한 줄 (`DESKPET_TIMING_LOG=off`로 끔) | 구현 2026-10-24 |
| D-25 | 다른 기기 접속: 기본은 이 기기에서만. `HARNESS_WS_HOST`를 열 때는 `HARNESS_WS_ALLOWED_CLIENTS`(IP·CIDR) 필수, 토큰 24자 이상, 선택 TLS(`wss://`). loopback은 항상 허용. 연결 단계에서 주소를 거부한다 (`docs/remote-access.md`) | 사용자 요청 2026-10-24 (Jetson 시험) |
| D-24 | **자원별 동시 호출 상한**: LLM 2건(자리 대기 0.5초, 안 나면 호출 없이 규칙·고정 문구), GitHub·Eureka 각 4건(남은 시간 안에서 대기, 안 나면 `not_sent`). 서버 입구는 칸(work/eureka/control)으로 나누고 질문 전달 보고·취소·reconcile(control)은 다른 칸 상한과 별도. **복구 뒤 후속 질문**: 주기 복구로 GitHub 승인이 성공 확정되면 연결된 Eureka 단계 상태와 기록(note의 PR 주소)을 다시 보고 반영 가능할 때만 확인 질문을 notice에 실어 보낸다. 연결 단계·대화·문맥 ID는 승인 operation에 남겨 재시작 뒤에도 쓴다. 수치는 미정 | 사용자 결정 2026-10-24 |
| D-23 | **후속 작업 분리**: ① Eureka 반영은 동의 뒤 최대 3초만 기다리고, 늦으면 '진행 중'으로 답한 뒤 끝난 결과를 서버 notice로 알린다 ② 서버 안의 `RecoveryWorker`가 결과 불명·판정 대기 작업을 주기적으로(기본 30초, 작업별 간격 2배씩 최대 10분) 조회만 하고, 확정되면 notice. 상한에 닿으면 `blocked` ③ 명시적으로 실패한 Eureka 반영은 "다시 해줘"(`eureka.retry`) 발화 자체를 동의로 보고 새 작업으로 다시 보낸다. 결과 불명은 다시 보내지 않는다 | 사용자 결정 2026-10-24 |
| D-22 | 서버 콘솔 이중 확인(`yes`)을 없앤다. 쓰기 승인은 요청 쪽(파이프라인이 전달한 확인 질문과 사용자 답변, `mutationApproved`)에서만 받는다. 쓰기 옵션·flw-d1 제한·전송 직전 상태 재확인·DurableAck는 그대로. `ConsoleOperatorConfirm` 코드는 남겨 두되 서버에서 쓰지 않는다 | 사용자 결정 2026-10-24 (피드백 반영) |
| D-21 | G-01 시작부의 업무 → PR 연결은 Eureka **단계 기록(note)**의 PR 주소로 한다. 기록이 붙은 단계가 승인 후 완료할 단계다. 서로 다른 후보가 둘 이상이면 추측하지 않는다 (`eureka.links`, pipeline-bridge P-19). 허용 저장소 목록·작성자 제한은 나중에 추가 | 사용자 결정 2026-10-24 |
| D-19 | LLM Wiki: `wiki/` + 프로젝트 README만 키워드·frontmatter로 검색. Guide 판단 참고와 **출력 모델의 배경 설명**에 쓰고(2026-10-12 갱신), LLM에는 발췌 3개·1,500자까지. 대상 특정·승인 근거로는 쓰지 않음 (`docs/llm-integration.md` L-10). `FileWikiReader` + Guide `search_wiki` 단계, `.env` `DESKPET_WIKI_DIR` | 사용자 결정 2026-10-12 / 구현 |

## 문서 충돌과 잠정 처리

| # | 내용 | 잠정 처리 |
| --- | --- | --- |
| C-01 | 지시서에 있는 `mermaid-diagram-ko.mmd`가 vault 루트에 없다 | PNG 두 장을 근거로 사용 |
| C-02 | Envelope: interface-contracts는 `parentId`·`conversationId`·`turnId`, message-contracts는 `causationId`로 통일하고 대화·턴 ID는 payload에 둔다 | message-contracts를 따른다 |
| C-03 | ActionResult.status: interface-contracts는 `needs_clarification` 포함, message-contracts는 pending으로 분리 | message-contracts를 따른다. 호환 매핑은 구현하지 않음 |
| C-04 | S-05는 거절 시 pending `cancelled`라 하나 pending 상태는 waiting/consumed/expired/revoked | pending=consumed, confirmation=rejected, operation 없음 |
| C-05 | S-04는 라우터 action confidence로도 차단, message-contracts는 RouteDecision confidence로 STT confidence 대체 금지 | 두 검사를 독립적으로 두고 둘 다 통과해야 승인 |
| C-06 | G-01 원문은 승인 후 Eureka 자동 반영, Liability는 별도 확인 요구 | Liability를 따른다 |
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
- `docs/poc-d21-d27.md` — POC 시나리오와 기록 양식
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
