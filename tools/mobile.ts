import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import QRCode from 'qrcode';
import { createHostedApp } from '../apps/server/app.js';

import { loadHostedConfig } from '../apps/server/config.js';
import { readEnvironment } from '../packages/server/config.js';
import { publicOrigin, startTunnel, stopTunnel } from './tunnel.js';

const servers: Server[] = [];
let child: ChildProcess | undefined;
let runtime: ReturnType<typeof createHostedApp> | undefined;
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  if (child) await stopTunnel(child);
  await runtime?.dispose().catch(() => {});
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  process.exitCode = code;
}
process.once('SIGINT', () => {
  void stop(0);
});
process.once('SIGTERM', () => {
  void stop(0);
});
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 45_000;
}
async function main() {
  const mock = process.argv.includes('--mock');
  const values: NodeJS.ProcessEnv = mock
    ? {
        AI_MODE: 'mock',
        APP_PASSPHRASE: 'local-demo-only',
        CLOUDFLARED_PATH: process.env.CLOUDFLARED_PATH,
      }
    : readEnvironment('.env.local', process.env, process.cwd());
  if (mock) console.log('画面確認用MOCK — 合言葉: local-demo-only / 音声AIには接続しません');
  const config = loadHostedConfig({
    ...values,
    HOST: '127.0.0.1',
    HOSTED_NO_ENV_FILE: '1',
  });
  readFileSync(config.webRoot + '/index.html');

  runtime = createHostedApp(config);

  await listen(runtime.app.listen(config.port, '127.0.0.1'));

  console.log('スマホ用HTTPS接続を準備しています…');
  let origin: string;
  if (values.PUBLIC_APP_URL) origin = publicOrigin(values.PUBLIC_APP_URL);
  else {
    const tunnel = await startTunnel(
      config.port,
      () => {
        if (!stopping) {
          console.error('トンネルが終了しました。');
          void stop(1);
        }
      },
      values.CLOUDFLARED_PATH,
    );
    child = tunnel.child;
    origin = tunnel.origin;
  }
  if (stopping) {
    if (child) await stopTunnel(child);
    return;
  }
  config.publicUrl = origin;
  config.secureCookie = true;
  config.allowedHosts.add(new URL(origin).host);
  config.allowedOrigins.add(origin);
  let ready = false;
  const readinessDeadline = performance.now() + 45_000;
  for (; performance.now() < readinessDeadline && !stopping; ) {
    try {
      const response = await fetch(origin + '/healthz', {
        signal: AbortSignal.timeout(4000),
        redirect: 'error',
      });
      const body = await response.text();
      if (response.ok && body.length < 1024 && JSON.parse(body).bootId === runtime.bootId) {
        ready = true;
        break;
      }
    } catch {
      /* DNS propagation and tunnel registration may take a moment. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready)
    throw new Error('HTTPSの接続確認に失敗しました。トンネルを通せる回線を確認してください。');
  console.log(await QRCode.toString(origin, { type: 'terminal', small: true }));
  console.log('スマホ参加URL: ' + origin);
  console.log('設定した共通の合言葉で参加してください。');
  console.log('終了: Ctrl+C。ゲームロジックはこのPCで動作します。');
}
main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : '起動に失敗しました。');
  await stop(1);
});
