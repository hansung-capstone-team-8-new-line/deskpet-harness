export class StaticWikiReader {
    entries;
    constructor(entries = []) {
        this.entries = entries;
    }
    async search(query) {
        const hits = this.entries.filter((e) => e.keywords.some((k) => query.includes(k)));
        return {
            outcome: hits.length ? 'found' : 'empty',
            excerpts: hits.map((h) => ({ text: h.text, source: { kind: 'wiki', ref: h.ref } })),
        };
    }
}
// LlmClient port는 @deskpet/contracts (llm.ts)로 옮겼다. 공급자 어댑터는 @deskpet/llm.
