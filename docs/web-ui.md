# 웹 화면 (M8, 보기 전용)

> 간단한 첫 버전. Harness 서버에 **viewer**로 구독해 작업과 확인 질문을 보여 준다. 승인·재실행 같은 변경 기능은 없다 (현재 계약에 없음).

## 기술

`apps/web` — Vite + React + TypeScript + Tailwind CSS v4 + shadcn/ui 컴포넌트(Button, Badge, Input, Table, Select, Collapsible; Radix 기반 소스를 `src/components/ui`에 둠). 기존에 정해진 프론트엔드 기술은 없었다 (기술 스택 문서: "웹 구현 스택을 결정하지 않는다").

상태 계산은 기존 `RequestStateProjector`를 그대로 쓴다 (snapshot + 더 높은 revision만 적용, 불완전 동기화 표시).

## 디자인 규칙 적용

| 규칙 | 적용 |
| --- | --- |
| 흰색·회색, 파랑은 주요 조작만 | 배경·표·배지는 회색 계열. 파랑은 `연결`, `지금 다시 연결` 버튼과 포커스 표시에만 |
| 장식 이모지·불필요한 아이콘 없음 | 아이콘은 검색, 닫기, 펼치기/접기, 선택 목록 화살표·체크만 |
| 작업 목록 + 상세 중심 | Tasks 예제처럼 검색 + 상태 필터 + 표, 오른쪽에 선택한 행의 상세. 통계 카드·차트·배너 없음 |
| 그라데이션·유리·큰 그림자·반복 애니메이션 없음 | 테두리와 옅은 배경만 |
| 상태는 텍스트로 | 확인 대기 / 진행 중 / 판정 대기 / 결과 불명 / 실패 / 완료 / 취소됨 라벨 + 보조 설명(결과 확인 필요 등) |
| 연결 끊김·불완전 동기화 표시 | 헤더 상태 문구 + 알림 영역 ("마지막으로 받은 상태", 재연결까지 남은 초, 사유) |
| 상세 오류·기술 기록은 펼쳐서 | "오류 자세히 보기", "기술 기록 보기"(원본 JSON) |
| 키보드·포커스·대비 | 행 Tab 이동 + Enter/Space 선택, Esc로 상세 닫기, 모든 조작 요소에 포커스 링, 회색 글자도 충분한 대비 |

## 실행

### Harness 서버가 화면도 내보내기 (기본, D-42 — Jetson용)

```
pnpm start          # = pnpm web:build + pnpm harness (옵션도 그대로: pnpm start --read-only)
```

- 브라우저에서 `http://<Harness 주소>:8787` → 서버 주소 칸은 자동으로 같은 주소(`ws://…:8787`), **보기 전용 토큰**만 넣고 연결.
- 이 서버가 내보낸 화면은 `HARNESS_WS_ALLOWED_ORIGINS`에 넣지 않아도 된다 (Origin이 같은 IP·localhost 주소일 때). `jetson.local`처럼 **도메인 이름**으로 열면 그 Origin(`http://jetson.local:8787`)을 목록에 넣어야 한다.
- 다른 기기 브라우저에서 열 때는 그 기기 IP가 `HARNESS_WS_ALLOWED_CLIENTS`에 있어야 한다 (HTTP·WebSocket 같은 규칙, `remote-access.md`).
- 화면 코드를 바꾸면 `pnpm web:build` 후 브라우저 새로고침 (서버 재시작 불필요. `index.html`은 캐시하지 않음).
- 끄기: `.env` `HARNESS_WEB=off`. 다른 폴더의 빌드: `HARNESS_WEB_DIR` (상대경로는 app 폴더 기준).
- 시작 화면 줄: `웹 화면 서빙: http://…:8787` / 빌드가 없으면 `빌드 없음 → pnpm web:build` (그 상태로 열면 503 안내).

### 개발 서버로 따로 띄우기

```
# .env
HARNESS_WS_VIEWER_TOKEN=<16자 이상, HARNESS_WS_TOKEN과 다른 값>
HARNESS_WS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173

pnpm harness        # 터미널 1
pnpm web:dev        # 터미널 2 → http://127.0.0.1:5173 에서 서버 주소와 보기 전용 토큰 입력
```

- 브라우저에는 **보기 전용 토큰만** 넣는다. 서버는 이 토큰으로 pipeline 역할을 요청하면 거부한다 (4001).
- 토큰은 sessionStorage에만 두며 탭을 닫으면 지워진다.
- 실제 API 없이 화면만 보려면: `pnpm web:fixture` (ws://127.0.0.1:8788, 토큰 `fixture-viewer-token-123`) + `pnpm web:dev`.

### 실제 서버에 붙이기 (2026-10-24)

1. `.env`에 `HARNESS_WS_VIEWER_TOKEN`(16자 이상, `HARNESS_WS_TOKEN`과 다른 값)과 `HARNESS_WS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173`을 넣는다.
2. `pnpm harness` — 시작 화면에 `웹 화면: 보기 전용 토큰 설정됨, 허용 Origin …`이 보여야 한다. `꺼짐`이면 1을 확인한다.
3. `pnpm web:dev` → 브라우저에서 `http://127.0.0.1:5173` (주소창 Origin이 허용 목록과 같아야 한다. `localhost`로 열면 `http://localhost:5173`이 목록에 있어야 함).
4. 서버 주소 `ws://127.0.0.1:8787`, 토큰 칸에 **보기 전용 토큰**을 넣고 연결.
5. 다른 터미널에서 `pnpm demo …`를 돌리면 작업이 실시간으로 추가·갱신된다.

| 증상 | 원인 |
| --- | --- |
| 연결 직후 끊김(4001) | 토큰이 틀렸거나 pipeline 토큰을 넣음 |
| 연결 자체가 거부(403) | 브라우저 Origin이 `HARNESS_WS_ALLOWED_ORIGINS`에 없음 |
| 목록이 비어 있음 | 저장소가 메모리(`DESKPET_STORE_PATH` 없음)이고 서버를 다시 켰음 |

## 검증

- `apps/web/test/model.test.ts`: 원본 상태 → 표시 상태 매핑, 닫힌 질문 제외, 정렬, 검색·필터.
- fixture 서버 + 브라우저(Chromium)로 연결, 목록, 키보드 선택, 오류 펼침, 상태 필터, 서버 종료 시 연결 끊김 알림을 확인했다.
- 2026-11-13: `scripts/server.ts`가 빌드한 화면을 8787에서 내보내고, Chromium으로 열어 Origin 설정 없이 보기 전용 토큰으로 연결되는 것을 확인 (CSP 위반·콘솔 오류 없음). 자동 테스트: `tests/e2e/webServing.test.ts`.
- 2026-10-24: **실제 서버 스크립트(`scripts/server.ts`)** + `pnpm web:dev` + Chromium으로 보기 전용 토큰 연결, `pnpm demo:adapter harness`가 만든 작업이 실시간으로 목록에 나타나는 것을 확인했다 (GitHub·Eureka 키는 가짜 값이라 작업은 '실패'로 표시됨).
