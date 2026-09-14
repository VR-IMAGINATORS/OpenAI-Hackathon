import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEndingConfig } from '../packages/server/ending-config.js';
import { loadHostedConfig } from '../apps/server/config.js';

const enabled = {
  ENDING_VIDEO_ENABLED: 'true',
  FAL_KEY: 'sentinel-fal-private',
  AI_GLOBAL_VIDEO_ATTEMPTS: '10',
};
const hosted = {
  HOSTED_NO_ENV_FILE: '1',
  APP_PASSPHRASE: 'local-config-test',
  AI_MODE: 'mock',
};

test('ending is opt-in and disabled configuration retains no provider credential or budget', () => {
  const config = loadEndingConfig({ FAL_KEY: enabled.FAL_KEY });
  assert.equal(config.enabled, false);
  assert.equal(config.apiKey, undefined);
  assert.equal(config.globalAttempts, 0);
  assert.equal(config.timeoutMs, 480_000);
  assert.equal(config.concurrent, 2);
  assert.equal(loadHostedConfig(hosted).resultTtlMs, 300_000);
});

test('enabled ending requires an explicit key and bounded process budget', () => {
  for (const FAL_KEY of [undefined, '', ' '])
    assert.throws(() => loadEndingConfig({ ...enabled, FAL_KEY }), /FAL_KEY/);
  for (const AI_GLOBAL_VIDEO_ATTEMPTS of [undefined, '', '0', '-1', '1.1', '1001'])
    assert.throws(
      () => loadEndingConfig({ ...enabled, AI_GLOBAL_VIDEO_ATTEMPTS }),
      /AI_GLOBAL_VIDEO_ATTEMPTS/,
    );
  for (const ENDING_VIDEO_ENABLED of ['', '1', 'TRUE', 'yes'])
    assert.throws(() => loadEndingConfig({ ENDING_VIDEO_ENABLED }), /ENDING_VIDEO_ENABLED/);
  assert.equal(loadEndingConfig(enabled).globalAttempts, 10);
  assert.equal(
    loadEndingConfig({ ...enabled, AI_GLOBAL_VIDEO_ATTEMPTS: '1000' }).globalAttempts,
    1000,
  );
});

test('ending deadline, result lifetime, and concurrency reject unsafe combinations', () => {
  for (const ENDING_JOB_TIMEOUT_SECONDS of ['59', '541', '0', 'bad'])
    assert.throws(
      () => loadEndingConfig({ ...enabled, ENDING_JOB_TIMEOUT_SECONDS }),
      /ENDING_JOB_TIMEOUT_SECONDS/,
    );
  for (const ENDING_CONCURRENT of ['0', '3', '1.5'])
    assert.throws(() => loadEndingConfig({ ...enabled, ENDING_CONCURRENT }), /ENDING_CONCURRENT/);
  assert.equal(loadHostedConfig({ ...hosted, ...enabled }).resultTtlMs, 600_000);
  assert.equal(
    loadHostedConfig({ ...hosted, ...enabled, RESULT_TTL_SECONDS: '540' }).resultTtlMs,
    540_000,
  );
  assert.throws(
    () => loadHostedConfig({ ...hosted, ...enabled, RESULT_TTL_SECONDS: '539' }),
    /RESULT_TTL_SECONDS/,
  );
  assert.throws(
    () => loadHostedConfig({ ...hosted, ...enabled, RESULT_TTL_SECONDS: '601' }),
    /RESULT_TTL_SECONDS/,
  );
  const longest = loadHostedConfig({ ...hosted, ...enabled, ENDING_JOB_TIMEOUT_SECONDS: '540' });
  assert.equal(longest.ending?.timeoutMs, 540_000);
  assert.equal(longest.resultTtlMs, 600_000);
  const shortest = loadHostedConfig({
    ...hosted,
    ...enabled,
    ENDING_JOB_TIMEOUT_SECONDS: '60',
    ENDING_CONCURRENT: '1',
    RESULT_TTL_SECONDS: '150',
  });
  assert.equal(shortest.ending?.timeoutMs, 60_000);
  assert.equal(shortest.ending?.concurrent, 1);
  assert.equal(shortest.ai.mode, 'mock');
});
