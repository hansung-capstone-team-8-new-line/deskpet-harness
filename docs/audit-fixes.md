# 구현 감사 대응 (2026-10-05)

감사 문서 `2026-10-05-query-deskpet-harness-implementation-audit.md`의 F-01~F-07 처리 기록. 회귀 테스트는 대부분 `tests/e2e/auditFixes.test.ts`에 있다.

| # | 문제 (감사 재현) | 처리 | 시험 |
| --- | --- | --- | --- |
| F-01 | 다른 저장소 PR 999를 물은 문장 뒤 "네"로 저장된 범위가 승인됨 | 확인 질문의 `question_delivered`는 `deliveredText` 필수. 코드가 만든 범위 문구(저장소·PR·커밋·행위)가 그대로 있고 다른 저장소·PR·커밋이 없을 때만 전달로 인정. 저장소도 답변 수락 시 다시 확인 (`contracts/confirmation.ts`) | `auditFixes` F-01 4건, `store.test` 1건 |
| F-02 | `Other/Repo PR 42번` 문장이 검증 통과, unknown 결과에 "성공적으로 끝났어요" 통과 | requiredMeaning = 고정 범위 문구. 모델 문장에 요청 사실 밖의 저장소·PR 번호·커밋이 있으면 거부. 성공하지 않은 쓰기 결과·판정 대기는 모델을 쓰지 않고 고정 상태 문장만 | `output.test` |
| F-03 | 운영자 yes를 ack 뒤에 기다림, 시간 제한·재확인 없음 | `GitHubReviewGateway.operatorConfirm`: 사전 확인 → 운영자 확인(ack 전, deadline·60초 상한) → 사전 확인 다시 → ack → 전송. 거절 `CANCELLED`, 시간 초과 `DEADLINE_EXCEEDED` (둘 다 not_sent) | `auditFixes` F-03 5건 |
| F-04 | 메모리 저장소로도 쓰기 모드 시작, 단일 기록자 강제 없음 | `--allow-github-writes`는 `DESKPET_STORE_PATH` 필수. SQLite 파일에 `<DB>.lock` (끝난 프로세스 잠금만 넘겨받음) | `durable.test` 3건, 실행 확인 |
| F-05 | 기한 지난 봉투·봉투/payload requestId 불일치가 실행됨 | `parseEnvelope`가 요청 ID 일치 검사. 서버가 봉투 deadline 지난 요청을 `deadline_exceeded`로 거부(재전달 응답 제외), 실행 deadline = min(봉투, payload) | `ws.test` 2건, `contracts.test` 2건 |
| F-06 | 변경 내용·코드 줄 지적 미수집 | 코드 줄 지적(`/pulls/{n}/comments`)을 모아 리뷰에 붙임. 리뷰 본문은 요약으로 표시하고 지적 수에서 뺌. `detailCoverage`로 세부 수집 범위를 목록 완전성과 따로 표시. 변경 내용(diff)은 `patches: not_collected`로 명시 | `restGithub.test` 4건 (현재/이전/없음/조회 실패) |
| F-07 | 요청 메타·출력 피드가 계속 늘어남, 전역 상한 없음 | 끝난 요청 메타 즉시 삭제(최대 500), 출력 피드는 같은 상태면 revision 증가 없음·끝난 채널 되돌림 금지·전역 단조 revision·최근 500개. 서버 전체 동시 요청 32, 구독 대기 이벤트 1,000 | `auditFixes` F-07, `projector.test` 3건, `ws.test` 1건 |

## 남은 결정

- **F-06 변경 내용 범위**: 지금은 파일·증감 줄 수만 모으고 diff는 모으지 않는다. 골든 시나리오 출력 예시도 파일 수·줄 수만 말한다. 코드 내용을 요약해 읽어 주려면 diff 수집 상한(파일 수·바이트)과 LLM에 보낼 범위(C-12)를 먼저 정해야 한다.
- 실제 Copilot 리뷰 응답으로 코드 줄 지적의 `line`·`severity` 모양 확인 (REST 응답에는 severity가 없다. 지금 차단 수준 건수는 fixture에서만 0이 아니다).
- 파이프라인이 `deliveredText`로 무엇을 보낼지 (음성으로 실제 재생한 문장 vs 화면 문장). 지금은 음성 문장(`OutputContent.text`) 기준.
