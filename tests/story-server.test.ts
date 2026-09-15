import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createHostedApp } from '../apps/server/app.js';
import { loadHostedConfig } from '../apps/server/config.js';
import { ScenarioCatalog, ScenarioConfigError } from '../apps/server/scenario-catalog.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(resolve(tmpdir(), 'callpast-story-server-'));
  t.after(() => {
    if (
      dirname(directory) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('callpast-story-server-')
    )
      throw Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(resolve(directory, 'scenarios'));
  mkdirSync(resolve(directory, 'config'));
  for (const file of [
    'scenarios/story-catalog.json',
    'scenarios/mobile-playtest.json',
    'config/game-core.json',
  ])
    writeFileSync(resolve(directory, file), readFileSync(file));
  const scenarioPath = resolve(directory, 'scenarios/story-catalog.json');
  const coreConfigPath = resolve(directory, 'config/game-core.json');
  function time(seconds: number) {
    const value = JSON.parse(readFileSync(scenarioPath, 'utf8'));
    value.rules.totalTimeSeconds = seconds;
    writeFileSync(scenarioPath, JSON.stringify(value));
  }
  return { directory, scenarioPath, coreConfigPath, time };
}
const environment = {
  SCENARIO_PATH: 'scenarios/story-catalog.json',
  HOSTED_NO_ENV_FILE: '1',

  AI_MODE: 'mock',
};

test('catalog previews do not draw; all 18 new-play snapshots are immutable and locale-bound', (t) => {
  const f = fixture(t);
  let draws = 0;
  const catalog = new ScenarioCatalog({
    ...f,
    randomIndex: (count) => {
      assert.equal(count, 18);
      return draws++;
    },
  });
  catalog.validate();
  for (const locale of ['ja', 'en'] as const) {
    const preview = catalog.preview(locale);
    assert.equal(preview.obstacleCount, 3);
    assert.equal(preview.rules.totalTimeSeconds, 300);
    assert.deepEqual(Object.keys(preview).sort(), [
      'id',
      'obstacleCount',
      'playerBriefing',
      'rules',
      'title',
    ]);
  }
  assert.equal(draws, 0);
  const snapshots = Array.from({ length: 18 }, (_, index) =>
    catalog.current(index % 2 ? 'en' : 'ja'),
  );
  assert.equal(draws, 18);
  assert.equal(new Set(snapshots.map((s) => s.scenarioV2.id)).size, 18);
  for (const snapshot of snapshots) {
    assert.ok(snapshot.scenarioV2.story);
    assert.equal(snapshot.scenarioV2.obstacles.length, 3);
    assert.ok(Object.isFrozen(snapshot.scenarioV2.rules));
    assert.ok(Object.isFrozen(snapshot.scenarioV2.story));
  }
  assert.equal(snapshots[1].locale, 'en');
  assert.throws(() => {
    snapshots[0].scenarioV2.rules.totalTimeSeconds = 200;
  }, TypeError);
});

test('time edits affect only new snapshots; invalid updates refuse admission without changing an active snapshot', (t) => {
  const f = fixture(t);
  const catalog = new ScenarioCatalog({
    ...f,
    randomIndex: () => 0,
    playTtlMs: 600_000,
    lifecycleReserveMs: 132_000,
  });
  const active = catalog.current('ja');
  f.time(180);
  const next = catalog.current('ja');
  assert.equal(next.scenarioV2.rules.totalTimeSeconds, 180);
  assert.equal(active.scenarioV2.rules.totalTimeSeconds, 300);
  assert.notEqual(next.digest, active.digest);
  f.time(450);
  assert.equal(catalog.current('ja').scenarioV2.rules.totalTimeSeconds, 450);
  f.time(480);
  assert.throws(() => catalog.validate(), /SCENARIO_TIME_BUDGET/);
  assert.throws(() => catalog.current('ja'), ScenarioConfigError);
  assert.equal(active.scenarioV2.rules.totalTimeSeconds, 300);
});

test('server defaults to the story catalog, retains explicit v2 configuration and checks lifecycle time', (t) => {
  const f = fixture(t);
  const config = loadHostedConfig(environment, f.directory);
  assert.ok(config.scenarioCatalog!.current('en').scenarioV2.story);
  const legacy = loadHostedConfig(
    { ...environment, SCENARIO_PATH: 'scenarios/mobile-playtest.json' },
    f.directory,
  );
  assert.equal(legacy.scenarioCatalog!.current('ja').scenarioV2.story, undefined);
  f.time(480);
  assert.throws(() => loadHostedConfig(environment, f.directory), /SCENARIO_TIME_BUDGET/);
  f.time(300);
  assert.throws(
    () => loadHostedConfig({ ...environment, PLAY_TTL_SECONDS: '400' }, f.directory),
    /SCENARIO_TIME_BUDGET/,
  );
});

test('invalid random selection fails closed instead of falling back to a scene', (t) => {
  const f = fixture(t);
  for (const selected of [-1, 18, 1.5, NaN]) {
    const catalog = new ScenarioCatalog({ ...f, randomIndex: () => selected });
    assert.throws(() => catalog.current('ja'), ScenarioConfigError);
  }
});

test('HTTP bootstrap, duplicate creation, state reload and control takeover preserve the single initial draw', async (t) => {
  const f = fixture(t);
  const config = loadHostedConfig(environment, f.directory);
  let draws = 0;
  config.scenarioCatalog = new ScenarioCatalog({ ...f, randomIndex: () => draws++ });
  const hosted = createHostedApp(config);
  const server = hosted.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  config.allowedHosts.add(new URL(origin).host);
  config.allowedOrigins.add(origin);
  t.after(async () => {
    await hosted.dispose();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  let cookie = '',
    playId = '';
  async function request(path: string, body?: unknown) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-Play-Id': playId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return { response, data };
  }
  const bootstrap = await request('/api/bootstrap');
  assert.equal(draws, 0);
  assert.equal(bootstrap.data.scenario.obstacleCount, 3);
  const auth = await request('/api/auth', {});
  cookie = auth.response.headers.get('set-cookie')!.split(';')[0];
  const body = { requestId: randomUUID(), clientId: randomUUID(), locale: 'en' };
  const created = await request('/api/plays', body);
  playId = created.data.playId;
  const snapshot = hosted.registry.plays.get(playId)!.runtime!.coreSnapshot!;
  assert.equal(draws, 1);
  assert.equal(snapshot.locale, 'en');
  assert.equal((await request('/api/plays', body)).data.playId, playId);
  f.time(180);
  await request('/api/bootstrap');
  await request('/api/play/state');
  await request('/api/play/control', { clientId: randomUUID(), takeover: true });
  assert.equal(draws, 1);
  assert.equal(hosted.registry.plays.get(playId)!.runtime!.coreSnapshot, snapshot);
  assert.equal(snapshot.scenarioV2.rules.totalTimeSeconds, 300);
});
