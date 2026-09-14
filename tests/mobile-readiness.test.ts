import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMobileHost, waitForMobileHealth } from '../tools/mobile-readiness.js';

test('a cached DNS failure for a quick tunnel can recover through Cloudflare DNS', async () => {
  const address = await resolveMobileHost(
    'new-play.trycloudflare.com',
    new AbortController().signal,
    async () => {
      throw Object.assign(new Error('cached NXDOMAIN'), { code: 'ENOTFOUND' });
    },
    async (hostname) => {
      assert.equal(hostname, 'new-play.trycloudflare.com');
      return ['192.0.2.1'];
    },
  );
  assert.deepEqual(address, ['192.0.2.1']);
});

test('working system DNS is retained and custom hosts never use public DNS fallback', async () => {
  const unused = async () => {
    throw new Error('Public DNS must not be used');
  };
  assert.deepEqual(
    await resolveMobileHost(
      'new-play.trycloudflare.com',
      new AbortController().signal,
      async () => ['192.0.2.2'],
      unused,
    ),
    ['192.0.2.2'],
  );
  for (const hostname of ['private.example.com', 'play.trycloudflare.com.example.com']) {
    await assert.rejects(
      resolveMobileHost(
        hostname,
        new AbortController().signal,
        async () => {
          throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
        },
        unused,
      ),
      { code: 'ENOTFOUND' },
    );
  }
});

test('new tunnel DNS may become ready after the previous 45-second deadline', async () => {
  let time = 0;
  const progress: string[] = [];
  const result = await waitForMobileHealth('https://test.invalid', 'this-boot', {
    stopped: () => false,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    progress: (reason) => progress.push(reason),
    probe: async () => (time < 60_000 ? { ready: false, reason: 'dns' } : { ready: true }),
  });
  assert.equal(result.ready, true);
  assert.equal(time, 60_000);
  assert.ok(progress.length >= 3);
  assert.ok(progress.every((reason) => reason === 'dns'));
});

test('a persistent failure is bounded and retains the specific reason', async () => {
  let time = 0;
  const result = await waitForMobileHealth('https://test.invalid', 'this-boot', {
    stopped: () => false,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    progress() {},
    probe: async () => ({ ready: false, reason: 'wrong-server' }),
  });
  assert.deepEqual(result, { ready: false, reason: 'wrong-server' });
  assert.equal(time, 120_000);
});

test('stopping the launcher stops retries without reporting a successful connection', async () => {
  let stopped = false;
  let calls = 0;
  const result = await waitForMobileHealth('https://test.invalid', 'this-boot', {
    stopped: () => stopped,
    progress() {},
    sleep: async () => {
      throw new Error('Should not wait after stopping');
    },
    probe: async () => {
      calls++;
      stopped = true;
      return { ready: false, reason: 'connection' };
    },
  });
  assert.equal(result.ready, false);
  assert.equal(calls, 1);
});
