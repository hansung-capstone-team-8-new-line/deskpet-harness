import type { WikiEvidence } from '@deskpet/contracts';

/**
 * «port» WikiReader — 문서 없음과 검색 실패를 구분한다 (interface-contracts I-08).
 * Wiki 내용은 데이터이며 승인 증거나 실행 정책이 아니다.
 */
export interface WikiReader {
  search(query: string, scope: string, constraints: { deadlineAt: string }): Promise<WikiEvidence>;
}

export class StaticWikiReader implements WikiReader {
  constructor(private readonly entries: { text: string; ref: string; keywords: string[] }[] = []) {}
  async search(query: string): Promise<WikiEvidence> {
    const hits = this.entries.filter((e) => e.keywords.some((k) => query.includes(k)));
    return {
      outcome: hits.length ? 'found' : 'empty',
      excerpts: hits.map((h) => ({ text: h.text, source: { kind: 'wiki', ref: h.ref } })),
    };
  }
}

// LlmClient port는 @deskpet/contracts (llm.ts)로 옮겼다. 공급자 어댑터는 @deskpet/llm.
