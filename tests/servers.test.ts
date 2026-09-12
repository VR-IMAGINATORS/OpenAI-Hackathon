import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createLocalApp } from '../apps/local-server/app.js';
import { loadLocalConfig, type LocalConfig } from '../apps/local-server/config.js';
import { createRelayApp } from '../apps/relay/app.js';
import { loadRelayConfig, type RelayConfig } from '../apps/relay/config.js';

function relayConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return { ...loadRelayConfig({ FOUNDATION_DEMO: '1' }), ...overrides };
}
async function listen(t: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const port = (server.address() as AddressInfo).port;
  return { server, url: 'http://127.0.0.1:' + port, host: '127.0.0.1:' + port };
}
async function local(t: TestContext, relayUrl: string, overrides: Partial<LocalConfig> = {}) {
  const config = { ...loadLocalConfig({ FOUNDATION_DEMO: '1' }), relayUrl, ...overrides };
  const result = await listen(t, createLocalApp(config));
  config.allowedHosts.add(result.host);
  config.allowedOrigins.add(result.url);
  return result;
}
function post(url: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
async function token(url: string, passphrase?: string) {
  const response = await post(url + '/v1/sessions', passphrase === undefined ? {} : { passphrase });
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}
test('full local → required relay → mock path exposes no credentials or private scenario', async (t) => {
  const relay = await listen(t, createRelayApp(relayConfig()));
  const browser = await local(t, relay.url);
  const bootstrap = await fetch(browser.url + '/api/bootstrap');
  assert.equal(bootstrap.status, 200);
  const data = (await bootstrap.json()) as { relay: unknown; scenario: Record<string, unknown> };
  assert.deepEqual(data.relay, { reachable: true, authMode: 'required', mode: 'mock' });
  assert.equal('obstacles' in data.scenario, false);
  assert.equal('setting' in data.scenario, false);
  const wrong = await post(browser.url + '/api/connection', { passphrase: 'incorrect-secret' });
  assert.equal(wrong.status, 401);
  assert.doesNotMatch(await wrong.text(), /incorrect-secret|local-demo-only/);
  const result = await post(
    browser.url + '/api/connection',
    { passphrase: 'local-demo-only' },
    { origin: browser.url },
  );
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const raw = await result.text();
  assert.doesNotMatch(raw, /token|passphrase|local-demo-only|Bearer/);
  assert.deepEqual(JSON.parse(raw).path, ['browser', 'local', 'relay', 'mock']);
  assert.equal(JSON.parse(raw).kind, 'mock');
});
test('auth none still issues bounded authenticated sessions and honors expiry', async (t) => {
  let now = 1000;
  const relay = await listen(
    t,
    createRelayApp(
      relayConfig({ authMode: 'none', tokenTtlMs: 50, tokenMaxRequests: 1, now: () => now }),
    ),
  );
  const unauthenticated = await post(relay.url + '/v1/diagnostics');
  assert.equal(unauthenticated.status, 401);
  const value = await token(relay.url);
  const headers = { authorization: 'Bearer ' + value };
  assert.equal((await post(relay.url + '/v1/diagnostics', {}, headers)).status, 200);
  assert.equal((await post(relay.url + '/v1/diagnostics', {}, headers)).status, 429);
  now = 1050;
  assert.equal((await post(relay.url + '/v1/diagnostics', {}, headers)).status, 401);
});
test('global session count remains capped after token expiry', async (t) => {
  let now = 1000;
  const relay = await listen(
    t,
    createRelayApp(
      relayConfig({ authMode: 'none', maxSessions: 1, tokenTtlMs: 10, now: () => now }),
    ),
  );
  await token(relay.url);
  now = 2000;
  assert.equal((await post(relay.url + '/v1/sessions')).status, 429);
});
test('global request count applies across sessions', async (t) => {
  const relay = await listen(t, createRelayApp(relayConfig({ authMode: 'none', maxRequests: 1 })));
  const one = await token(relay.url);
  const two = await token(relay.url);
  assert.equal(
    (await post(relay.url + '/v1/diagnostics', {}, { authorization: 'Bearer ' + one })).status,
    200,
  );
  assert.equal(
    (await post(relay.url + '/v1/diagnostics', {}, { authorization: 'Bearer ' + two })).status,
    429,
  );
  assert.equal((await post(relay.url + '/v1/sessions')).status, 429);
});
test('auth attempts consume the fixed window and recover when the window elapses', async (t) => {
  let now = 100;
  const relay = await listen(
    t,
    createRelayApp(relayConfig({ authMaxAttempts: 2, authWindowMs: 20, now: () => now })),
  );
  assert.equal((await post(relay.url + '/v1/sessions', { passphrase: 'bad' })).status, 401);
  assert.equal((await post(relay.url + '/v1/sessions', { passphrase: 'bad' })).status, 401);
  assert.equal(
    (await post(relay.url + '/v1/sessions', { passphrase: 'local-demo-only' })).status,
    429,
  );
  now = 120;
  assert.equal(
    (await post(relay.url + '/v1/sessions', { passphrase: 'local-demo-only' })).status,
    200,
  );
});
test('Host and Origin are independently checked, with explicit dev proxy and CLI allowed', async (t) => {
  const browser = await local(t, 'http://127.0.0.1:1');
  assert.equal(
    (
      await fetch(browser.url + '/api/bootstrap', {
        headers: { host: 'evil.invalid', origin: 'http://evil.invalid' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(browser.url + '/api/bootstrap', { headers: { origin: 'https://evil.invalid' } }))
      .status,
    403,
  );
  assert.equal(
    (await fetch(browser.url + '/api/bootstrap', { headers: { origin: 'null' } })).status,
    403,
  );
  assert.equal(
    (
      await fetch(browser.url + '/api/bootstrap', {
        headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
      })
    ).status,
    200,
  );
  assert.equal((await fetch(browser.url + '/api/bootstrap')).status, 200);
});
test('invalid, oversized and arbitrary forwarding requests are rejected without reflecting payloads', async (t) => {
  const relay = await listen(t, createRelayApp(relayConfig()));
  const browser = await local(t, relay.url);
  for (const url of [relay.url + '/v1/sessions', browser.url + '/api/connection']) {
    const malformed = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"secret":',
    });
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(await malformed.text(), /secret/);
    assert.equal((await post(url, { passphrase: 'x'.repeat(40_000) })).status, 413);
    assert.equal(
      (await post(url, { passphrase: 'local-demo-only', url: 'https://arbitrary.invalid' })).status,
      400,
    );
  }
});
test('bootstrap reports unavailable and connection fails if relay is stopped', async (t) => {
  const relay = createServer();
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const port = (relay.address() as AddressInfo).port;
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  const browser = await local(t, 'http://127.0.0.1:' + port);
  const bootstrap = await fetch(browser.url + '/api/bootstrap');
  assert.deepEqual(((await bootstrap.json()) as { relay: unknown }).relay, {
    reachable: false,
    authMode: null,
    mode: null,
  });
  assert.equal((await post(browser.url + '/api/connection', {})).status, 502);
});
test('upstream errors and valid diagnostic messages never leak into browser output', async (t) => {
  const upstreamSecret = 'private-upstream-detail';
  const failure = await listen(t, (_req, res) => {
    res.statusCode = 500;
    res.end(upstreamSecret);
  });
  const browser = await local(t, failure.url);
  const response = await post(browser.url + '/api/connection');
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), new RegExp(upstreamSecret));
  const success = await listen(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/v1/sessions'
          ? { token: 'a'.repeat(64), expiresAt: Date.now() + 10000 }
          : { kind: 'mock', message: upstreamSecret },
      ),
    );
  });
  const second = await local(t, success.url);
  const result = await post(second.url + '/api/connection');
  assert.equal(result.status, 200);
  assert.doesNotMatch(await result.text(), new RegExp(upstreamSecret));
});
test('upstream redirects are rejected without contacting the redirect target', async (t) => {
  let redirected = 0;
  const target = await listen(t, (_req, res) => {
    redirected++;
    res.end('{}');
  });
  const relay = await listen(t, (_req, res) => {
    res.writeHead(302, { location: target.url });
    res.end();
  });
  const browser = await local(t, relay.url);
  assert.equal((await post(browser.url + '/api/connection')).status, 502);
  assert.equal(redirected, 0);
});
test('upstream bodies are bounded even when no content-length is supplied', async (t) => {
  const relay = await listen(t, (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.write('{"message":"');
    res.end('x'.repeat(40_000) + '"}');
  });
  const browser = await local(t, relay.url);
  const result = await post(browser.url + '/api/connection');
  assert.equal(result.status, 502);
});
test('one connection deadline includes both operations and stalled response body reads', async (t) => {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
  });
  const relay = await listen(t, (req, res) => {
    const timer = setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          req.url === '/v1/sessions'
            ? { token: 'b'.repeat(64), expiresAt: Date.now() + 10000 }
            : { kind: 'mock', message: 'ok' },
        ),
      );
    }, 90);
    timers.add(timer);
  });
  const browser = await local(t, relay.url, { timeoutMs: 150 });
  assert.equal((await post(browser.url + '/api/connection')).status, 504);
  const streaming = await listen(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  const second = await local(t, streaming.url, { timeoutMs: 80 });
  assert.equal((await post(second.url + '/api/connection')).status, 504);
  const bootstrap = await fetch(second.url + '/api/bootstrap');
  assert.equal(
    ((await bootstrap.json()) as { relay: { reachable: boolean } }).relay.reachable,
    false,
  );
});

