import { LlmError, type LlmClient } from '@deskpet/contracts';
import type { OutputModel, OutputModelInput } from '@deskpet/output';
import { OutputDraft } from './LangChainOutputModel.js';

/**
 * 공급자 중립 출력 모델: LlmClient(Gemini/OpenAI/원격) 위에서 {text, displayText, emotion}을 받는다.
 * 기본 출력 경로다. 공급자를 바꿔도 이 클래스는 그대로다.
 */
export const OUTPUT_JSON_SCHEMA = {
  name: 'deskpet_output',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'displayText', 'emotion'],
    properties: { text: { type: 'string' }, displayText: { type: 'string' }, emotion: { type: 'string' } },
  },
};

export class LlmOutputModel implements OutputModel {
  constructor(
    private readonly llm: LlmClient,
    private readonly o: { maxOutputTokens?: number; now?: () => number } = {},
  ) {}

  async generate(input: OutputModelInput): Promise<OutputDraft> {
    const now = this.o.now ?? (() => Date.now());
    const res = await this.llm.complete({
      purpose: 'output',
      instructions: input.instructions,
      input: input.prompt,
      jsonSchema: OUTPUT_JSON_SCHEMA,
      maxOutputTokens: this.o.maxOutputTokens ?? 300,
      deadlineAt: new Date(now() + input.deadlineMs).toISOString(),
    });
    const parsed = OutputDraft.safeParse(res.json);
    if (!parsed.success) throw new LlmError('invalid_output', 'output model returned an invalid draft');
    return parsed.data;
  }
}
