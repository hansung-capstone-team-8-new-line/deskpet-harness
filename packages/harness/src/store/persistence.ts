/**
 * OperationStore 영속 계층 (D-02 갱신: in-memory → SQLite 저널).
 *
 * 저장소의 판단 로직은 InMemoryOperationStore 한 곳에 두고, 각 변경 메서드가 끝날 때 바뀐 레코드만 이 계층에
 * **동기·원자적으로** 기록한다. 기록이 끝나야 메서드가 결과를 돌려준다.
 * - 특히 persistMayHaveBeenSent는 디스크 기록이 끝난 뒤에만 ack를 돌려준다 → Gateway는 그 뒤에만 전송한다.
 * - 기록에 실패하면 메모리 상태도 되돌린다 (메모리와 디스크가 어긋나지 않게).
 * - commit은 동기 함수다. JS 단일 스레드에서 "검사 → 변경 → 기록"이 끊기지 않게 하기 위함이다.
 */
export type StoreCategory = 'op' | 'pending' | 'conf' | 'dedup' | 'dedupConf' | 'turn' | 'pipe' | 'meta';

export interface PersistedRow {
  cat: StoreCategory;
  key: string;
  json: string;
}

export interface StorePersistence {
  /** 시작 시 전체 레코드 */
  loadAll(): PersistedRow[];
  /** 한 트랜잭션으로 기록한다. 실패하면 아무것도 기록하지 않고 예외를 던진다 */
  commit(upserts: PersistedRow[], deletes: { cat: StoreCategory; key: string }[]): void;
  close(): void;
}

/** 메모리 전용 (테스트·기본값) */
export class NoopPersistence implements StorePersistence {
  loadAll(): PersistedRow[] {
    return [];
  }
  commit(): void {}
  close(): void {}
}

/** 기록 실패 시 던지는 오류. 전송 전이면 실행을 막고, 전송 후면 외부 실패로 보지 않는다 (Liability §Recovery) */
export class StoreStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreStorageError';
  }
}
