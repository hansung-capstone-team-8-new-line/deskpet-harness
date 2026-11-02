import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from '@deskpet/contracts';

/**
 * 테스트·오프라인 데모용 LlmClient. 요청마다 준비된 응답 함수를 호출한다.
 * 응답 함수가 LlmError를 던지면 그대로 전달한다.
 */
export class ScriptedLlmClient implements LlmClient {
  readonly provider = 'scripted';
  readonly requests: LlmRequest[] = [];
  constructor(private readonly reply: (req: LlmRequest) => unknown | Promise<unknown>) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const v = await this.reply(req);
    if (req.jsonSchema) {
      if (typeof v === 'string') {
        try {
          return { text: v, json: JSON.parse(v), model: 'scripted' };
        } catch {
          throw new LlmError('invalid_output', 'response is not valid JSON');
        }
      }
      return { text: JSON.stringify(v), json: v, model: 'scripted' };
    }
    return { text: String(v), model: 'scripted' };
  }
}
