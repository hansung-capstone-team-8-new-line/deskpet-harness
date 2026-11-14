/* eslint-disable no-console */
/**
 * pnpm start의 감시 프로세스 (D-50). Harness 서버(scripts/server.ts)를 자식으로 띄우고,
 * 서버가 업데이트 뒤 종료 코드 75로 끝나면 새 코드로 다시 띄운다. 그 밖의 종료는 그대로 따라 끝난다 (오류 때 무한 재시작 없음).
 *
 *   pnpm start [-- --web 등 서버 옵션]   # = pnpm web:build + 이 파일
 *
 * Ctrl+C는 자식 서버에도 전달되어 서버가 처리 중인 요청을 마치고 닫는다.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { RESTART_EXIT_CODE } from './restartCode.js';
import { APP_ROOT } from './wikiPath.js';

const server = resolve(APP_ROOT, 'scripts', 'server.ts');
const args = process.argv.slice(2);
let child: ChildProcess | undefined;
let stopping = false;
let restarts = 0;

function launch() {
  // 지금 실행 중인 node + tsx 설정(execArgv)을 그대로 써서, 새로 받은 코드를 처음부터 다시 읽는다
  child = spawn(process.execPath, [...process.execArgv, server, ...args], {
    cwd: APP_ROOT,
    stdio: 'inherit',
    env: { ...process.env, DESKPET_SUPERVISED: '1', ...(restarts > 0 ? { DESKPET_RESTARTED: String(restarts) } : {}) },
  });
  child.on('exit', (code, signal) => {
    if (code === RESTART_EXIT_CODE && !stopping) {
      restarts += 1;
      console.log(`\n[supervisor] 업데이트 적용 — 서버를 다시 시작합니다 (${restarts}회째)\n`);
      return void setTimeout(launch, 500);
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true;
    // 터미널 Ctrl+C는 같은 프로세스 그룹의 자식에게도 가므로, 여기서는 한 번 더 보내지 않아도 된다. SIGTERM(서비스 종료)만 전달
    if (sig === 'SIGTERM') child?.kill('SIGTERM');
  });
}

launch();
