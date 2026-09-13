import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const mock = process.argv.includes('--mock');
const children: ChildProcess[] = [];
let stopping = false;

async function stop(exitCode: number) {
  if (stopping) return;
  stopping = true;
  const exits = children.map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.once('error', () => resolve());
        child.kill('SIGTERM');
      }),
  );
  await Promise.race([Promise.all(exits), new Promise((resolve) => setTimeout(resolve, 3000))]);
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  process.exit(exitCode);
}
process.on('SIGINT', () => {
  void stop(0);
});
process.on('SIGTERM', () => {
  void stop(0);
});

function run(name: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...extra },
  });
  children.push(child);
  child.once('error', () => {
    console.error(`${name}の起動に失敗しました。`);
    void stop(1);
  });
  child.once('exit', (code) => {
    if (!stopping) {
      console.error(`${name}が終了しました。他のプロセスも停止します。`);
      void stop(code === 0 ? 0 : 1);
    }
  });
}

if (mock) console.log('画面確認用MOCK — 合言葉: local-demo-only / 音声AIには接続しません');
run('app', ['--import', 'tsx', 'apps/server/index.ts'], {
  HOST: '127.0.0.1',
  PORT: '4310',
  APP_ALLOWED_HOSTS: '127.0.0.1:4310,localhost:4310,127.0.0.1:5173,localhost:5173',
  APP_ALLOWED_ORIGINS:
    'http://127.0.0.1:4310,http://localhost:4310,http://127.0.0.1:5173,http://localhost:5173',
  ...(mock ? { HOSTED_NO_ENV_FILE: '1', AI_MODE: 'mock', APP_PASSPHRASE: 'local-demo-only' } : {}),
});
run('web', [viteCli]);
console.log('開発画面: http://127.0.0.1:5173 （Ctrl+Cでまとめて停止）');
