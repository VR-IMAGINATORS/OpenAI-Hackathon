import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { loadHostedConfig } from '../apps/server/config.js';
function fixture(t: TestContext) {
  const directory = mkdtempSync(resolve(tmpdir(), 'callpast-hosted-config-'));
  t.after(() => {
    if (
      dirname(directory) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('callpast-hosted-config-')
    )
      throw Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(resolve(directory, 'scenarios'));
  mkdirSync(resolve(directory, 'config'));
  writeFileSync(resolve(directory, 'config/game-core.json'), readFileSync('config/game-core.json'));
  writeFileSync(
    resolve(directory, 'scenarios/mobile-playtest.json'),
    readFileSync('scenarios/mobile-playtest.json'),
  );
  writeFileSync(
    resolve(directory, 'scenarios/story-catalog.json'),
    readFileSync('scenarios/story-catalog.json'),
  );
  return directory;
}
const base = { APP_PASSPHRASE: 'test-only', AI_MODE: 'mock' };
test('hosted config reads only .env.local and process settings win; production skips files', (t) => {
  const cwd = fixture(t);
  // These are synthetic files in an isolated fixture, never the repository private env.
  writeFileSync(resolve(cwd, '.env'), 'APP_PASSPHRASE=root-sentinel\nPORT=9999');
  writeFileSync(resolve(cwd, '.env.relay.local'), 'APP_PASSPHRASE=relay-sentinel\nPORT=9998');
  assert.throws(() => loadHostedConfig({}, cwd), /APP_PASSPHRASE/);
  writeFileSync(resolve(cwd, '.env.local'), 'APP_PASSPHRASE=local-sentinel\nPORT=4320');
  assert.equal(loadHostedConfig({}, cwd).port, 4320);
  assert.equal(loadHostedConfig({ ...base, PORT: '4321' }, cwd).port, 4321);
  const prod = loadHostedConfig(
    {
      ...base,
      NODE_ENV: 'production',
      PUBLIC_APP_URL: 'https://game.example',
      OPS_TOKEN: 'a'.repeat(32),
    },
    cwd,
  );
  assert.equal(prod.port, 4310);
  assert.equal(prod.secureCookie, true);
  assert.equal(prod.passphrase, 'test-only');
});
test('hosted authentication/limits fail closed and production requires HTTPS and operations key', (t) => {
  const cwd = fixture(t);
  assert.throws(() => loadHostedConfig({ APP_PASSPHRASE: ' ' }, cwd), /APP_PASSPHRASE/);
  for (const key of [
    'PORT',
    'MAX_PLAYERS',
    'PLAY_TTL_SECONDS',
    'RECOVERY_GRACE_SECONDS',
    'AUTH_ATTEMPTS_PER_MINUTE',
  ])
    for (const value of ['', '0', '-1', 'NaN', '1.5', ' 2', '999999999999999999999'])
      assert.throws(() => loadHostedConfig({ ...base, [key]: value }, cwd), new RegExp(key));
  assert.throws(() => loadHostedConfig({ ...base, NODE_ENV: 'production' }, cwd), /Production/);
  assert.throws(() => loadHostedConfig({ ...base, OPS_TOKEN: 'short' }, cwd), /OPS_TOKEN/);
  const config = loadHostedConfig(base, cwd);
  assert.equal(config.capacity, 5);
  assert.equal(config.ttlMs, 600000);
  assert.equal(config.recoveryMs, 60000);
});
test('hosted public URL and host/origin allowlists reject ambiguous and wildcard values', (t) => {
  const cwd = fixture(t);
  for (const value of [
    'http://example.com',
    'https://u:p@example.com',
    'https://example.com/path',
    'https://example.com/',
    'https://example.com/#x',
    'https://example.com?key=x',
  ])
    assert.throws(() => loadHostedConfig({ ...base, PUBLIC_APP_URL: value }, cwd));
  for (const value of [
    '',
    '*',
    'https://example.com',
    'user@example.com',
    'example.com/path',
    'example.com,',
  ])
    assert.throws(() => loadHostedConfig({ ...base, APP_ALLOWED_HOSTS: value }, cwd));
  for (const value of ['', '*', 'null', 'https://example.com/', 'https://u:p@example.com'])
    assert.throws(() => loadHostedConfig({ ...base, APP_ALLOWED_ORIGINS: value }, cwd));
  assert.throws(() => loadHostedConfig({ ...base, HOST: '*' }, cwd), /HOST/);
});
test('hosted invalid scenario reports the planner field location', (t) => {
  const cwd = fixture(t),
    path = resolve(cwd, 'scenarios/story-catalog.json');
  const scenario = JSON.parse(readFileSync(path, 'utf8'));
  scenario.rules.maxActions = 0;
  writeFileSync(path, JSON.stringify(scenario));
  assert.throws(() => loadHostedConfig(base, cwd), /"rules"[\s\S]*"maxActions"/);
});
