import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { deploymentConfig } from '../tools/deploy.js';
import { loadHostedConfig } from '../apps/server/config.js';
import { createServerRuntime } from '../apps/server/runtime.js';

const settings = {
  DEPLOY_SHA: 'a'.repeat(40),
  LIGHTSAIL_SERVICE_NAME: 'game-dev',
  AWS_REGION: 'ap-northeast-1',
  PUBLIC_APP_URL: 'https://game-dev.example.ap-northeast-1.cs.amazonlightsail.com',
  OPS_TOKEN: 'test-operations-token-'.repeat(3),
  AI_GLOBAL_LIVE_ATTEMPTS: '50',
  AI_GLOBAL_RESPONSE_ATTEMPTS: '1000',
  AI_GLOBAL_IMAGE_ATTEMPTS: '100',
  AI_GLOBAL_INSPECTION_ATTEMPTS: '100',
};

test('subscription deployment requires no API secrets and discards supplied keys and video settings', () => {
  const deployment = deploymentConfig({
    ...settings,
    AI_PROVIDER: 'codex',
    OPENAI_API_KEY: 'unused-sentinel',
    FAL_KEY: 'unused-video-sentinel',
    ENDING_VIDEO_ENABLED: 'true',
  });
  assert.equal(deployment.environment.OPENAI_API_KEY, undefined);
  assert.equal(deployment.environment.FAL_KEY, undefined);
  assert.equal(deployment.environment.ENDING_VIDEO_ENABLED, 'false');
  assert.equal(deployment.environment.MAX_PLAYERS, '2');
  const config = loadHostedConfig(deployment.environment);
  assert.equal(config.ai.provider, 'codex');
  assert.equal(config.ai.apiKey, undefined);
  assert.equal(config.ai.gameModel, 'gpt-5.6-luna');
  assert.equal(config.ai.imageJobTimeoutMs, 300000);
  assert.equal(config.secureCookie, true);
  assert.throws(() => deploymentConfig(settings), /OPENAI_API_KEY/);
  assert.throws(() => deploymentConfig({ ...settings, AI_PROVIDER: 'other' }), /AI_PROVIDER/);
  assert.throws(
    () => loadHostedConfig({ ...deployment.environment, CODEX_POC_BIN: '' }),
    /CODEX_POC_BIN/,
  );
  assert.equal(
    deploymentConfig({ ...settings, OPENAI_API_KEY: 'api-test' }).environment.OPENAI_API_KEY,
    'api-test',
  );
});

test('production entry wiring exposes owned login and blocks unauthenticated play without spawning Codex', async (t) => {
  const config = loadHostedConfig(
    deploymentConfig({ ...settings, AI_PROVIDER: 'codex' }).environment,
  );
  const runtime = createServerRuntime(config);
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await runtime.dispose();
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.allowedHosts.add(new URL(origin).host);
  config.allowedOrigins.add(origin);
  const bootstrap = await (await fetch(origin + '/api/bootstrap')).json();
  assert.equal(bootstrap.ai.provider, 'codex');
  assert.equal(bootstrap.ai.playerLogin, 'codex');
  assert.equal((await fetch(origin + '/api/codex/status')).status, 401);
  const play = await fetch(origin + '/api/plays', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: randomUUID(),
      clientId: randomUUID(),
      locale: 'ja',
      difficulty: 'normal',
    }),
  });
  assert.equal(play.status, 401, await play.text());
});
