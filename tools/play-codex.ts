import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostedApp } from '../apps/server/app.js';
import { loadHostedConfig } from '../apps/server/config.js';
import { CodexPlayerSessions } from './codex-poc/player-sessions.js';
import { failureMessage } from './codex-poc/binary.js';
import { PocError } from './codex-poc/rpc.js';

export function localCodexEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.NODE_ENV === 'production') throw new PocError('LOCAL_ONLY');
  return {
    ...env,
    NODE_ENV: 'development',
    AI_MODE: 'live',
    AI_PROVIDER: 'codex',
    OPENAI_API_KEY: '',
    FAL_KEY: '',
    ENDING_VIDEO_ENABLED: 'false',
    IMAGE_JOB_TIMEOUT_SECONDS: env.IMAGE_JOB_TIMEOUT_SECONDS ?? '300',
    AI_GLOBAL_LIVE_ATTEMPTS: env.AI_GLOBAL_LIVE_ATTEMPTS ?? '50',
    AI_GLOBAL_RESPONSE_ATTEMPTS: env.AI_GLOBAL_RESPONSE_ATTEMPTS ?? '1000',
    HOST: '127.0.0.1',
    PORT: '4310',
    PUBLIC_APP_URL: '',
    MAX_PLAYERS: '1',
    AI_RESPONSE_CONCURRENT_PER_PLAY: '1',
    APP_ALLOWED_HOSTS: '127.0.0.1:4310,localhost:4310',
    APP_ALLOWED_ORIGINS: 'http://127.0.0.1:4310,http://localhost:4310',
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length) throw new PocError('UNKNOWN_ARGUMENT');
  const config = loadHostedConfig(localCodexEnvironment(process.env));
  await access(resolve(config.webRoot, 'index.html'));
  console.log('ゲーム画面からプレイヤーがCodexログイン：ローカル同時1プレイ');
  console.log('音声診断版: game-voice-v4（停止要求・終了理由を表示）');
  console.log(
    `ゲーム判断=${config.ai.gameModel} / 音声=Codex Live・juniper / 画像=Codex組み込み（本人の認証）。APIキー不使用。動画・結末の追加生成は省略します。`,
  );
  const players = new CodexPlayerSessions({
    model: config.ai.gameModel,
    capacity: config.capacity,
    reportImage: (entry) =>
      console.log(
        `Codex画像: ${entry.status} / ${entry.durationMs}ms${entry.code ? ' / ' + entry.code : ''}`,
      ),
    reportVoice: (entry) => {
      console.log(`Codex音声: ${entry.status}${entry.code ? ' / ' + entry.code : ''}`);
      if (entry.detail) console.log(`Codex音声診断 v4 (${entry.phase}・伏字あり): ${entry.detail}`);
    },
    report: (entry) =>
      console.log(`Codex判断: ${entry.status} / ${entry.durationMs}ms / play=${entry.playId}`),
  });
  let runtime: ReturnType<typeof createHostedApp> | undefined;
  let server: ReturnType<ReturnType<typeof createHostedApp>['app']['listen']> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      server?.close();
      try {
        await runtime?.dispose();
      } finally {
        server?.closeAllConnections();
        await players.dispose();
        console.log('ゲームとCodexを終了し、専用認証・一時写真を破棄しました。');
      }
    })();
    return stopping;
  };
  const onSignal = () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    runtime = createHostedApp(config, {
      playerJudgments: players,
      transport: players.transport,
    });
    await new Promise<void>((ready, reject) => {
      server = runtime!.app.listen(config.port, config.host, () => ready());
      server.once('error', reject);
    });
    server!.headersTimeout = 10_000;
    server!.requestTimeout = 45_000;
    console.log('ゲーム: http://127.0.0.1:4310 （Ctrl+Cで終了）');
    await new Promise<void>((r) => server!.once('close', r));
  } finally {
    await stop();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.log(failureMessage(error));
    process.exitCode = 1;
  });
}
