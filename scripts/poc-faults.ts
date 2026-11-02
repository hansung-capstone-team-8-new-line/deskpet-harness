/* eslint-disable no-console */
/**
 * POC용 장애 주입 (D-27). 실제 GitHub·Eureka에 붙은 상태에서 드문 실패를 일부러 만든다. 운영 코드(packages/)에는 넣지 않는다.
 *
 *   pnpm harness --allow-github-writes --allow-eureka-writes --poc
 *   .env  DESKPET_POC_FAULTS=eureka_stage_slow,eureka_stage_fail_once,github_approve_drop_once,sensor_fail_once
 *
 * 켜는 조건: --poc 플래그 + DESKPET_POC_FAULTS + Eureka 개발 환경(flw-d1). 하나라도 없으면 아무것도 주입하지 않는다.
 *
 * | 이름 | 하는 일 | 확인할 시나리오 |
 * | eureka_stage_slow | 단계 완료 요청을 DESKPET_POC_SLOW_MS(기본 5000)만큼 늦게 보낸다 (매번) | D-23 '진행 중' 응답 → 알림 |
 * | eureka_stage_fail_once | 단계 완료 요청 1회를 보내지 않고 500으로 돌려준다 (명시적 실패) | D-23 "다시 해줘" |
 * | github_approve_drop_once | 승인 요청 1회를 실제로 보낸 뒤 응답만 버린다 | S-07 unknown → 주기 복구가 조회만, 재전송 0 |
 * | sensor_fail_once | 쓰기 결과 판정 1회를 실패시킨다 (판정 대기) | D-24 복구 뒤 Eureka 후속 질문 |
 */
import type { SensorInput } from '@deskpet/contracts';
import { DeterministicSensor, type Sensor } from '@deskpet/harness';

export const POC_FAULTS = ['eureka_stage_slow', 'eureka_stage_fail_once', 'github_approve_drop_once', 'sensor_fail_once'] as const;
type Fault = (typeof POC_FAULTS)[number];

export interface PocSetup {
  enabled: boolean;
  faults: Fault[];
  githubFetch?: typeof fetch;
  eurekaFetch?: typeof fetch;
  sensor?: Sensor;
  banner: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const methodOf = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
const pathOf = (input: Parameters<typeof fetch>[0]) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;

export function pocSetup(env: Record<string, string | undefined>, argv: string[], log: (l: string) => void = (l) => console.log(l)): PocSetup {
  const requested = (env['DESKPET_POC_FAULTS'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!argv.includes('--poc')) {
    return { enabled: false, faults: [], banner: requested.length ? ['POC 장애 주입: 꺼짐 (DESKPET_POC_FAULTS가 있지만 --poc 플래그가 없음)'] : [] };
  }
  const base = (env['EUREKA_BASE_URL'] || 'https://api.eureka.codes/flw-d1').replace(/\/$/, '');
  if (!base.endsWith('/flw-d1')) return { enabled: false, faults: [], banner: ['POC 장애 주입: 거부 (Eureka 개발 환경 flw-d1에서만)'] };
  const unknown = requested.filter((x) => !(POC_FAULTS as readonly string[]).includes(x));
  if (unknown.length) throw new Error(`알 수 없는 DESKPET_POC_FAULTS: ${unknown.join(', ')} (가능: ${POC_FAULTS.join(', ')})`);
  const faults = requested as Fault[];
  if (!faults.length) return { enabled: false, faults: [], banner: ['POC 장애 주입: 켤 항목 없음 (DESKPET_POC_FAULTS 비어 있음)'] };

  const slowMs = Number(env['DESKPET_POC_SLOW_MS']) > 0 ? Number(env['DESKPET_POC_SLOW_MS']) : 5_000;
  const left = { eurekaFail: faults.includes('eureka_stage_fail_once') ? 1 : 0, githubDrop: faults.includes('github_approve_drop_once') ? 1 : 0, sensor: faults.includes('sensor_fail_once') ? 1 : 0 };

  const isStagePost = (input: Parameters<typeof fetch>[0], init?: RequestInit) => methodOf(init) === 'POST' && /\/_api_\/stages\/[^/]+\/status$/.test(pathOf(input));
  const eurekaFetch: typeof fetch | undefined =
    faults.includes('eureka_stage_slow') || left.eurekaFail
      ? async (input, init) => {
          if (isStagePost(input, init)) {
            if (left.eurekaFail > 0) {
              left.eurekaFail -= 1;
              log('[poc] eureka_stage_fail_once: 단계 완료 요청을 보내지 않고 500으로 돌려줍니다');
              return new Response(JSON.stringify({ message: 'poc injected failure' }), { status: 500, headers: { 'content-type': 'application/json' } });
            }
            if (faults.includes('eureka_stage_slow')) {
              log(`[poc] eureka_stage_slow: 단계 완료 요청을 ${slowMs}ms 늦게 보냅니다`);
              await sleep(slowMs);
            }
          }
          return fetch(input, init);
        }
      : undefined;

  const githubFetch: typeof fetch | undefined = left.githubDrop
    ? async (input, init) => {
        const isReviewPost = methodOf(init) === 'POST' && /\/pulls\/\d+\/reviews$/.test(pathOf(input));
        const res = await fetch(input, init);
        if (isReviewPost && left.githubDrop > 0) {
          left.githubDrop -= 1;
          await res.text().catch(() => undefined);
          log('[poc] github_approve_drop_once: 승인 요청은 보냈고 응답만 버립니다 (결과 불명)');
          throw new TypeError('poc: response dropped after send');
        }
        return res;
      }
    : undefined;

  const inner = new DeterministicSensor();
  const sensor: Sensor | undefined = left.sensor
    ? {
        inspect(i: SensorInput) {
          if (left.sensor > 0 && i.gatewayResult.mode === 'write') {
            left.sensor -= 1;
            log('[poc] sensor_fail_once: 이번 쓰기 결과 판정을 실패시킵니다 (판정 대기)');
            throw new Error('poc: sensor failure');
          }
          return inner.inspect(i);
        },
      }
    : undefined;

  return {
    enabled: true,
    faults,
    ...(githubFetch ? { githubFetch } : {}),
    ...(eurekaFetch ? { eurekaFetch } : {}),
    ...(sensor ? { sensor } : {}),
    banner: ['████ POC 장애 주입 켜짐 — 시험용 ████', `  ${faults.join(', ')}${faults.includes('eureka_stage_slow') ? ` (지연 ${slowMs}ms)` : ''}`],
  };
}
