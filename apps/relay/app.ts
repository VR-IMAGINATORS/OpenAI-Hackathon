import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { installLiveRoutes, type RelaySession } from './live.js';
import type { OpenAITransport } from './openai.js';
import type { RelayHealth } from '../../packages/shared/api.js';
import { baseApp, errorResponse, finishApp, jsonBody, loginSchema } from '../../packages/server/http.js';
import type { RelayConfig } from './config.js';


export function createRelayApp(config: RelayConfig, upstream?: OpenAITransport) {
  if (config.authMode !== 'none' && config.authMode !== 'required') throw new Error('Invalid relay auth mode');
  if (config.authMode === 'required' && !config.passphrase?.trim()) throw new Error('Relay passphrase required');
  for (const name of ['tokenTtlMs', 'tokenMaxRequests', 'maxSessions', 'maxRequests', 'authMaxAttempts', 'authWindowMs'] as const) {
    if (!Number.isSafeInteger(config[name]) || config[name] <= 0) throw new Error('Invalid relay limit: ' + name);
  }
  if(config.mode==='live'){
    if(!config.apiKey?.trim()||!config.live)throw new Error('Live credentials and limits required');
    for(const [name,value] of Object.entries(config.live))if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<=0))throw new Error('Invalid live limit '+name);
    if(!config.live.liveModels.length||!config.live.responseModels.length||config.live.outputTokens>1000||!config.authGlobalMaxAttempts)throw new Error('Invalid live limits');
  }
  const app = baseApp();
  const sessions = new Map<string, RelaySession>();
  let issued = 0;
  let requests = 0;
  let windowStarted = config.now();
  let authAttempts = 0;
  const expected = createHash('sha256').update(config.passphrase ?? '').digest();
  let totalAuthAttempts = 0;
  installLiveRoutes(app, config, sessions, upstream);
  jsonBody(app);
  app.get('/health', (_req, res) => {
    const health: RelayHealth = { service: 'relay', mode: config.mode ?? 'mock', authMode: config.authMode, ...(config.mode === 'live' ? { models: {live: config.live!.liveModels[0]!, responses: config.live!.responseModels[0]!} } : {}) };
    res.json(health);
  });
  app.post('/v1/sessions', (req, res) => {
    const now = config.now();
    if (now - windowStarted >= config.authWindowMs) { windowStarted = now; authAttempts = 0; }
    if (authAttempts >= config.authMaxAttempts || totalAuthAttempts >= (config.authGlobalMaxAttempts ?? Number.MAX_SAFE_INTEGER)) {
      errorResponse(res, 429, 'AUTH_RATE_LIMIT', '認証の試行上限に達しました。しばらく待ってください。'); return;
    }
    authAttempts++; totalAuthAttempts++;
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) { errorResponse(res, 400, 'INVALID_REQUEST', '送信内容を確認してください。'); return; }
    const supplied = createHash('sha256').update(parsed.data.passphrase ?? '').digest();
    if (config.authMode === 'required' && !timingSafeEqual(expected, supplied)) {
      errorResponse(res, 401, 'AUTH_FAILED', '合言葉を確認してください。'); return;
    }
    for (const [token, session] of sessions) if (session.expiresAt <= now && !session.liveBusy) sessions.delete(token);
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
