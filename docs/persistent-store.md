# 영속 저장소 (SQLite 저널)

> README D-02의 상세.

## 구조

| 위치 | 역할 |
| --- | --- |
| `packages/harness/src/store/InMemoryOperationStore.ts` | 판단 로직(예약·ack·확인 커밋·복구·보존). 변경 메서드는 `tx()`로 감싼다 |
| `packages/harness/src/store/persistence.ts` | `StorePersistence` 인터페이스, `NoopPersistence`(메모리 전용), `StoreStorageError` |
| `packages/harness/src/store/SqlitePersistence.ts` | Node 내장 `node:sqlite` 기반 저널. WAL + `synchronous=FULL` |

- 각 변경 메서드의 동기 본문이 끝나면 바뀐 레코드만 한 SQLite 트랜잭션으로 기록한다. 기록이 끝나야 메서드가 결과를 돌려준다.
- 기록에 실패하면 메모리도 마지막 기록 상태로 되돌리고, 변경 알림(projector 입력)을 보내지 않는다.
- 검사 오류로 메서드가 중간에 던져도 일부만 바뀐 상태가 남지 않는다 (메모리 전용에서도 동일).
- 레코드 종류: operation, pending, confirmation, 최소 중복 방지 기록, 확인→operation 축약 색인, 턴 결과, 파이프라인 순서, 축약 횟수.

## 안전 경계와의 관계 (Liability, message-contracts §Operation Record)

| 계약 | 구현 |
| --- | --- |
| 전송 가능 기록(`may_have_been_sent`)을 영속 저장한 뒤에만 전송 | `persistMayHaveBeenSent`는 SQLite 커밋 성공 뒤에만 ack. 실패하면 `storage_error` → Gateway 전송 안 함 |
| 예약·필수 저장 실패는 전송 차단 | `reserveAndPrepare` 기록 실패 → 실행 전 차단, operation 남지 않음 |
| 재시작 후 결과 불명은 `unknown` + 복구, 재전송 금지 | `openDurable` → `recoverAfterRestart()`: ack 뒤 죽었으면 unknown·recovery=needed, ack 전이면 failed·not_sent(증거 `restart_before_durable_ack`) |
| 전송 후 기록 장애는 외부 실패가 아님 | `appendEvidence` 실패는 `StoreStorageError`로 올라가고 ActionResult를 만들지 않는다. 디스크에는 ack 기록이 남아 재시작 시 unknown으로 복구 |

## 사용

```ts
const store = InMemoryOperationStore.openDurable('.deskpet/harness.db', { clock, ids: randomIdGen, ...limits });
// ...
store.close();
```

- 데모: `.env`에 `DESKPET_STORE_PATH=.deskpet/harness.db` → `pnpm demo ...`. 시작할 때 결과 확인이 필요한 쓰기를 읽기로만 확인한다.
- `.deskpet/`, `*.db*`는 `.gitignore` 대상.

### 저장된 값 조회 (`pnpm db`, 읽기 전용)

DB를 readOnly로 열고 재시작 복구도 하지 않으므로 기록을 바꾸지 않는다. 경로는 `.env`의 `DESKPET_STORE_PATH` 또는 `--db <경로>`.

```
pnpm db                    # 요약: 종류별 건수 + 확인이 필요한 operation(결과 불명·복구 필요·판정 대기·실행 권한 남음)
pnpm db ops                # operation 목록 (최근 변경 순)
pnpm db op <operationId>   # operation 하나 전체 JSON (축약됐으면 최소 기록)
pnpm db pending            # pending·confirmation
pnpm db dedup              # 축약된 최소 중복 방지 기록
pnpm db turns              # 턴 결과
pnpm db raw <종류> <키>     # 레코드 원문 (op|pending|conf|dedup|dedupConf|turn|pipe|meta)
```

