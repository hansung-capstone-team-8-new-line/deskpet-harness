import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { WikiEvidence } from '@deskpet/contracts';
import type { WikiReader } from '../ports.js';

/**
 * vault(Obsidian 마크다운) 키워드 검색 — 결정 D-19 / L-10 (2026-10-12).
 *
 * - 검색 대상: `wiki/**\/*.md` + `projects/**\/README.md`. raw/·outputs/·archive/·private/와 숨김 폴더는 읽지 않는다.
 *   `type: private-note`·`private` 태그 문서, 목록용 문서(INDEX·TOPIC_MAP·VAULT_MEMORY)도 뺀다.
 * - 문서를 제목(##) 단위 구간으로 나누고, 키워드(한글은 2글자 조각) 점수 + 제목·frontmatter(topics·tags·aliases·repo) 가중치로 고른다.
 * - 결과는 발췌 최대 3개, 합계 1,500자, 출처 경로(`wiki/x.md#제목`). 비밀값처럼 보이는 줄은 발췌에서 지운다.
 * - 검색 결과 없음(empty)과 검색 실패(failed)를 구분한다 (interface-contracts I-08). 읽기 전용이다.
 * - Wiki 내용은 데이터다. 승인 근거·실행 정책으로 쓰지 않는다 (Guide 판단 참고에만).
 */
export interface FileWikiReaderOptions {
  root: string;
  maxExcerpts?: number;
  maxTotalChars?: number;
  /** 색인 다시 읽는 간격(ms). 기본 60초 */
  refreshMs?: number;
  now?: () => number;
}

interface Section {
  path: string;
  title: string;
  heading: string;
  text: string;
  meta: string;
  terms: Map<string, number>;
  /** 구간 길이(조각 수). 긴 구간이 점수를 독차지하지 않도록 정규화한다 (BM25) */
  len: number;
}

const INCLUDE_ROOTS = ['wiki', 'projects'];
const EXCLUDE_DIRS = new Set(['raw', 'outputs', 'archive', 'private', 'node_modules', 'config']);
const EXCLUDE_FILES = new Set(['INDEX.md', 'TOPIC_MAP.md', 'VAULT_MEMORY.md']);
const SECRET_LINE = /(api[_-]?key|token|password|passwd|secret|비밀번호|패스워드)\s*[:=]/i;
const STOP = new Set(['해줘', '알려줘', '알려', '그거', '이거', '저거', '뭐야', '뭐지', '어떻게', '좀', '그', '이', '저', 'the', 'and', 'for', 'what', 'how']);

export class FileWikiReader implements WikiReader {
  private index?: { builtAt: number; sections: Section[]; df: Map<string, number>; avgLen: number };
  private readonly now: () => number;

  constructor(private readonly o: FileWikiReaderOptions) {
    this.now = o.now ?? (() => Date.now());
  }

  async search(query: string, scope: string, constraints: { deadlineAt: string }): Promise<WikiEvidence> {
    if (this.now() > Date.parse(constraints.deadlineAt)) return { outcome: 'failed', excerpts: [] };
    let idx: NonNullable<FileWikiReader['index']>;
    try {
      idx = await this.load();
    } catch {
      return { outcome: 'failed', excerpts: [] };
    }
    const q = [...new Set(terms(query))];
    if (q.length === 0) return { outcome: 'empty', excerpts: [] };
    const n = idx.sections.length || 1;
    const scored = idx.sections
      .filter((s) => inScope(s, scope))
      .map((s) => {
        let score = 0;
        let matched = 0;
        for (const t of q) {
          const tf = s.terms.get(t) ?? 0;
          const inHead = s.heading.includes(t) || s.title.includes(t);
          const inMeta = s.meta.includes(t);
          if (!tf && !inHead && !inMeta) continue;
          matched += 1;
          const df = idx.df.get(t) ?? 0;
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
          const bm = tf ? (tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * s.len) / idx.avgLen)) : 0;
          score += idf * (bm + (inHead ? 1.5 : 0) + (inMeta ? 1 : 0));
        }
        return { s, score, matched };
      })
      // 한 조각만 겹치는 우연한 일치는 버린다
      .filter((x) => x.matched >= Math.min(2, q.length))
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return { outcome: 'empty', excerpts: [] };

    const maxN = this.o.maxExcerpts ?? 3;
    let budget = this.o.maxTotalChars ?? 1_500;
    const per = Math.floor(budget / maxN);
    const excerpts: WikiEvidence['excerpts'] = [];
    const seenPaths = new Map<string, number>();
    for (const { s } of scored) {
      if (excerpts.length >= maxN || budget <= 0) break;
      // 한 문서에서 너무 많이 가져오지 않는다
      if ((seenPaths.get(s.path) ?? 0) >= 2) continue;
      const text = excerptOf(s.text, q, Math.min(per, budget));
      if (!text) continue;
      excerpts.push({ text, source: { kind: 'wiki', ref: `${s.path}${s.heading ? `#${s.heading}` : ''}` } });
      seenPaths.set(s.path, (seenPaths.get(s.path) ?? 0) + 1);
      budget -= text.length;
    }
    return excerpts.length ? { outcome: 'found', excerpts } : { outcome: 'empty', excerpts: [] };
  }

  /** 진단용: 색인한 문서 수·구간 수 */
  async stats(): Promise<{ documents: number; sections: number }> {
    const idx = await this.load();
    return { documents: new Set(idx.sections.map((s) => s.path)).size, sections: idx.sections.length };
  }

  private async load() {
    if (this.index && this.now() - this.index.builtAt < (this.o.refreshMs ?? 60_000)) return this.index;
    const st = await stat(this.o.root);
    if (!st.isDirectory()) throw new Error('wiki root is not a directory');
    const files: string[] = [];
    for (const r of INCLUDE_ROOTS) await walk(join(this.o.root, r), r === 'projects' ? (f) => f === 'README.md' : (f) => f.endsWith('.md'), files);
    const sections: Section[] = [];
    for (const f of files) {
      const raw = await readFile(f, 'utf8');
      const { meta, body } = splitFrontmatter(raw.replace(/\r\n/g, '\n'));
      if (isPrivate(meta)) continue;
      const rel = relative(this.o.root, f).split(sep).join('/');
      sections.push(...toSections(rel, meta, body));
    }
    const df = new Map<string, number>();
    for (const s of sections) for (const t of s.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const avgLen = sections.reduce((a, x) => a + x.len, 0) / (sections.length || 1) || 1;
    this.index = { builtAt: this.now(), sections, df, avgLen };
    return this.index;
  }
}

async function walk(dir: string, accept: (name: string) => boolean, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!EXCLUDE_DIRS.has(e.name)) await walk(p, accept, out);
    } else if (e.isFile() && accept(e.name) && !EXCLUDE_FILES.has(e.name)) out.push(p);
  }
}

