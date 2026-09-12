import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const withRelay = process.argv.includes('--with-relay');
const children: ChildProcess[] = [];
let stopping = false;

async function stop(exitCode: number) {
  if (stopping) return;
  stopping = true;
  const exits = children.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
    child.kill('SIGTERM');
  }));
  await Promise.race([Promise.all(exits), new Promise(resolve => setTimeout(resolve, 3000))]);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  process.exit(exitCode);
}
process.on('SIGINT', () => { void stop(0); });
process.on('SIGTERM', () => { void stop(0); });

function run(name: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, args, {
    stdio: 'inherit', shell: false,
    env: { ...process.env, FOUNDATION_DEMO: withRelay ? '1' : '0', ...extra },
  });
  children.push(child);
  child.once('error', () => { console.error(`${name}の起動に失敗しました。`); void stop(1); });
  child.once('exit', code => {
    if (!stopping) {
      console.error(`${name}が終了しました。他のプロセスも停止します。`);
      void stop(code === 0 ? 0 : 1);
    }
  });
}

if (withRelay) {
  console.log('LOCAL MOCK ONLY — 合言葉: local-demo-only / 外部AIへの通信なし');
  run('relay', ['--import', 'tsx', 'apps/relay/index.ts']);
}
run('local', ['--import', 'tsx', 'apps/local-server/index.ts'], { LOCAL_PORT: '4310', LOCAL_HOST: '127.0.0.1' });
run('web', [viteCli]);
console.log('開発画面: http://127.0.0.1:5173 （Ctrl+Cでまとめて停止）');
