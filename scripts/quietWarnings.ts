/**
 * 시작 화면 정리 (2026-11-14): Node 내장 SQLite의 ExperimentalWarning 한 줄만 숨긴다. 다른 경고는 그대로 출력한다.
 * server.ts에서 가장 먼저 import한다
 */
const defaults = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  for (const l of defaults) l(w);
});
export {};
