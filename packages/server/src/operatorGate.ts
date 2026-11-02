import type { EurekaOperatorConfirm, OperatorConfirm, OperatorVerdict } from '@deskpet/gateways';

/**
 * 운영자 확인 게이트 (서버 콘솔). GitHub·Eureka 쓰기를 서버 실행 옵션으로 켠 경우에만 쓴다.
 *
 * - Gateway가 DurableAck 전에 부른다 (감사 F-03). 정확히 `yes`를 입력해야 승인이고, 그 뒤 Gateway가 대상 상태를 다시
 *   확인한 다음에만 ack·전송한다.
 * - 응답 대기는 호출 deadline과 maxWaitMs 중 짧은 쪽으로 제한한다. 시간이 지나면 입력을 취소하고 timeout을 돌려준다.
 * - 클라이언트(파이프라인·데모)는 이 확인을 건너뛸 수 없다. 여러 요청이 동시에 와도 한 번에 하나씩 묻는다.
 *   앞 요청을 기다리는 시간도 각 요청의 deadline에 포함된다.
 */
export type OperatorPrompt = (lines: string[], question: string, signal: AbortSignal) => Promise<string>;

export interface ConsoleOperatorConfirmOptions {
  prompt: OperatorPrompt;
  now?: () => number;
  /** 한 번 묻는 최대 대기 시간 (기본 60초) */
  maxWaitMs?: number;
}

export class ConsoleOperatorConfirm implements OperatorConfirm {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly o: ConsoleOperatorConfirmOptions) {
    this.now = o.now ?? (() => Date.now());
  }

  confirm: OperatorConfirm['confirm'] = (cmd, c) =>
    this.confirmLines(
      ['⚠ 실제 GitHub 승인 요청을 보내려고 합니다.', `  저장소: ${cmd.repository.owner}/${cmd.repository.name}  PR: #${cmd.prNumber}`, `  커밋: ${cmd.commitId}  행위: ${cmd.event}`],
      c,
    );

  /** 대상 설명 줄을 보여 주고 yes를 기다린다 (GitHub·Eureka 공용) */
  confirmLines(lines: string[], c: { deadlineAt: string; signal?: AbortSignal }): Promise<OperatorVerdict> {
    const run = async (): Promise<OperatorVerdict> => {
      const waitMs = Math.min(Date.parse(c.deadlineAt) - this.now(), this.o.maxWaitMs ?? 60_000);
      if (!(waitMs > 0) || c.signal?.aborted) return 'timeout';
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), waitMs);
      const onAbort = () => ac.abort();
      c.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        // prompt가 signal을 무시해도 시간 초과로 끝나도록 경합시킨다
        const aborted = new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        aborted.catch(() => undefined);
        const typed = await Promise.race([
          aborted,
          this.o.prompt([...lines, `  ${Math.ceil(waitMs / 1000)}초 안에 답하지 않으면 보내지 않습니다.`], '  보내려면 yes를 입력하세요 (그 외 입력은 취소): ', ac.signal),
        ]);
        if (ac.signal.aborted) return 'timeout';
        return typed.trim() === 'yes' ? 'approved' : 'declined';
      } catch {
        return ac.signal.aborted ? 'timeout' : 'declined';
      } finally {
        clearTimeout(timer);
        c.signal?.removeEventListener('abort', onAbort);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Eureka 쓰기용 확인 (EurekaGateway.operatorConfirm) */
  forEureka(): EurekaOperatorConfirm {
    return {
      confirm: (w, c) =>
        this.confirmLines(['⚠ 실제 Eureka 쓰기 요청을 보내려고 합니다.', `  행위: ${w.action}  대상: ${w.target}`, `  요청: ${w.method} ${w.path} ${w.body ? JSON.stringify(w.body) : ''}`], c),
    };
  }
}
