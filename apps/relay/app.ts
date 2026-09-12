import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { RelayHealth } from '../../packages/shared/api.js';
import { baseApp, errorResponse, finishApp, jsonBody, loginSchema } from '../../packages/server/http.js';
import type { RelayConfig } from './config.js';

interface Session { expiresAt: number; remaining: number }
export function createRelayApp(config: RelayConfig) {
  if (config.authMode !== 'none' && config.authMode !== 'required') throw new Error('Invalid relay auth mode');
  if (config.authMode === 'required' && !config.passphrase?.trim()) throw new Error('Relay passphrase required');
  for (const name of ['tokenTtlMs', 'tokenMaxRequests', 'maxSessions', 'maxRequests', 'authMaxAttempts', 'authWindowMs'] as const) {
    if (!Number.isSafeInteger(config[name]) || config[name] <= 0) throw new Error('Invalid relay limit: ' + name);
  }
  const app = baseApp();
  const sessions = new Map<string, Session>();
  let issued = 0;
  let requests = 0;
  let windowStarted = config.now();
  let authAttempts = 0;
  const expected = createHash('sha256').update(config.passphrase ?? '').digest();
  jsonBody(app);
  app.get('/health', (_req, res) => {
    const health: RelayHealth = { service: 'relay', mode: 'mock', authMode: config.authMode };
    res.json(health);
  });
  app.post('/v1/sessions', (req, res) => {
    const now = config.now();
    if (now - windowStarted >= config.authWindowMs) { windowStarted = now; authAttempts = 0; }
    if (authAttempts >= config.authMaxAttempts) {
      errorResponse(res, 429, 'AUTH_RATE_LIMIT', '認証の試行上限に達しました。しばらく待ってください。'); return;
    }
    authAttempts++;
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) { errorResponse(res, 400, 'INVALID_REQUEST', '送信内容を確認してください。'); return; }
    const supplied = createHash('sha256').update(parsed.data.passphrase ?? '').digest();
    if (config.authMode === 'required' && !timingSafeEqual(expected, supplied)) {
      errorResponse(res, 401, 'AUTH_FAILED', '合言葉を確認してください。'); return;
    }
    for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
    if (issued >= config.maxSessions || requests >= config.maxRequests) {
      errorResponse(res, 429, 'GLOBAL_LIMIT', '中継サーバーの利用上限に達しました。'); return;
    }
    const token = randomBytes(32).toString('hex');
    const expiresAt = now + config.tokenTtlMs;
    sessions.set(token, { expiresAt, remaining: config.tokenMaxRequests });
    issued++;
    res.json({ token, expiresAt });
  });
  app.post('/v1/diagnostics', (req, res) => {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization') ?? '');
    const token = match?.[1];
    const session = token ? sessions.get(token) : undefined;
    if (!token || !session || session.expiresAt <= config.now()) {
      if (token) sessions.delete(token);
      errorResponse(res, 401, 'SESSION_INVALID', '接続の有効期限が切れたか、認証されていません。'); return;
    }
    if (!z.object({}).strict().safeParse(req.body).success) {
      errorResponse(res, 400, 'INVALID_REQUEST', '送信内容を確認してください。'); return;
    }
    if (session.remaining <= 0 || requests >= config.maxRequests) {
      errorResponse(res, 429, 'REQUEST_LIMIT', '接続の利用上限に達しました。'); return;
    }
    session.remaining--;
    requests++;
    res.json({ kind: 'mock', message: '中継サーバーとのモック通信を確認しました。AIは呼び出していません。' });
  });
  finishApp(app);
  return app;
}
