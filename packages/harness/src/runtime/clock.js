export const systemClock = {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
};
export class FakeClock {
    t;
    constructor(startIso) {
        this.t = Date.parse(startIso);
    }
    nowMs() {
        return this.t;
    }
    nowIso() {
        return new Date(this.t).toISOString();
    }
    advance(ms) {
        this.t += ms;
    }
}
export class SequentialIdGen {
    n = 0;
    next(prefix) {
        this.n += 1;
        return `${prefix}-${this.n}`;
    }
}
export const randomIdGen = { next: (p) => `${p}-${crypto.randomUUID()}` };
