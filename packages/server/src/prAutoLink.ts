import { isRepositoryAllowed, type PipelineEurekaActionRequest, type Repository } from '@deskpet/contracts';
import type { GitHubTransport } from '@deskpet/gateways';
import type { EurekaBridge } from './eurekaBridge.js';

/**
 * PR ↔ Eureka 자동 연결 (D-57, 2026-11-14 사용자 결정 — 11/10 계획의 A·C).
 *
 * A. PR 제목·본문·브랜치에 Eureka 표시를 쓴다: `EU-<업무번호>` (그 업무의 진행 중 단계) 또는 `EU-<업무번호>.<단계순서>` (몇 번째 단계)
 *    예: 제목 "[EU-1000074] 케이스 도면 수정", 브랜치 "eu-1000074.2/case", 본문 "Eureka: EU-1000074"
 * C. 서버가 주기적으로 승인 허용 저장소의 열린 PR을 읽어, 표시가 있는데 그 업무 단계 기록에 아직 이 PR 주소가 없으면
 *    단계 기록에 PR 주소를 남긴다. 그 뒤로는 지금까지처럼 단계 기록으로 연결된다 (eureka.links, 현재 업무 카드, G-01 완료 근거)
 *
 * - 사용자 확인 없이 쓰는 유일한 Eureka 쓰기다. 내용은 PR 주소 한 줄뿐이고, 같은 PR·단계는 작업 번호로 한 번만 쓴다(재시작해도)
 * - 이미 그 업무 어느 단계에든 같은 PR 주소가 있으면(사람이 적었어도) 쓰지 않는다
 * - 끝난·보류·없는 업무, 없는 단계 번호는 건너뛰고 이유를 남긴다. DESKPET_PR_AUTO_LINK=off로 끈다
 */
export interface PrMarker {
  itemId: string;
  stageOrder?: number;
}

const MARKER = /(?:^|[^A-Za-z0-9])EU-(\d{3,12})(?:\.(\d{1,3}))?(?![0-9])/gi;

/** 제목·본문·브랜치에서 Eureka 표시를 찾는다. 서로 다른 업무 표시가 둘 이상이면 고르지 않는다 (빈 배열) */
export function findMarkers(...texts: (string | undefined)[]): PrMarker[] {
  const found = new Map<string, PrMarker>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(MARKER)) {
      const itemId = m[1]!;
      const stageOrder = m[2] ? Number(m[2]) : undefined;
      const prev = found.get(itemId);
      // 같은 업무를 단계 번호와 함께 쓴 표시가 있으면 그쪽을 쓴다
      if (!prev || (prev.stageOrder === undefined && stageOrder !== undefined)) found.set(itemId, { itemId, ...(stageOrder !== undefined ? { stageOrder } : {}) });
    }
  }
  return [...found.values()];
}

export interface AutoLinkResult {
  pr: string;
  itemId?: string;
  outcome: 'written' | 'already_linked' | 'skipped' | 'failed';
  reason?: string;
}

export interface PrAutoLinkerOptions {
  github: Pick<GitHubTransport, 'read'>;
  bridge: Pick<EurekaBridge, 'execute' | 'links'>;
  /** 볼 저장소 (승인 허용 저장소) */
  repos: () => Repository[];
  allowedRepositories?: string[];
  now?: () => number;
  log?: (line: string) => void;
  onResult?: (r: AutoLinkResult[]) => void;
}

export class PrAutoLinker {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  /** 이번 실행 동안 이미 처리한 PR (같은 결과를 매번 다시 확인하지 않게) */
  private readonly done = new Set<string>();
  last: AutoLinkResult[] = [];

  constructor(private readonly o: PrAutoLinkerOptions) {}

