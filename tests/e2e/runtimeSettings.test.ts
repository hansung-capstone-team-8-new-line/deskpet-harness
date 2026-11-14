import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { OutputService } from '@deskpet/output';
import { DirectHarnessInbound, HarnessWsServer } from '@deskpet/server';
import { loadRuntimeSettings, saveRuntimeSettings } from '../../scripts/runtimeSettings.js';
import { createWorld } from '../support/world.js';

/** D-52 웹 설정에서 승인 허용 저장소 관리 */
const tmp = mkdtempSync(join(tmpdir(), 'deskpet-settings-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const servers: HarnessWsServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(500);
});

describe('설정 파일', () => {
  it('파일이 없으면 .env 값, 저장하면 파일 값', () => {
    const p = join(tmp, 'a', 'settings.json');
    expect(loadRuntimeSettings(p, { allowedRepositories: ['a/b'] })).toEqual({ settings: { allowedRepositories: ['a/b'] }, source: 'env' });
    saveRuntimeSettings(p, { allowedRepositories: ['x/y'], updatedAt: '2026-11-14T00:00:00.000Z' });
    expect(loadRuntimeSettings(p, { allowedRepositories: ['a/b'] })).toMatchObject({ settings: { allowedRepositories: ['x/y'] }, source: 'file' });
  });

  it('깨진 파일이면 .env 값으로 시작하고 이유를 알린다', () => {
    const p = join(tmp, 'broken.json');
    writeFileSync(p, '{not json');
    const r = loadRuntimeSettings(p, { allowedRepositories: [] });
    expect(r.source).toBe('env');
    expect(r.error).toContain('설정 파일');
  });
});

describe('settings.set', () => {
  it('관리 토큰 없이 보기 전용 연결도 저장할 수 있다 (사용자 결정 2026-11-14)', async () => {
    const w = createWorld();
    const got: unknown[] = [];
    const server = new HarnessWsServer({
      inbound: new DirectHarnessInbound({ harness: w.harness, output: new OutputService() }),
      store: w.store,
      token: 'test-token-0123456789abcdef',
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
        if (f['type'] === 'welcome') ws.send(JSON.stringify({ type: 'settings.set', id: 's', settings: { allowedRepositories: ['NewLine/DeskPet'] } }));
        if (f['type'] === 'settings.result') resolve(f);
      });
    });
    ws.close();
    expect(reply).toMatchObject({ ok: true, message: '저장했어요' });
    expect(got).toEqual([{ allowedRepositories: ['NewLine/DeskPet'] }]);
  });
});