function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  let key = '';
  for (const line of raw.slice(4, end).split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1]!;
      meta[key] = kv[2]!.replace(/^["']|["']$/g, '');
    } else if (key && /^\s*-\s+/.test(line)) meta[key] = `${meta[key] ?? ''} ${line.replace(/^\s*-\s+/, '').replace(/^["']|["']$/g, '')}`.trim();
  }
  return { meta, body: raw.slice(end + 4) };
}

function isPrivate(meta: Record<string, string>): boolean {
  return meta['type'] === 'private-note' || /\bprivate\b/.test(meta['tags'] ?? '') || meta['private'] === 'true' || meta['visibility'] === 'private';
}

function toSections(path: string, meta: Record<string, string>, body: string): Section[] {
  const title = (body.match(/^#\s+(.+)$/m)?.[1] ?? path).trim();
  const metaText = ['topics', 'tags', 'aliases', 'repo', 'goal', 'type'].map((k) => meta[k] ?? '').join(' ').toLowerCase();
  const out: Section[] = [];
  let heading = '';
  let buf: string[] = [];
  const flush = () => {
    const text = buf
      .filter((l) => !SECRET_LINE.test(l))
      .join('\n')
      .trim();
    if (text.length >= 20) {
      const ts = terms(`${heading} ${text}`);
      out.push({ path, title: title.toLowerCase(), heading, text, meta: metaText, terms: count(ts), len: ts.length });
    }
    buf = [];
  };
  for (const line of body.split('\n')) {
    const h = line.match(/^#{2,3}\s+(.+)$/);
    if (h) {
      flush();
      heading = h[1]!.trim();
    } else if (!/^#\s/.test(line)) buf.push(line);
  }
  flush();
  return out;
}

/** 검색 단위: 영문·숫자 단어(2자 이상), 한글은 2글자 조각 (조사·어미 차이를 흡수) */
function terms(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}/._-]+/u)) {
    if (!w || STOP.has(w)) continue;
    if (/[가-힣]/.test(w)) {
      const h = w.replace(/[^가-힣]/g, '');
      for (let i = 0; i + 1 < h.length; i++) out.push(h.slice(i, i + 2));
      const rest = w.replace(/[가-힣]/g, ' ').trim();
      for (const r of rest.split(/\s+/)) if (r.length >= 2) out.push(r);
    } else if (w.length >= 2) out.push(w.replace(/^[._-]+|[._-]+$/g, ''));
  }
  return out.filter(Boolean);
}

function count(ts: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of ts) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function inScope(s: Section, scope: string): boolean {
  if (!scope || scope === 'all') return true;
  if (scope.startsWith('repo:')) return s.meta.includes(scope.slice(5).toLowerCase());
  if (scope.startsWith('path:')) return s.path.startsWith(scope.slice(5));
  return true;
}

/** 질의 조각이 처음 나오는 곳을 중심으로 자른다. 공백은 하나로 줄인다 */
function excerptOf(text: string, q: string[], limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const lower = flat.toLowerCase();
  const at = Math.min(...q.map((t) => lower.indexOf(t)).filter((i) => i >= 0), flat.length);
  const start = Math.max(0, Math.min(at - Math.floor(limit / 4), flat.length - limit));
  const body = flat.slice(start, start + limit - 2);
  return `${start > 0 ? '…' : ''}${body}${start + limit - 2 < flat.length ? '…' : ''}`.slice(0, limit);
}
