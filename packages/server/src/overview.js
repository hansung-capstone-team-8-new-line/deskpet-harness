import { extractPrLinks, isRepositoryAllowed } from '@deskpet/contracts';
const TIMEOUT_MS = 10_000;
export class OverviewService {
    opt;
    o;
    running;
    lastRefresh = 0;
    timer;
    constructor(opt) {
        this.opt = opt;
        this.o = { state: 'loading', items: [], reminders: [], links: { ...(opt.eurekaWebUrl ? { eurekaWebUrl: opt.eurekaWebUrl } : {}), repos: [] }, problems: [] };
    }
    get() {
        return this.o;
    }
    now() {
        return (this.opt.now ?? Date.now)();
    }
    start(intervalMs) {
        void this.refresh(true);
        this.timer = setInterval(() => void this.refresh(true), intervalMs);
        this.timer.unref?.();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
    }
    /** 다시 읽기. 이미 읽는 중이면 그 결과를 기다리고, 너무 자주 누르면(force 아님) 건너뛴다 */
    refresh(force = false) {
        if (this.running)
            return this.running;
        if (!force && this.now() - this.lastRefresh < (this.opt.minRefreshMs ?? 30_000))
            return Promise.resolve();
        this.lastRefresh = this.now();
        this.set({ ...this.o, refreshing: true });
        this.running = this.load()
            .then((next) => this.set(next))
            .catch((e) => {
            this.opt.log?.(`현황을 읽지 못했어요: ${e instanceof Error ? e.message : String(e)}`);
            this.set({ ...this.o, state: 'failed', refreshing: false, problems: ['현황을 읽지 못했어요'] });
        })
            .finally(() => {
            this.running = undefined;
        });
        return this.running;
    }
    set(o) {
        this.o = o;
        this.opt.onChange?.(o);
    }
    deadline() {
        return { deadlineAt: new Date(this.now() + TIMEOUT_MS).toISOString() };
    }
    async load() {
        const problems = [];
        let items = [];
        let eurekaOk = false;
        if (this.opt.eureka) {
            const list = await this.opt.eureka.listTasks({ onlyOpen: true, limit: 100 }, this.deadline());
            if (list.ok) {
                eurekaOk = true;
                if (list.data.completeness === 'partial')
                    problems.push('Eureka 업무가 많아 일부만 읽었어요');
                items = sortItems(list.data.items, this.now()).map(toItem);
            }
            else
                problems.push(`Eureka 업무를 읽지 못했어요 (${list.result.error?.provisionalCode ?? '오류'})`);
        }
        else
            problems.push('Eureka가 연결되지 않았어요');
        // 단계 기록의 PR 주소 (상위 업무만)
        const max = this.opt.maxItemsForLinks ?? 10;
        if (this.opt.eureka?.listStageNotes && items.length) {
            let failed = 0;
            for (const it of items.slice(0, max)) {
                const src = it;
                for (const st of src._noteStages ?? []) {
                    const notes = await this.opt.eureka.listStageNotes({ stageId: st.stageId }, this.deadline());
                    if (!notes.ok) {
                        failed++;
                        continue;
                    }
                    for (const n of notes.data.notes)
                        for (const l of extractPrLinks(n.content)) {
                            if (!isRepositoryAllowed(this.opt.allowedRepositories, l.owner, l.name))
                                continue;
                            if (it.prs.some((p) => p.owner.toLowerCase() === l.owner.toLowerCase() && p.name.toLowerCase() === l.name.toLowerCase() && p.prNumber === l.prNumber))
                                continue;
                            it.prs.push({ owner: l.owner, name: l.name, prNumber: l.prNumber, url: l.url, stageName: st.name });
                        }
                }
            }
            if (failed)
                problems.push(`단계 기록 ${failed}개를 읽지 못했어요`);
        }
        for (const it of items)
            delete it._noteStages;
        // 연결된 PR 상태
        if (this.opt.github) {
            const prs = items.flatMap((i) => i.prs).slice(0, 20);
            let failed = 0;
            for (const p of prs) {
                try {
                    const b = await this.opt.github.read({ kind: 'pr', repository: { owner: p.owner, name: p.name }, prNumber: p.prNumber }, { timeoutMs: TIMEOUT_MS });
                    Object.assign(p, { state: b.state, title: b.title, draft: b.draft });
                }
                catch {
                    failed++;
                }
            }
            if (failed)
                problems.push(`연결된 PR ${failed}개의 상태를 읽지 못했어요`);
        }
        // 저장소: 설정한 저장소 + 업무에 연결된 PR의 저장소
        const repoKeys = new Map();
        const configured = typeof this.opt.repos === 'function' ? this.opt.repos() : (this.opt.repos ?? []);
        for (const r of [...configured, ...items.flatMap((i) => i.prs.map((p) => ({ owner: p.owner, name: p.name })))]) {
            const k = `${r.owner}/${r.name}`.toLowerCase();
            if (!repoKeys.has(k))
                repoKeys.set(k, r);
        }
        const repos = [];
        for (const r of repoKeys.values()) {
            const repo = { owner: r.owner, name: r.name, url: `https://github.com/${r.owner}/${r.name}` };
            if (this.opt.github) {
                try {
                    const b = await this.opt.github.read({ kind: 'open_prs', repository: r, perPage: 20 }, { timeoutMs: TIMEOUT_MS });
                    // 본문은 웹으로 보내지 않는다 (Eureka 표시 찾기는 서버 안에서만)
                    repo.openPrs = b.prs.map(({ body: _body, ...p }) => p);
                    repo.hasMore = b.hasMore;
                }
                catch (e) {
                    repo.error = e.kind === 'not_found' ? '저장소를 찾지 못했어요 (이름·토큰 권한 확인)' : '열린 PR을 읽지 못했어요';
                }
            }
            repos.push(repo);
        }
        if (!repos.length)
            problems.push('표시할 GitHub 저장소가 없어요 (웹 설정 > 승인 허용 저장소)');
        const days = this.opt.reminderDays ?? 7;
        const now = this.now();
        // 업무 마감 + 끝나지 않은 단계의 마감 (단계별 마감, 2026-11-14)
        const dues = items.flatMap((i) => [
            ...(i.dueAt ? [{ itemId: i.itemId, name: i.name, dueAt: i.dueAt }] : []),
            ...i.stages.filter((s) => s.dueAt && s.status !== 'done' && s.status !== 'skip').map((s) => ({ itemId: i.itemId, name: i.name, stageName: s.name, dueAt: s.dueAt })),
        ]);
        const reminders = dues
            .map((d) => {
            const ms = Date.parse(d.dueAt) - now;
            return { ...d, overdue: ms < 0, daysLeft: Math.ceil(ms / 86_400_000) };
        })
            .filter((r) => r.overdue || r.daysLeft <= days)
            .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
        const autoFocusId = items.find((i) => i.state === 'doing')?.itemId ?? items[0]?.itemId;
        return {
            state: !eurekaOk && !repos.some((r) => r.openPrs) ? 'failed' : problems.length ? 'partial' : 'ok',
            observedAt: new Date(now).toISOString(),
            items,
            ...(autoFocusId ? { autoFocusId } : {}),
            reminders,
            links: { ...(this.opt.eurekaWebUrl ? { eurekaWebUrl: this.opt.eurekaWebUrl } : {}), repos },
            problems,
            refreshing: false,
        };
    }
}
/** 진행 중 → 마감 가까운 순 → 마감 없음 → 이름 */
export function sortItems(items, _now) {
    const rank = (t) => (t.computedState === 'doing' ? 0 : 1);
    return [...items].sort((a, b) => rank(a) - rank(b) || (a.dueAtMs ?? Infinity) - (b.dueAtMs ?? Infinity) || a.name.localeCompare(b.name));
}
function toItem(t) {
    const stages = [...t.stages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const current = stages.find((s) => s.status === 'doing') ?? stages.find((s) => s.status === 'todo');
    const item = {
        itemId: t.itemId,
        name: t.name,
        state: t.computedState,
        ...(t.description ? { description: t.description.slice(0, 500) } : {}),
        ...(t.priority ? { priority: t.priority } : {}),
        ...(t.dueAt ? { dueAt: t.dueAt } : {}),
        stages: stages.map((s) => ({ stageId: s.stageId, name: s.name, status: s.status, ...(s.dueAtMs ? { dueAt: new Date(s.dueAtMs).toISOString() } : {}) })),
        doneStages: stages.filter((s) => s.status === 'done' || s.status === 'skip').length,
        ...(current ? { currentStage: current.name } : {}),
        prs: [],
        _noteStages: stages.filter((s) => s.noteIds?.length).map((s) => ({ stageId: s.stageId, name: s.name })),
    };
    return item;
}
/** "owner/name, owner/name" → 저장소 목록 (형식이 틀린 항목은 버림) */
export function parseRepoList(raw) {
    return (raw ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter((x) => /^[\w.-]+\/[\w.-]+$/.test(x))
        .map((x) => {
        const [owner, name] = x.split('/');
        return { owner, name };
    });
}
