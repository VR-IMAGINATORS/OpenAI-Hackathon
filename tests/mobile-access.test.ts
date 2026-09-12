import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import { PlayAccess, originGuard } from '../apps/local-server/play-session.js';
import { createAdminApp } from '../apps/local-server/admin.js';
import { parseTunnelUrl, publicOrigin } from '../tools/tunnel.js';
async function listen(app: ReturnType<typeof express>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('address');
  return { server, url: 'http://127.0.0.1:' + address.port, port: address.port };
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}
test('invitation is single-use and only the owning cookie can operate; expiry clears game', async (t) => {
  let now = 1000,
    resets = 0;
  const access = new PlayAccess(
    async () => {
      resets++;
    },
    () => now,
  );
  access.setOrigin('https://test.example');
  const invite = access.issue()!;
  const hosts = new Set(['test.example']);
  const app = express();
  app.use(originGuard(hosts, new Set(['https://test.example'])));
  app.use(express.json());
  app.post('/claim', access.claim);
  app.get('/state', access.authorize, (_req, res) => res.json({ ok: true }));
  const { server, url } = await listen(app);
  hosts.add(new URL(url).host);
  t.after(() => stop(server));
  const send = (path: string, body?: unknown, cookie?: string) =>
    fetch(url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        host: 'test.example',
        origin: 'https://test.example',
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const value = new URLSearchParams(new URL(invite.url).hash.slice(1)).get('invite');
  assert.equal((await send('/state')).status, 401);
  const claim = await send('/claim', { invite: value });
  assert.equal(claim.status, 200);
  const cookie = claim.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await send('/claim', { invite: value })).status, 409);
  assert.equal((await send('/state', undefined, cookie)).status, 200);
  now += 900001;
  assert.equal((await send('/state', undefined, cookie)).status, 401);
  assert.equal(resets, 1);
  assert.ok(access.issue());
});
test('cross-origin and originless writes rejected independently of cookies', async (t) => {
  const app = express();
  app.use(originGuard(new Set(['test.example']), new Set(['https://test.example'])));
  app.post('/', (_req, res) => res.json({ ok: true }));
  const { server, url } = await listen(app);
  t.after(() => stop(server));
  for (const origin of [undefined, 'https://evil.example']) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { host: 'test.example', ...(origin ? { origin } : {}) },
    });
    assert.equal(r.status, 403);
  }
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { host: 'evil.example', origin: 'https://test.example' },
      })
    ).status,
    403,
  );
});
test('reset blocks claims until cleanup completes and revokes old invitation', async () => {
  let release!: () => void;
  const access = new PlayAccess(() => new Promise<void>((r) => (release = r)));
  access.setOrigin('https://test.example');
  access.issue();
  const clearing = access.clear();
  assert.throws(() => access.issue(), /OCCUPIED/);
  release();
  await clearing;
  assert.equal(access.currentInvite(), null);
  assert.ok(access.issue());
});
test('tunnel URLs require exact HTTPS origins and strict provider suffix', () => {
  assert.equal(
    parseTunnelUrl('| https://little-green-bird.trycloudflare.com |'),
    'https://little-green-bird.trycloudflare.com',
  );
  for (const value of [
    'https://good.trycloudflare.com.evil.test',
    'https://good.trycloudflare.com/path',
    'https://good.trycloudflare.com?key=x',
  ])
    assert.equal(parseTunnelUrl(value), undefined);
  for (const value of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com/#x',
  ])
    assert.throws(() => publicOrigin(value));
  assert.equal(publicOrigin('https://example.com/'), 'https://example.com');
});
test('loopback admin requires one-time management authentication and returns a QR', async (t) => {
  const access = new PlayAccess(async () => {});
  access.setOrigin('https://test.example');
  access.issue();
  const root = express();
  const { server, url, port } = await listen(root);
  const admin = createAdminApp(access, port);
  root.use(admin.app);
  t.after(() => stop(server));
  const send = (path: string, body?: unknown, cookie?: string) =>
    fetch(url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: url, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal((await send('/api/admin/invite')).status, 401);
  const result = await send('/api/admin/claim', { token: admin.initialToken });
  assert.equal(result.status, 200);
  const cookie = result.headers.get('set-cookie')!;
  assert.equal((await send('/api/admin/claim', { token: admin.initialToken })).status, 401);
  const qr = await send('/api/admin/invite', undefined, cookie);
  assert.equal(qr.status, 200);
  const value = (await qr.json()) as { url: string; qr: string };
  assert.match(value.url, /^https:\/\/test.example\/#invite=/);
  assert.match(value.qr, /^data:image\/png;base64,/);
  assert.equal((await send('/api/admin/reset', {}, cookie)).status, 200);
  assert.equal(access.currentInvite(), null);
});
test('failed game cleanup keeps invitations blocked until a successful retry', async () => {
  let fail = true;
  const access = new PlayAccess(async () => {
    if (fail) throw Error('unconfirmed');
  });
  access.setOrigin('https://test.example');
  access.issue();
  await assert.rejects(access.clear());
  assert.throws(() => access.issue(), /OCCUPIED/);
  fail = false;
  await access.clear();
  assert.ok(access.issue());
});
