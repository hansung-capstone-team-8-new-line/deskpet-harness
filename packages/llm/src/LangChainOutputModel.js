import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { LlmError } from '@deskpet/contracts';
/**
 * 출력 체인 어댑터 (기술 스택: 출력 모델 체인 — LangChain).
 * 기준 문장·필수 토큰·상태만 담은 프롬프트를 보내고 {text, displayText, emotion}을 받는다.
 * 결과는 OutputService가 다시 검증하며, 실패·시간 초과면 고정 문구를 쓴다.
 */
export const OutputDraft = z.object({
    text: z.string(),
    displayText: z.string(),
    emotion: z.string(),
});
export class LangChainOutputModel {
    runnable;
    constructor(runnable) {
        this.runnable = runnable;
    }
    static openai(o) {
        const chat = new ChatOpenAI({
            model: o.model,
            apiKey: o.apiKey,
            maxRetries: 0,
            maxTokens: o.maxOutputTokens ?? 300,
            ...(o.baseURL ? { configuration: { baseURL: o.baseURL } } : {}),
        });
        return new LangChainOutputModel(chat.withStructuredOutput(OutputDraft, { name: 'deskpet_output', strict: true }));
    }
    async generate(input) {
        let raw;
        try {
            raw = await this.runnable.invoke([
                ['system', input.instructions],
                ['human', input.prompt],
            ], input.deadlineMs <= 2_147_483_647 ? { signal: AbortSignal.timeout(Math.max(0, input.deadlineMs)) } : undefined);
        }
        catch (e) {
            if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))
                throw new LlmError('timeout', 'output model timed out');
            // 원문 메시지에는 요청 정보가 섞일 수 있어 오류 이름·상태 코드만 남긴다
            const status = e.status;
            const code = status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limited' : 'unavailable';
            throw new LlmError(code, `output model call failed (${e instanceof Error ? e.name : 'error'}${typeof status === 'number' ? ` ${status}` : ''})`);
        }
        const parsed = OutputDraft.safeParse(raw);
        if (!parsed.success)
            throw new LlmError('invalid_output', 'output model returned an invalid draft');
        return parsed.data;
    }
}
