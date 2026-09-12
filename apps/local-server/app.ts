import express from 'express';
import { z } from 'zod';
import type { Bootstrap, ConnectionResult } from '../../packages/shared/api.js';
import { publicScenario } from '../../packages/shared/scenario.js';
import { relayUrl } from '../../packages/server/config.js';
import {
  BODY_LIMIT,
  baseApp,
  errorResponse,
  finishApp,
  jsonBody,
  loginSchema,
} from '../../packages/server/http.js';
import type { LocalConfig } from './config.js';

class RelayFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const healthSchema = z
  .object({
    service: z.literal('relay'),
    mode: z.literal('mock'),
    authMode: z.enum(['required', 'none']),
  })
  .strict();
const sessionSchema = z
  .object({ token: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().positive() })
  .strict();
const diagnosticSchema = z
  .object({ kind: z.literal('mock'), message: z.string().max(2000) })
  .strict();

async function readLimitedJson(response: globalThis.Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > BODY_LIMIT) {
    await response.body?.cancel();
    throw new Error('Relay response too large');
  }
  if (!response.body) throw new Error('Relay response missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > BODY_LIMIT) {
        await reader.cancel();
        throw new Error('Relay response too large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}
async function relayRequest(
  base: string,
  path: string,
  signal: AbortSignal,
  body?: unknown,
  token?: string,
): Promise<unknown> {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401)
      throw new RelayFailure(401, 'AUTH_FAILED', '合言葉または接続の有効期限を確認してください。');
    if (response.status === 429)
      throw new RelayFailure(429, 'RELAY_LIMIT', '中継サーバーの利用上限に達しました。');
    throw new RelayFailure(502, 'RELAY_UNAVAILABLE', '中継サーバーと通信できませんでした。');
  }
  return readLimitedJson(response);
}
export function createLocalApp(config: LocalConfig) {
  const base = relayUrl(config.relayUrl);
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 30_000)
    throw new Error('Invalid relay timeout');
  if (!config.allowedHosts.size || !config.allowedOrigins.size)
    throw new Error('Local allowlists cannot be empty');
  const app = baseApp();
  app.use((req, res, next) => {
    const host = req.get('host')?.toLowerCase();
    const origin = req.get('origin');
    if (
      !host ||
      !config.allowedHosts.has(host) ||
      (origin !== undefined && !config.allowedOrigins.has(origin))
    ) {
      errorResponse(res, 403, 'ORIGIN_DENIED', 'この接続元からの操作は許可されていません。');
      return;
    }
    next();
  });
  jsonBody(app);
  app.get('/api/bootstrap', async (_req, res) => {
    const result: Bootstrap = {
      app: { name: 'Call to the Past', stage: 'foundation' },
      scenario: publicScenario(config.scenario),
      relay: { reachable: false, authMode: null, mode: null },
    };
    try {
      const health = healthSchema.parse(
        await relayRequest(base, '/health', AbortSignal.timeout(config.timeoutMs)),
      );
      result.relay = { reachable: true, authMode: health.authMode, mode: health.mode };
    } catch {
      /* Relay failure is reported as unreachable, never a successful connection. */
    }
    res.json(result);
  });
  app.post('/api/connection', async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      errorResponse(res, 400, 'INVALID_REQUEST', '送信内容を確認してください。');
      return;
    }
    // One deadline covers authentication, diagnostics, and both response bodies.
    const signal = AbortSignal.timeout(config.timeoutMs);
    try {
      const session = sessionSchema.parse(
        await relayRequest(base, '/v1/sessions', signal, parsed.data),
      );
      diagnosticSchema.parse(
        await relayRequest(base, '/v1/diagnostics', signal, {}, session.token),
      );
      const result: ConnectionResult = {
        kind: 'mock',
        message:
          'ブラウザ→ローカル→中継→モックの通信を確認しました。実際のAIは呼び出していません。',
        path: ['browser', 'local', 'relay', 'mock'],
        scenarioId: config.scenario.id,
      };
      res.json(result);
    } catch (error) {
      if (signal.aborted)
        errorResponse(
          res,
          504,
          'RELAY_TIMEOUT',
          '中継サーバーの応答が時間内に完了しませんでした。',
        );
      else if (error instanceof RelayFailure)
        errorResponse(res, error.status, error.code, error.message);
      else errorResponse(res, 502, 'RELAY_UNAVAILABLE', '中継サーバーと通信できませんでした。');
    }
  });
  app.use(express.static(config.webRoot, { index: 'index.html', dotfiles: 'deny' }));
  finishApp(app);
  return app;
}
