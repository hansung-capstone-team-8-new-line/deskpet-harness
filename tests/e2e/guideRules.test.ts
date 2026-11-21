import { afterEach, describe, expect, it } from 'vitest';
import { OutputService } from '@deskpet/output';
import { McpGuideRegistry, createDeclarativeMcpGuide, type GuidePromptContext } from '@deskpet/harness';
import { DirectHarnessInbound, HarnessWsServer } from '@deskpet/server';
import { cleanGuideRules } from '../../scripts/runtimeSettings.js';
import { createWorld } from '../support/world.js';

/** D-61 웹 설정의 Guide 사용자 규칙: 코드 규칙·가드는 그대로, 지시문 끝에 덧붙인다 */
const ctx = (mcpId: string) => ({ goal: 'PR 42 리뷰', mcpId, turn: { rawText: 'PR 42 리뷰해 줘' }, context: {}, availableTools: [], fastPathTools: [], workerId: 'w1' }) as unknown as GuidePromptContext;

describe('Guide 사용자 규칙 (D-61)', () => {
  it('공통(*)과 그 Guide 규칙을 지시문 끝에 붙이고, 가드는 원래 Guide 것을 쓴다', () => {
    const guard = () => ({ allowed: true }) as never;
    const github = createDeclarativeMcpGuide({ mcpId: 'github', instructions: ['코드 규칙'], evaluateGuards: guard });
    const rules: Record<string, string[]> = {};
    const reg = new McpGuideRegistry([github]);
    reg.setUserRules(() => rules);
    // 규칙이 없으면 원래 Guide 그대로
    expect(reg.resolve('github')).toBe(github);

    rules['*'] = ['한국어로 짧게'];
    rules['GitHub'] = ['리뷰는 세 줄 이내', '  '];
    const g = reg.resolve('github');
    const text = g.buildInstructions(ctx('github'));
    expect(text).toContain('코드 규칙');
    expect(text.indexOf('[사용자 추가 규칙 (웹 설정)]')).toBeGreaterThan(text.indexOf('코드 규칙'));
    expect(text).toContain('1. 한국어로 짧게\n2. 리뷰는 세 줄 이내');
    expect(g.evaluateGuards).toBe(guard);
    expect(g.mcpId).toBe('github');
    // 범용 Guide에는 공통 규칙만
    expect(reg.resolve('slack').buildInstructions(ctx('slack'))).toContain('1. 한국어로 짧게');
    expect(reg.resolve('slack').buildInstructions(ctx('slack'))).not.toContain('세 줄');
  });

  it('설정 파일 값 정리: 문자열만, 빈 줄·빈 Guide 제거', () => {
    expect(cleanGuideRules({ github: [' a ', '', 3, 'b'], workspace: [], x: 'nope' })).toEqual({ github: ['a', 'b'] });
    expect(cleanGuideRules(null)).toEqual({});
  });
});

const servers: HarnessWsServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

describe('settings.set 부분 저장 (D-61)', () => {
  it('guideRules만 보내도 저장 처리기로 넘어간다 (승인 허용 저장소는 보내지 않음)', async () => {
    const w = createWorld();
    const got: unknown[] = [];
    const server = new HarnessWsServer({
      inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }),
      store: w.store,
      token: 'test-token',
      openViewer: true,
      port: 0,
      settings: async (s) => {
        got.push(s);
        return { ok: true, message: '저장했어요' };
      },
    });
    servers.push(server);
    const { port } = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token: '', role: 'viewer' })));
      ws.addEventListener('message', (e) => {
        const f = JSON.parse(String(e.data)) as Record<string, unknown>;
        if (f['type'] === 'welcome') ws.send(JSON.stringify({ type: 'settings.set', id: 's', settings: { guideRules: { github: ['리뷰는 세 줄 이내'] } } }));
        if (f['type'] === 'settings.result') resolve(f);
      });
    });
    ws.close();
    expect(reply).toMatchObject({ ok: true });
    expect(got).toEqual([{ guideRules: { github: ['리뷰는 세 줄 이내'] } }]);
  });

  it('HarnessService.guides(): 등록된 Guide와 범용(*)', () => {
    const w = createWorld();
    const ids = w.harness.guides().map((g) => g.mcpId);
    expect(ids).toContain('github');
    expect(ids[ids.length - 1]).toBe('*');
  });
});
