import { describe, expect, it } from 'vitest';
import { displayWidth, padEnd, renderBanner } from '../../scripts/banner.js';

/** 서버 시작 화면 정리 (2026-11-14): 한글 두 칸 기준으로 열을 맞춘다 */
describe('시작 화면', () => {
  it('한글은 두 칸으로 센다', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('웹 화면')).toBe(7);
    expect(displayWidth(padEnd('LLM', 8))).toBe(8);
    expect(displayWidth(padEnd('업데이트', 8))).toBe(8);
  });

  it('묶음 제목·항목 이름·값을 같은 열에 맞추고, 경고와 안내를 아래에 둔다', () => {
    const out = renderBanner({
      title: 'DeskPet Harness 서버',
      sections: [
        { title: '접속', rows: [['웹 화면', 'http://127.0.0.1:8787'], ['다른 기기', '꺼짐']] },
        { title: 'LLM', rows: [['', 'gemini']] },
      ],
      warnings: ['주의'],
      footer: ['Ctrl+C'],
    }).split('\n');
    const valueCol = (line: string, v: string) => displayWidth(line.slice(0, line.indexOf(v)));
    const a = out.find((l) => l.includes('http'))!;
    const b = out.find((l) => l.includes('꺼짐'))!;
    expect(valueCol(a, 'http')).toBe(valueCol(b, '꺼짐'));
    expect(out).toContain('  ! 주의');
    expect(out.at(-1)).toBe('  Ctrl+C');
  });
});
