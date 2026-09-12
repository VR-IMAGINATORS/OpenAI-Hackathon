import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { loadLocalConfig } from '../apps/local-server/config.js';
import { loadRelayConfig } from '../apps/relay/config.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(resolve(tmpdir(), 'callpast-config-'));
  t.after(() => {
    if (
      dirname(directory) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('callpast-config-')
    )
      throw new Error('Unsafe test cleanup');
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(resolve(directory, 'scenarios'));
  writeFileSync(
    resolve(directory, 'scenarios/default.json'),
    readFileSync('scenarios/default.json'),
  );
  return directory;
}
test('relay authentication defaults closed and rejects unsafe limits and auth values', (t) => {
  const cwd = fixture(t);
  assert.throws(() => loadRelayConfig({}, cwd), /RELAY_PASSPHRASE/);
  assert.throws(() => loadRelayConfig({ RELAY_AUTH_MODE: 'optional' }, cwd), /RELAY_AUTH_MODE/);
  for (const value of ['', '0', '-1', 'Infinity', 'NaN', '1.5', ' 2', '99999999999999999999']) {
    assert.throws(
      () => loadRelayConfig({ RELAY_AUTH_MODE: 'none', RELAY_MAX_REQUESTS: value }, cwd),
      /RELAY_MAX_REQUESTS/,
    );
  }
  assert.throws(() => loadRelayConfig({ RELAY_PASSPHRASE: ' ' }, cwd), /RELAY_PASSPHRASE/);
  assert.throws(
    () => loadRelayConfig({ RELAY_AUTH_MODE: 'none', RELAY_PORT: '65536' }, cwd),
    /RELAY_PORT/,
  );
  assert.equal(loadRelayConfig({ RELAY_AUTH_MODE: 'none' }, cwd).maxRequests, 1000);
});
test('each server loads only its designated env file and process settings win', (t) => {
  const cwd = fixture(t);
  writeFileSync(
    resolve(cwd, '.env'),
    'RELAY_AUTH_MODE=none\nRELAY_URL=https://root-secret.invalid\nLOCAL_PORT=7777',
  );
  assert.throws(() => loadRelayConfig({}, cwd), /RELAY_PASSPHRASE/);
  assert.equal(loadLocalConfig({}, cwd).relayUrl, 'http://127.0.0.1:4311');
  writeFileSync(
    resolve(cwd, '.env.local'),
    'LOCAL_PORT=4320\nRELAY_URL=https://local-config.invalid\nRELAY_AUTH_MODE=none',
  );
  writeFileSync(
    resolve(cwd, '.env.relay.local'),
    'RELAY_PASSPHRASE=relay-config-secret\nLOCAL_PORT=9999',
  );
  assert.equal(loadLocalConfig({}, cwd).port, 4320);
  assert.equal(loadRelayConfig({}, cwd).passphrase, 'relay-config-secret');
  assert.equal(loadRelayConfig({}, cwd).authMode, 'required');
  assert.equal(loadLocalConfig({ LOCAL_PORT: '4330' }, cwd).port, 4330);
  assert.equal(
    loadRelayConfig({ RELAY_PASSPHRASE: 'process-secret' }, cwd).passphrase,
    'process-secret',
  );
});
test('demo mode ignores all outside settings and does not read env files', (t) => {
  const cwd = fixture(t);
  // Directories deliberately make reading these names as env files fail if attempted.
  mkdirSync(resolve(cwd, '.env.local'));
  mkdirSync(resolve(cwd, '.env.relay.local'));
  const env = {
    FOUNDATION_DEMO: '1',
    RELAY_AUTH_MODE: 'none',
    RELAY_PASSPHRASE: 'outside',
    RELAY_HOST: '0.0.0.0',
    LOCAL_HOST: '0.0.0.0',
    LOCAL_PORT: '9000',
    RELAY_PORT: '9001',
    RELAY_URL: 'https://outside.invalid',
    SCENARIO_PATH: 'missing.json',
    LOCAL_ALLOWED_HOSTS: 'outside.invalid',
    LOCAL_ALLOWED_ORIGINS: 'https://outside.invalid',
    RELAY_MAX_REQUESTS: '999999',
    LOCAL_RELAY_TIMEOUT_MS: '1',
  };
  const relay = loadRelayConfig(env, cwd);
  const local = loadLocalConfig(env, cwd);
  assert.equal(relay.authMode, 'required');
  assert.equal(relay.passphrase, 'local-demo-only');
  assert.equal(relay.host, '127.0.0.1');
  assert.equal(relay.port, 4311);
  assert.equal(relay.maxRequests, 1000);
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.port, 4310);
  assert.equal(local.timeoutMs, 10000);
  assert.equal(local.relayUrl, 'http://127.0.0.1:4311');
  assert.equal(local.allowedHosts.has('outside.invalid'), false);
});
test('local URL and allowlist parsing rejects ambiguous or unsafe values', (t) => {
  const cwd = fixture(t);
  for (const url of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com/?key=secret',
    'https://example.com/#secret',
    'file:///tmp/test',
    'http://localhost.evil.invalid',
  ]) {
    assert.throws(() => loadLocalConfig({ RELAY_URL: url }, cwd), /RELAY_URL/);
  }
  assert.equal(
    loadLocalConfig({ RELAY_URL: 'https://relay.example.com/' }, cwd).relayUrl,
    'https://relay.example.com',
  );
  assert.equal(
    loadLocalConfig({ RELAY_URL: 'http://[::1]:4311' }, cwd).relayUrl,
    'http://[::1]:4311',
  );
  for (const value of [
    '',
    '*',
    'https://example.com',
    'user@example.com',
    'example.com/path',
    'example.com,',
  ]) {
    assert.throws(
      () => loadLocalConfig({ LOCAL_ALLOWED_HOSTS: value }, cwd),
      /LOCAL_ALLOWED_HOSTS/,
    );
  }
  for (const value of [
    '',
    '*',
    'null',
    'https://example.com/',
    'https://user@example.com',
    'https://example.com/path',
  ]) {
    assert.throws(
      () => loadLocalConfig({ LOCAL_ALLOWED_ORIGINS: value }, cwd),
      /LOCAL_ALLOWED_ORIGINS/,
    );
  }
  assert.throws(
    () => loadLocalConfig({ LOCAL_RELAY_TIMEOUT_MS: '0' }, cwd),
    /LOCAL_RELAY_TIMEOUT_MS/,
  );
  assert.throws(() => loadLocalConfig({ LOCAL_HOST: '*' }, cwd), /LOCAL_HOST/);
});
test('invalid scenario configuration reports a useful field location', (t) => {
  const cwd = fixture(t);
  const path = resolve(cwd, 'scenarios/default.json');
  const scenario = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  scenario.rules.maxActions = 0;
  writeFileSync(path, JSON.stringify(scenario));
  assert.throws(() => loadLocalConfig({}, cwd), /rules.maxActions/);
});
