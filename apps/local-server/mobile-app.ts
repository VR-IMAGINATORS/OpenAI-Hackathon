import express from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { baseApp, finishApp } from '../../packages/server/http.js';
import { publicScenario } from '../../packages/shared/scenario.js';
import type { Bootstrap } from '../../packages/shared/api.js';
import type { LocalConfig } from './config.js';
import { PlayAccess, originGuard } from './play-session.js';
import { createPlayRouter } from './play-router.js';

export function createMobileApp(config: LocalConfig) {
  const game = createPlayRouter(config);
  const access = new PlayAccess(() => game.reset());
  const nonce = randomBytes(16).toString('hex');
  const app = baseApp();
  app.use(originGuard(config.allowedHosts, config.allowedOrigins));
  app.use((_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.get('/health', (_req, res) => res.json({ service: 'mobile-playtest', nonce }));
  app.get('/api/bootstrap', async (_req, res) => {
    const result: Bootstrap = {
      app: { name: 'Call to the Past', stage: 'mobile-playtest' },
      scenario: publicScenario(config.scenario),
      relay: { reachable: false, authMode: null, mode: null },
    };
    try {
      const response = await fetch(config.relayUrl + '/health', {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 4096) {
        await response.body?.cancel();
        throw new Error('health');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('health');
      let length = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > 4096) {
            await reader.cancel();
            throw new Error('health');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const health = z
        .object({
          service: z.literal('relay'),
          mode: z.enum(['live', 'mock']),
          authMode: z.enum(['required', 'none']),
          models: z
            .object({ live: z.string().max(100), responses: z.string().max(100) })
            .optional(),
        })
        .strict()
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      result.relay = { reachable: true, authMode: health.authMode, mode: health.mode };
    } catch {
      /* No upstream failure is represented as live success. */
    }
    res.json(result);
  });
  app.post('/api/play/claim', express.json({ limit: '2kb', inflate: false }), access.claim);
  app.use('/api/play', access.authorize, game.router);
  app.use(express.static(config.webRoot, { index: 'index.html', dotfiles: 'deny' }));
  finishApp(app);
  const expiry = setInterval(() => {
    void access.expire().catch(() => {});
  }, 1000);
  expiry.unref();
  return {
    app,
    access,
    nonce,
    async dispose() {
      clearInterval(expiry);
      try {
        await access.clear();
      } finally {
        await game.dispose();
      }
    },
  };
}