test('invalid relay JSON and invalid response shapes are rejected without exposure', async (t) => {
  const secret = 'invalid-response-private-detail';
  const relay = await listen(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      req.url === '/health'
        ? JSON.stringify({ service: 'relay', mode: 'real', authMode: 'none', secret })
        : '{' + secret,
    );
  });
  const browser = await local(t, relay.url);
  const bootstrap = await fetch(browser.url + '/api/bootstrap');
  const bootstrapBody = await bootstrap.text();
  assert.equal(JSON.parse(bootstrapBody).relay.reachable, false);
  assert.doesNotMatch(bootstrapBody, new RegExp(secret));
  const result = await post(browser.url + '/api/connection');
  assert.equal(result.status, 502);
  assert.doesNotMatch(await result.text(), new RegExp(secret));

  const invalidSession = await listen(t, (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ token: secret, expiresAt: Date.now() + 10000 }));
  });
  const second = await local(t, invalidSession.url);
  const secondResult = await post(second.url + '/api/connection');
  assert.equal(secondResult.status, 502);
  assert.doesNotMatch(await secondResult.text(), new RegExp(secret));
});
test('auth-none relay can be diagnosed through the local server without passphrase', async (t) => {
  const relay = await listen(t, createRelayApp(relayConfig({ authMode: 'none' })));
  const browser = await local(t, relay.url);
  const bootstrap = await fetch(browser.url + '/api/bootstrap');
  assert.equal(
    ((await bootstrap.json()) as { relay: { authMode: string } }).relay.authMode,
    'none',
  );
  assert.equal((await post(browser.url + '/api/connection', {})).status, 200);
});
