/** 메모리 전용 (테스트·기본값) */
export class NoopPersistence {
    loadAll() {
        return [];
    }
    commit() { }
    close() { }
}
/** 기록 실패 시 던지는 오류. 전송 전이면 실행을 막고, 전송 후면 외부 실패로 보지 않는다 (Liability §Recovery) */
export class StoreStorageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'StoreStorageError';
    }
}
