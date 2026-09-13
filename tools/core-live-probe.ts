import { config as loadEnv } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { AiService } from '../packages/server/ai-service.js';
import { createProbeApp } from './core-live-probe-server.js';

// Only this explicit switch enables paid calls. Never load the private root .env.
const live = process.argv.includes('--live');
if (live) loadEnv({ path: '.env.local', quiet: true });
const config = loadAiConfig(live ? { ...process.env, AI_MODE: 'live' } : { AI_MODE: 'mock' });
config.globalLiveAttempts = Math.min(config.globalLiveAttempts, 24);
config.globalResponseAttempts = Math.min(config.globalResponseAttempts, 96);
config.responsesPerPlay = Math.min(config.responsesPerPlay, 8);
config.liveAttemptsPerPlay = 1;
const port = 4312;
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(24).toString('hex');
const ai = live ? new AiService(config) : undefined;
const runtime = createProbeApp({
  origin,
  token,
  ai,
  liveModel: config.liveModel,
  responseModel: config.responseModel,
});
const server = runtime.app.listen(port, '127.0.0.1', () => {
  console.log(`P0検証: ${origin}/#${token}`);
  console.log(
    live
      ? '実API有効: 起動後最大24接続/96 Responses、各接続120秒。画面の開始操作で課金通信を開始します。'
      : '画面確認のみ。実APIを使う場合: npm run probe:live',
  );
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await runtime.stop();
  const closed = await ai?.shutdown();
  server.closeAllConnections();
  if (closed === false) console.error('上流の終了を確認できませんでした。');
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
