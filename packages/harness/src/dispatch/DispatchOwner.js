export class StoreDispatchOwner {
    store;
    clock;
    holderId;
    validity;
    constructor(store, clock, holderId, validity) {
        this.store = store;
        this.clock = clock;
        this.holderId = holderId;
        this.validity = validity;
    }
    prepareOperation(command) {
        return this.store.reserveAndPrepare({ ...command, holderId: this.holderId });
    }
    async beforeDispatch(operationId, attemptId, ownerRevision) {
        const op = await this.store.getOperation(operationId);
        if (!op)
            return { ok: false, reason: 'not_found', detail: operationId };
        const blocked = await this.validity(op);
        if (blocked) {
            // 실행 권한 회수: 아직 not_sent이므로 전송하지 않았음이 확실하다
            await this.store.revokeBeforeDispatch(operationId, blocked);
            return { ok: false, reason: 'authority_revoked', detail: blocked };
        }
        return this.store.persistMayHaveBeenSent({
            operationId,
            attemptId,
            ownerRevision,
            holderId: this.holderId,
            kind: 'write',
        });
    }
    recordEvidence(operationId, attemptId, evidence) {
        return this.store.appendEvidence(operationId, { ...evidence, attemptId });
    }
    handleFor(authority, operationId, signal) {
        return {
            operationId,
            attemptId: authority.attemptId,
            ownerRevision: authority.ownerRevision,
            beforeDispatch: () => this.beforeDispatch(operationId, authority.attemptId, authority.ownerRevision),
            ...(signal ? { signal } : {}),
        };
    }
}
