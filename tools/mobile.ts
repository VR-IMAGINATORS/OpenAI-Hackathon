import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import QRCode from 'qrcode';
import { createMobileApp } from '../apps/local-server/mobile-app.js';
import { createAdminApp } from '../apps/local-server/admin.js';
import { loadLocalConfig } from '../apps/local-server/config.js';
import { readEnvironment, positiveInteger } from '../packages/server/config.js';
import { publicOrigin, startTunnel, stopTunnel } from './tunnel.js';

const servers: Server[] = [];
let child: ChildProcess | undefined;
let runtime: ReturnType<typeof createMobileApp> | undefined;
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
  const values = readEnvironment('.env.local', process.env, process.cwd());
  const config = loadLocalConfig({
    ...values,
    LOCAL_HOST: '127.0.0.1',
    SCENARIO_PATH: values.SCENARIO_PATH ?? 'scenarios/mobile-playtest.json',
  });
  readFileSync(config.webRoot + '/index.html');
  const adminPort = positiveInteger(values, 'ADMIN_PORT', 4312, 65535);
  runtime = createMobileApp(config);
  const admin = createAdminApp(runtime.access, adminPort);
  await listen(runtime.app.listen(config.port, '127.0.0.1'));
  await listen(admin.app.listen(adminPort, '127.0.0.1'));
  console.log('スマホ用HTTPS接続を準備しています…');
  let origin: string;
  if (values.PUBLIC_GAME_URL) origin = publicOrigin(values.PUBLIC_GAME_URL);
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
  config.allowedHosts.add(new URL(origin).host);
  config.allowedOrigins.add(origin);
  let ready = false;
  for (let i = 0; i < 8 && !stopping; i++) {
    try {
      const response = await fetch(origin + '/health', {
        signal: AbortSignal.timeout(4000),
        redirect: 'error',
      });
      const body = await response.text();
      if (response.ok && body.length < 1024 && JSON.parse(body).nonce === runtime.nonce) {
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
  runtime.access.setOrigin(origin);
  const invite = runtime.access.issue()!;
  console.log(await QRCode.toString(invite.url, { type: 'terminal', small: true }));
  console.log('スマホ参加（5分・一度限り）: ' + invite.url);
  console.log('PC管理・QR再発行: http://127.0.0.1:' + adminPort + '/#admin=' + admin.initialToken);
  console.log('終了: Ctrl+C。ゲームロジックはこのPCで動作します。');
}
main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : '起動に失敗しました。');
  await stop(1);
});
