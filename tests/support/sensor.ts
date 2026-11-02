import type { SensorAssessment, SensorInput } from '@deskpet/contracts';
import { DeterministicSensor, type Sensor } from '@deskpet/harness';

/** 테스트용: 조건이 맞으면 센서 자체 오류(예외)를 낸다. 외부 결과와 무관한 판정 실패를 흉내 낸다 */
export class ControllableSensor implements Sensor {
  fail: ((i: SensorInput) => boolean) | null = null;
  calls = 0;
  private readonly inner = new DeterministicSensor();
  inspect(i: SensorInput): SensorAssessment {
    this.calls += 1;
    if (this.fail?.(i)) throw new Error('sensor boom');
    return this.inner.inspect(i);
  }
}