  start(intervalMs: number, firstDelayMs = 15_000) {
    setTimeout(() => void this.run(), firstDelayMs).unref?.();
    this.timer = setInterval(() => void this.run(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  private deadline(sec = 20) {
    return new Date(this.now() + sec * 1000).toISOString();
  }

  async run(): Promise<AutoLinkResult[]> {
    if (this.running) return this.last;
    this.running = true;
    const results: AutoLinkResult[] = [];
    try {
      for (const repo of this.o.repos()) {
        if (!isRepositoryAllowed(this.o.allowedRepositories, repo.owner, repo.name)) continue;
        let prs;
        try {
          prs = (await this.o.github.read({ kind: 'open_prs', repository: repo, perPage: 50 }, { timeoutMs: 15_000 })).prs;
        } catch {
          this.o.log?.(`${repo.owner}/${repo.name} 열린 PR을 읽지 못했어요`);
          continue;
        }
        for (const pr of prs) {
          const markers = findMarkers(pr.title, pr.body, pr.branch);
          if (!markers.length) continue;
          const key = `${repo.owner}/${repo.name}#${pr.number}`.toLowerCase();
          if (markers.length > 1) {
            results.push({ pr: key, outcome: 'skipped', reason: `Eureka 표시가 여러 업무를 가리켜요 (${markers.map((m) => m.itemId).join(', ')})` });
            continue;
          }
          const m = markers[0]!;
          const doneKey = `${key}@${m.itemId}.${m.stageOrder ?? ''}`;
          if (this.done.has(doneKey)) continue;
          const r = await this.linkOne(repo, pr.number, pr.url, pr.title, m);
          results.push(r);
          if (r.outcome === 'written' || r.outcome === 'already_linked') this.done.add(doneKey);
          if (r.outcome === 'written') this.o.log?.(`PR ${key} → Eureka 업무 ${m.itemId} 단계 기록에 연결했어요`);
          else if (r.outcome !== 'already_linked') this.o.log?.(`PR ${key} 자동 연결 건너뜀: ${r.reason ?? r.outcome}`);
        }
      }
    } finally {
      this.running = false;
    }
    this.last = results;
    this.o.onResult?.(results);
    return results;
  }

  private async linkOne(repo: Repository, prNumber: number, url: string, title: string, m: PrMarker): Promise<AutoLinkResult> {
    const pr = `${repo.owner}/${repo.name}#${prNumber}`.toLowerCase();
    // 이미 그 업무 단계 기록에 이 PR이 있으면 쓰지 않는다 (사람이 적은 것 포함)
    const links = await this.o.bridge.links(m.itemId, this.deadline());
    if (links.status === 'not_found') return { pr, itemId: m.itemId, outcome: 'skipped', reason: `Eureka 업무 ${m.itemId}를 찾지 못했어요` };
    if (links.status === 'failed') return { pr, itemId: m.itemId, outcome: 'failed', reason: 'Eureka 단계 기록을 읽지 못했어요' };
    if (links.links.some((l) => l.prNumber === prNumber && l.repository.owner.toLowerCase() === repo.owner.toLowerCase() && l.repository.name.toLowerCase() === repo.name.toLowerCase())) {
      return { pr, itemId: m.itemId, outcome: 'already_linked' };
    }
    // 단계: 번호를 줬으면 그 순서의 단계, 아니면 브리지가 고르는 진행 중 → 첫 대기 단계
    const stageName = m.stageOrder !== undefined ? await this.stageNameAt(m.itemId, m.stageOrder) : undefined;
    if (m.stageOrder !== undefined && !stageName) return { pr, itemId: m.itemId, outcome: 'skipped', reason: `업무 ${m.itemId}에 ${m.stageOrder}번째 단계가 없어요` };
    // 같은 PR·업무·단계는 같은 작업 번호 → 다시 돌아도(서버 재시작 포함) 한 번만 쓴다
    const opKey = `autolink-${repo.owner}-${repo.name}-${prNumber}-${m.itemId}-${m.stageOrder ?? 'cur'}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const note = `PR: ${url} (자동 연결: ${title.slice(0, 120)})`;
    const req: PipelineEurekaActionRequest = {
      requestId: opKey,
      operationId: opKey,
      decision: {
        headOutputs: {
          intention: { value: 'eureka', confidence: 1 },
          modelIntention: { value: 'eureka', confidence: 1 },
          operation: { value: 'add_note', confidence: 1 },
          note: { value: note, confidence: 1 },
          ...(stageName ? { name: { value: stageName, confidence: 1 } } : {}),
        },
        overallConfidence: 1,
        missingRequiredSlots: [],
        route: 'eureka',
        resolvedTarget: { kind: 'eureka_item', itemId: m.itemId },
      },
      deadlineAt: this.deadline(),
      mutationApproved: true,
    };
    const r = await this.o.bridge.execute(req);
    if (r.status === 'succeeded') return { pr, itemId: m.itemId, outcome: 'written' };
    return { pr, itemId: m.itemId, outcome: r.status === 'unknown' ? 'failed' : 'skipped', reason: r.facts['resultText'] ?? r.error?.code ?? r.status };
  }

  private async stageNameAt(itemId: string, order: number): Promise<string | undefined> {
    const req: PipelineEurekaActionRequest = {
      requestId: `autolink-read-${itemId}`,
      operationId: `autolink-read-${itemId}-${this.now()}`,
      decision: { headOutputs: { intention: { value: 'eureka', confidence: 1 }, modelIntention: { value: 'eureka', confidence: 1 }, operation: { value: 'query', confidence: 1 } }, overallConfidence: 1, missingRequiredSlots: [], route: 'eureka', resolvedTarget: { kind: 'eureka_item', itemId } },
      deadlineAt: this.deadline(),
      mutationApproved: false,
    };
    const r = await this.o.bridge.execute(req);
    if (r.status !== 'succeeded') return undefined;
    try {
      return (JSON.parse(r.facts['stages'] ?? '[]') as { name: string }[])[order - 1]?.name;
    } catch {
      return undefined;
    }
  }
}
