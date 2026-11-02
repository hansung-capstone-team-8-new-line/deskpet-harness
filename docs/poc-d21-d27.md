# POC: Eureka 연결·후속 작업·동시 호출 상한 (D-21~D-27)

실제 GitHub·Eureka(flw-d1)에 붙여 확인한다. 드문 실패는 POC 장애 주입(D-27, `scripts/poc-faults.ts`)으로 만든다.
결과는 아래 표의 **실제 결과** 칸에 적고, vault `deskpet-poc-validation.md` §4 양식(날짜·보드·버전·결과·재현 방법)으로 옮긴다.

## 준비

- 부계정이 연 **열린 PR** 하나 (같은 커밋을 이미 승인했으면 새 커밋 push)
- Eureka 시험 업무 하나. 완료할 단계의 **기록**에 `PR: https://github.com/<owner>/<repo>/pull/<번호>` (앞 단계는 완료 상태)
- `.env`: `DESKPET_STORE_PATH` (영속 저장소), 아래 시나리오별 `DESKPET_POC_FAULTS`
- 터미널 3개: ① `pnpm harness --allow-github-writes --allow-eureka-writes [--poc]` ② `pnpm demo --item <업무>` ③ `pnpm web:dev` (화면 확인)
- 서버 콘솔의 `[timing]` 줄(D-26)을 결과에 같이 남긴다

## 시나리오

| # | 확인 | `DESKPET_POC_FAULTS` | 순서 | 통과 기준 | 실제 결과 |
| --- | --- | --- | --- | --- | --- |
| 1 | 기록 → PR 연결 (D-21) | (없음) | `pnpm demo --item <업무>` → 리뷰 → 승인 → Eureka "네" | 0단계에 `linked`, 승인 1회, 기록이 붙은 단계만 done | 2026-10-24 확인 ✓ |
| 2 | 늦은 반영 → 알림 (D-23) | `eureka_stage_slow` (`DESKPET_POC_SLOW_MS=5000`) | 1과 같게, Eureka "네" | 3초 뒤 "반영을 진행하고 있어요", 이어서 🔔 알림 "완료로 반영했어요". Eureka 반영 1회 | |
| 3 | 실패 → 다시 하기 (D-23) | `eureka_stage_fail_once` | Eureka "네" → 실패 안내 확인 → `pnpm demo --ask "Eureka 다시 반영해줘" --intent eureka.retry` | 첫 응답 "다시 반영해줘라고 하시면…", 다시 하기 뒤 done. GitHub 승인은 1회 | |
| 4 | 응답 유실 → 조회만 (S-07) | `github_approve_drop_once` | 승인 "응" → 결과 불명 확인 → 서버를 그대로 두고 몇 분 관찰 (`RECOVERY_INTERVAL_MS`를 10000으로 줄이면 빠름) | 승인 결과 `unknown`, 서버 `[recovery]`가 조회만 반복하다 `blocked`. **GitHub 화면의 승인은 1개뿐** | |
| 5 | 복구 뒤 후속 질문 (D-24) | `sensor_fail_once` | 승인 "응" → "판정을 끝내지 못했어요" → 다음 복구 tick | 🔔 알림에 "Eureka의 '…' 단계를 완료로 반영할까요?" (데모는 알림만 출력. 답은 adapter로: `pnpm demo:adapter harness --item <업무>`로 새 흐름 or 다음 단계에서) | |
| 6 | 5의 변형: 기록 지움 | `sensor_fail_once` | 5와 같되 복구 전에 Eureka 기록의 PR 주소를 지움 | 질문 없이 "Eureka 반영은 보류했어요" (`eureka_note_link_removed`) | |
| 7 | 단계별 시간 (D-26) | (없음) | 1을 5회 반복 | `[timing]` 줄에서 github·eureka·llm 단계별 ms 기록. p50/p95 정리 | |
| 8 | 다른 기기 접속 (D-25) | (없음) | `docs/remote-access.md` 구성 B (서버 노트북, 데모 Jetson) | Jetson에서 `pnpm demo:adapter links <업무>` 성공. 허용하지 않은 기기는 거부 로그 | |

5번 참고: `pnpm demo`는 알림을 출력만 한다. 알림의 질문에 답하는 흐름은 파이프라인 연결 후 확인하는 게 자연스럽다 (P-21). POC에서는 알림에 질문이 실렸는지, Eureka 단계·기록 확인 결과가 맞는지까지 본다.

## 기록 양식 (시나리오마다)

```text
POC ID / 날짜 / 실행 기기(노트북·Jetson)
app commit:
DESKPET_POC_FAULTS / 기타 설정:
입력 (PR, Eureka 업무·단계):
기대 / 실제:
[timing] 줄:
GitHub·Eureka 화면 확인:
통과 / 조건부 / 미통과, 다음 조치:
```
