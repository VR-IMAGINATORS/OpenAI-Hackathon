import { createServerRuntime } from './runtime.js';
import { codexPreflight } from './codex-preflight.js';
import { loadHostedConfig } from './config.js';

const config = loadHostedConfig();
if (config.ai.provider === 'codex') await codexPreflight();
const runtime = createServerRuntime(config);
const server = runtime.app.listen(config.port, config.host, () => {
  console.log(
    `アプリ: ${config.publicUrl ?? `http://${config.host}:${config.port}`} (${config.ai.mode})`,
  );
});
server.headersTimeout = 10_000;
server.requestTimeout = 45_000;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await runtime.dispose();
  server.closeAllConnections();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