- `pnpm store`는 pnpm 자체 명령이라 이름을 `db`로 했다.
- Harness가 꺼져 있을 때 보이는 값은 "마지막 기록 그대로"다. 예: ack 직후 죽은 쓰기는 `결과=(없음) 전송=may_have_been_sent 권한보유=write`로 보이고, Harness가 다음에 열 때 unknown·복구 필요로 정리된다.

## 보존 정책 (기록이 끝없이 쌓이지 않게)

요청마다 operation·질문·턴 결과가 새로 생기는 것은 정상이다 (요청 = 새 작업). 대신 오래된 기록은 아래 규칙으로 정리한다.
정리는 변경 트랜잭션 안에서 `maintenanceIntervalMs`(기본 5분)마다 한 번, 그리고 `store.maintain()` 호출 시 수행한다.

| 대상 | 규칙 (기본값) |
| --- | --- |
| 종료된 operation | `minRetentionMs`(24시간)가 지나고 참조가 없으면 최소 중복 방지 기록으로 축약 |
| 최소 중복 방지 기록 | 7일 또는 2,000건 초과분을 오래된 것부터 삭제 |
| 턴 결과 (같은 턴 재전달 응답용) | 1시간 또는 500건 초과분 삭제 |
| 닫힌·오래전에 만료된 pending·confirmation | 만료 시각 + 24시간 뒤 삭제 (살아 있는 operation이 참조하면 남김) |
| 파이프라인 순서 기록 | 해당 요청의 pending·operation이 모두 없어지면 삭제 |
| **지우지 않는 것** | 진행 중, 결과 불명(unknown), 판정 대기, 복구 필요·진행·차단, 실행 권한 보유, 참조 중인 기록 |

- SQLite는 `auto_vacuum=INCREMENTAL`로 열고, 삭제가 있는 커밋 뒤 `incremental_vacuum`으로 파일 공간을 돌려받는다 (기존 파일은 열 때 한 번 변환).
- 검증: 한 시간에 한 번씩 400번 요청(약 17일)을 넣어도 레코드 수·사용 페이지가 200번째와 400번째에 거의 같다 (`retention.test.ts`).

## 제약 (MVP)

- **단일 기록자**: 한 DB 파일은 한 Harness 프로세스만 쓴다. 열 때 `<DB>.lock`을 만들고 닫을 때 지운다. 같은 컴퓨터에서 잠금을 잡은 프로세스가 이미 끝났으면 넘겨받고, 살아 있거나 다른 컴퓨터 이름이면 `StoreLockedError`로 열지 않는다. `pnpm db`(읽기 전용)는 잠그지 않는다.
- **ID 생성기**: 재시작해도 겹치지 않아야 한다 (`randomIdGen`). 겹치면 `id collision` 오류로 거부해 기존 기록을 덮어쓰지 않는다.
- **Node 22.13 이상** (`node:sqlite` 플래그 없이 사용). 실행 시 ExperimentalWarning이 한 줄 출력될 수 있다.
- 변경마다 전체 레코드를 직렬화해 비교한다. 기록이 수천 건을 넘으면 변경 추적 방식으로 최적화 필요.
- `RequestMeta`(요청 진행 중 메모리 상태)는 저장하지 않는다. 재시작 뒤에는 pending 기록에서 최소 정보를 복원한다 (기존 설계). 답변을 기다리지 않는 요청은 결과를 낸 즉시 메모리에서 지우고, 최대 500개를 넘으면 질문 유효 기간이 지난 것부터 정리한다.

## 검증

- `packages/harness/test/store.test.ts`: 기존 저장소 테스트 전체를 메모리 / SQLite 두 경로로 실행.
- `packages/harness/test/durable.test.ts`: 파일을 닫고 다시 열기, 기록 실패 되돌리기, ID 충돌 거부, **자식 프로세스를 ack 직후·ack 전에 SIGKILL로 강제 종료한 뒤 다른 프로세스에서 열어 복구 확인**.
- `tests/e2e/scenarios.test.ts`: S-07 크래시 시나리오를 실제 SQLite 파일로 재실행(파일을 닫고 다시 열어도 unknown, 재전송 없음).
