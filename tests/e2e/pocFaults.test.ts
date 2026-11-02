import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { SensorInput } from '@deskpet/contracts';
import { pocSetup } from '../../scripts/poc-faults.js';

/** D-27 POC 장애 주입: 켜는 조건과 각 장애가 실제로 무엇을 하는지 */
let srv: Server | undefined;
afterEach(() => new Promise<void>((r) => (srv ? srv.close(() => r()) : r())));
async function fakeRemote() {
  const hits: string[] = [];
  srv = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, hits };
}
const env = (faults: string, extra: Record<string, string> = {}) => ({ DESKPET_POC_FAULTS: faults, EUREKA_BASE_URL: 'https://api.eureka.codes/flw-d1', ...extra });
const quiet = () => undefined;

describe('POC 장애 주입 켜는 조건', () => {
  it('--poc가 없거나 flw-d1이 아니거나 항목이 없으면 아무것도 하지 않는다. 모르는 이름은 시작 거부', () => {
    expect(pocSetup(env('sensor_fail_once'), [], quiet)).toMatchObject({ enabled: false });
    expect(pocSetup(env('sensor_fail_once', { EUREKA_BASE_URL: 'https://api.eureka.codes/flw-v1' }), ['--poc'], quiet)).toMatchObject({ enabled: false });
    expect(pocSetup(env(''), ['--poc'], quiet)).toMatchObject({ enabled: false });
    expect(() => pocSetup(env('boom'), ['--poc'], quiet)).toThrow(/알 수 없는/);
    expect(pocSetup(env('sensor_fail_once'), ['--poc'], quiet)).toMatchObject({ enabled: true, faults: ['sensor_fail_once'] });
  });
});

describe('각 장애', () => {
  it('eureka_stage_fail_once: 첫 단계 완료 요청은 보내지 않고 500, 다음부터는 그대로. 다른 요청은 영향 없음', async () => {
    const { base, hits } = await fakeRemote();
    const p = pocSetup(env('eureka_stage_fail_once'), ['--poc'], quiet);
    const post = () => p.eurekaFetch!(`${base}/flw-d1/_api_/stages/9/status`, { method: 'POST', body: '{}' });
    expect((await post()).status).toBe(500);
    expect(hits).toHaveLength(0);
    expect((await post()).status).toBe(200);
    expect((await p.eurekaFetch!(`${base}/flw-d1/_api_/items/0/list`)).status).toBe(200);
    expect(hits).toEqual(['POST /flw-d1/_api_/stages/9/status', 'GET /flw-d1/_api_/items/0/list']);
  });

  it('eureka_stage_slow: 단계 완료 요청만 늦게 보낸다', async () => {
    const { base } = await fakeRemote();
    const p = pocSetup(env('eureka_stage_slow', { DESKPET_POC_SLOW_MS: '120' }), ['--poc'], quiet);
    const t0 = Date.now();
    await p.eurekaFetch!(`${base}/flw-d1/_api_/stages/9/status`, { method: 'POST' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });

  it('github_approve_drop_once: 승인 요청은 실제로 보내고 응답만 버린다 (1회)', async () => {
    const { base, hits } = await fakeRemote();
    const p = pocSetup(env('github_approve_drop_once'), ['--poc'], quiet);
    await expect(p.githubFetch!(`${base}/repos/o/r/pulls/3/reviews`, { method: 'POST', body: '{}' })).rejects.toThrow(/dropped/);
    expect(hits).toEqual(['POST /repos/o/r/pulls/3/reviews']);
    expect((await p.githubFetch!(`${base}/repos/o/r/pulls/3/reviews`, { method: 'POST', body: '{}' })).status).toBe(200);
  });

  it('sensor_fail_once: 쓰기 판정 1회만 실패시킨다 (읽기는 그대로)', () => {
    const p = pocSetup(env('sensor_fail_once'), ['--poc'], quiet);
    const write = { gatewayResult: { mode: 'write' } } as unknown as SensorInput;
    expect(() => p.sensor!.inspect(write)).toThrow(/poc/);
  });
});
