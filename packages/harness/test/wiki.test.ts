import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileWikiReader } from '@deskpet/harness';

/** LLM Wiki 검색 (D-19 / L-10): wiki/ + projects/ README만, 발췌 3개·1,500자, 없음과 실패 구분 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const DL = { deadlineAt: '2099-01-01T00:00:00.000Z' };

function vault(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'deskpet-wiki-'));
  dirs.push(root);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

const doc = (title: string, sections: Record<string, string>, fm = 'type: concept') => `---\n${fm}\n---\n\n# ${title}\n\n${Object.entries(sections).map(([h, b]) => `## ${h}\n\n${b}`).join('\n\n')}\n`;

describe('FileWikiReader', () => {
  it('관련 구간을 찾아 출처 경로·제목과 함께 돌려준다', async () => {
    const root = vault({
      'wiki/eureka-process.md': doc('Eureka Process', { 'API 규격': 'Eureka 단계 완료는 POST /_api_/stages/{stageId}/status 로 보낸다. x-api-key 헤더를 쓴다.', '용어': '업무(item)와 단계(stage)를 구분한다.' }),
      'wiki/hardware.md': doc('Hardware', { 전원: '젯슨 오린 나노 전원은 19V 어댑터를 쓴다. 서보는 별도 전원.' }),
    });
    const r = await new FileWikiReader({ root }).search('Eureka 단계 완료는 어떻게 보내?', 'all', DL);
    expect(r.outcome).toBe('found');
    expect(r.excerpts[0]!.source).toEqual({ kind: 'wiki', ref: 'wiki/eureka-process.md#API 규격' });
    expect(r.excerpts[0]!.text).toContain('/_api_/stages');
  });

  it('raw/·outputs/·archive/·private 문서·목록 문서는 읽지 않는다. projects/는 README만', async () => {
    const secret = '비밀 계정 정보 젯슨 전원 비밀';
    const root = vault({
      'raw/계정 정보들.md': `# 계정\n\n## 젯슨 전원\n\n${secret} ${secret}`,
      'outputs/x.md': doc('Out', { '젯슨 전원': secret }),
      'archive/y.md': doc('Arc', { '젯슨 전원': secret }),
      'wiki/private-note.md': doc('P', { '젯슨 전원': secret }, 'type: private-note\ntags:\n  - private'),
      'wiki/INDEX.md': doc('Index', { '젯슨 전원': secret }),
      'projects/deskpet/notes.md': doc('Notes', { '젯슨 전원': secret }),
      'projects/deskpet/README.md': doc('DeskPet', { 현황: '젯슨 오린 나노 전원 장치를 대여했다. 전원 회로는 하드웨어 문서 참고.' }),
    });
    const reader = new FileWikiReader({ root });
    const r = await reader.search('젯슨 전원', 'all', DL);
    expect(r.outcome).toBe('found');
    expect(r.excerpts.map((e) => e.source.ref)).toEqual(['projects/deskpet/README.md#현황']);
    expect(JSON.stringify(r)).not.toContain('비밀');
    expect(await reader.stats()).toEqual({ documents: 1, sections: 1 });
  });

  it('비밀값처럼 보이는 줄은 발췌에서 지운다', async () => {
    const root = vault({ 'wiki/setup.md': doc('Setup', { 'Eureka 연결': 'Eureka 연결 방법을 정리한다.\nEUREKA_API_KEY: abcd1234secret\n개발 환경은 flw-d1 이다.' }) });
    const r = await new FileWikiReader({ root }).search('Eureka 연결 방법', 'all', DL);
    expect(r.outcome).toBe('found');
    expect(r.excerpts[0]!.text).not.toContain('abcd1234secret');
    expect(r.excerpts[0]!.text).toContain('flw-d1');
  });

  it('발췌는 최대 3개, 합계 1,500자', async () => {
    const long = '라우터 신뢰도 임계값 '.repeat(200);
    const root = vault(Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`wiki/doc${i}.md`, doc(`Doc ${i}`, { [`구간 ${i}`]: long })])));
    const r = await new FileWikiReader({ root }).search('라우터 신뢰도 임계값', 'all', DL);
    expect(r.excerpts).toHaveLength(3);
    expect(r.excerpts.reduce((a, e) => a + e.text.length, 0)).toBeLessThanOrEqual(1_500);
  });

  it('관련 문서가 없으면 empty, 경로가 없으면 failed (구분한다)', async () => {
    const root = vault({ 'wiki/a.md': doc('A', { 내용: '서보 모터 배선과 디스플레이 SPI 연결.' }) });
    expect((await new FileWikiReader({ root }).search('깃허브 승인 정책', 'all', DL)).outcome).toBe('empty');
    expect((await new FileWikiReader({ root: join(root, 'nope') }).search('아무거나', 'all', DL)).outcome).toBe('failed');
    expect((await new FileWikiReader({ root }).search('서보 모터', 'all', { deadlineAt: '2000-01-01T00:00:00.000Z' })).outcome).toBe('failed');
  });
});
