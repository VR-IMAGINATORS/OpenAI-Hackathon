import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { loadHostedConfig } from '../apps/server/config.js';
import { createHostedApp } from '../apps/server/app.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import {
  ScenarioCatalog,
  readConfigJson,
  ScenarioConfigError,
} from '../apps/server/scenario-catalog.js';
import { publicScenarioV2 } from '../packages/shared/scenario.js';
function fixture(t: TestContext) {
  const dir = mkdtempSync(resolve(tmpdir(), 'core-catalog-'));
  t.after(() => {
    if (dirname(dir) !== resolve(tmpdir()) || !basename(dir).startsWith('core-catalog-'))
      throw Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  });
  const scenarioPath = resolve(dir, 'scenario.json'),
    coreConfigPath = resolve(dir, 'core.json');
  writeFileSync(scenarioPath, readFileSync('scenarios/mobile-playtest.json'));
  writeFileSync(coreConfigPath, readFileSync('config/game-core.json'));
  return {
    scenarioPath,
    coreConfigPath,
    catalog: new ScenarioCatalog({ scenarioPath, coreConfigPath, now: () => 123 }),
  };
}
test('catalog reloads new play settings but old deep-frozen snapshots remain unchanged', (t) => {
  const { catalog, scenarioPath } = fixture(t);
  const first = catalog.current('ja');
  assert.equal(first.createdAt, 123);
  assert.ok(Object.isFrozen(first.scenarioV2.obstacles[0]));
  assert.throws(() => {
    first.scenarioV2.title.ja = 'mutated';
  }, TypeError);
  assert.equal(first.digest, catalog.current('ja').digest);
  assert.notEqual(first.digest, catalog.current('en').digest);
  const changed = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  changed.title.ja = '次のプレイから反映';
  writeFileSync(scenarioPath, JSON.stringify(changed));
  const second = catalog.current('ja');
  assert.notEqual(first.digest, second.digest);
  assert.notEqual(first.scenarioV2.title.ja, second.scenarioV2.title.ja);
  const publicJson = JSON.stringify(publicScenarioV2(second.scenarioV2));
  for (const key of ['goal', 'judgmentPolicy', 'allowedTransitions', 'characterAppearance'])
    assert.equal(publicJson.includes('"' + key + '"'), false);
});
test('invalid, oversized or legacy configuration fails admission without modifying old snapshot', (t) => {
  const { catalog, scenarioPath, coreConfigPath } = fixture(t);
  const first = catalog.current('ja');
  writeFileSync(coreConfigPath, '{broken');
  assert.throws(() => catalog.current('ja'), ScenarioConfigError);
  assert.equal(first.createdAt, 123);
  writeFileSync(coreConfigPath, readFileSync('config/game-core.json'));
  writeFileSync(scenarioPath, ' '.repeat(256 * 1024 + 1));
  assert.throws(() => catalog.current('ja'), ScenarioConfigError);
  assert.throws(() => readConfigJson(scenarioPath), /CONFIG_SIZE/);
  writeFileSync(scenarioPath, readFileSync('scenarios/default.json'));
  assert.throws(() => catalog.current('ja'), ScenarioConfigError);
});
test('catalog validates per-play image budget and rejects undeclared language', (t) => {
  const { scenarioPath, coreConfigPath, catalog } = fixture(t);
  const small = new ScenarioCatalog({
    scenarioPath,
    coreConfigPath,
    maxGenerationAttemptsPerPlay: 1,
  });
  assert.throws(() => small.current('ja'), ScenarioConfigError);
  assert.throws(() => catalog.current('fr' as 'ja'), ScenarioConfigError);
});

test('HTTP new plays use edited settings; invalid config preserves existing game and request replay', async (t) => {
  const { catalog, scenarioPath } = fixture(t);
  const config = loadHostedConfig({
    HOSTED_NO_ENV_FILE: '1',
    APP_PASSPHRASE: 'catalog-test',
    AI_MODE: 'mock',
  });
  config.scenarioCatalog = catalog;
  const hosted = createHostedApp(config, { log: () => {} });
  const server = hosted.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  config.allowedHosts.add(new URL(origin).host);
  config.allowedOrigins.add(origin);
  t.after(async () => {
    await hosted.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function post(path: string, body: unknown, cookie = '') {
    return fetch(origin + path, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
  }
  async function auth() {
    return (await post('/api/auth', { passphrase: 'catalog-test' })).headers
      .get('set-cookie')!
      .split(';')[0];
  }
  const firstOwner = await auth(),
    secondOwner = await auth(),
    thirdOwner = await auth();
  const firstRequest = { requestId: randomUUID(), clientId: randomUUID() };
  assert.equal((await post('/api/plays', firstRequest, firstOwner)).status, 201);
  const first = [...hosted.registry.plays.values()][0].runtime!;
  const title = first.game.state().title;
  const changed = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  changed.title.ja = 'Updated new play';
  writeFileSync(scenarioPath, JSON.stringify(changed));
  assert.equal(
    (await post('/api/plays', { requestId: randomUUID(), clientId: randomUUID() }, secondOwner))
      .status,
    201,
  );
  const second = [...hosted.registry.plays.values()][1].runtime!;
  assert.equal(second.game.state().title, 'Updated new play');
  assert.equal(first.game.state().title, title);
  assert.notEqual(first.coreSnapshot!.digest, second.coreSnapshot!.digest);
  writeFileSync(scenarioPath, '{broken');
  assert.equal((await post('/api/plays', firstRequest, firstOwner)).status, 200);
  const denied = await post(
    '/api/plays',
    { requestId: randomUUID(), clientId: randomUUID() },
    thirdOwner,
  );
  assert.equal(denied.status, 503);
  assert.equal((await denied.json()).error.code, 'CONFIG_INVALID');
  assert.equal(hosted.registry.occupied, 2);
  assert.equal(first.game.state().title, title);
});
