import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import { errorResponse } from '../../packages/server/http.js';
import {
  createOpenAITransport,
  liveRequest,
  responseRequest,
  UpstreamError,
  type OpenAITransport,
} from './openai.js';
import type { RelayConfig } from './config.js';
export interface RelaySession {
  expiresAt: number;
  remaining: number;
  liveAttempts?: number;
  responseAttempts?: number;
  responseBusy?: boolean;
  liveBusy?: boolean;
}
interface Call {
  id: string;
  token: string;
  deadline: number;
  heartbeat: number;
  closing?: Promise<boolean>;
  attempts: number;
  closed: boolean;
}
export function installLiveRoutes(
  app: Express,
  config: RelayConfig,
  sessions: Map<string, RelaySession>,
  injected?: OpenAITransport,
) {
  if (config.mode !== 'live') return;
  const limits = config.live!;
  const upstream = injected ?? createOpenAITransport(config.apiKey!);
  const calls = new Map<string, Call>();
  let liveAttempts = 0,
    responseAttempts = 0,
    liveBusy = 0,
    responseBusy = 0,
    unknownCreates = 0;
  let shuttingDown = false;
  const pendingCreates = new Set<Promise<unknown>>();
  function authorize(
    req: Request,
    res: Response,
  ): { token: string; session: RelaySession } | undefined {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization') ?? '')?.[1];
    const session = token ? sessions.get(token) : undefined;
    if (!token || !session || session.expiresAt <= config.now()) {
      errorResponse(res, 401, 'SESSION_INVALID', '認証の有効期限が切れています。');
      return;
    }
    return { token, session };
  }
  function limit(res: Response) {
    errorResponse(
      res,
      429,
      'REQUEST_LIMIT',
      '利用上限または終了確認待ちです。運営に確認してください。',
    );
  }
  async function close(call: Call): Promise<boolean> {
    if (call.closed) return true;
    if (call.closing) return call.closing;
    call.closing = (async () => {
      while (call.attempts < 3) {
        call.attempts++;
        try {
          await upstream.hangup(call.id);
          call.closed = true;
          liveBusy--;
          const session = sessions.get(call.token);
          if (session) session.liveBusy = false;
          return true;
        } catch {
          /* Keep the concurrency reservation until closure is confirmed. */
        }
      }
      return false;
    })();
    return call.closing;
  }
  async function watchdog() {
    await Promise.all(
      [...calls.values()]
        .filter(
          (c) =>
            !c.closed &&
            (config.now() >= c.deadline ||
              config.now() - c.heartbeat >= limits.heartbeatMs ||
              !sessions.has(c.token) ||
              (sessions.get(c.token)?.expiresAt ?? 0) <= config.now()),
        )
        .map(close),
    );
  }
  const timer = setInterval(() => void watchdog(), 1000);
  timer.unref();
  app.locals.relayShutdown = async () => {
    shuttingDown = true;
    clearInterval(timer);
    await Promise.allSettled([...pendingCreates]);
    await Promise.all([...calls.values()].map(close));
  };
  app.locals.relayWatchdog = watchdog;
  app.locals.relayUnconfirmed = () =>
    unknownCreates + [...calls.values()].filter((c) => !c.closed && c.attempts >= 3).length;
  const guard = (req: Request, res: Response, next: () => void) => {
    if (shuttingDown) {
      errorResponse(res, 503, 'SHUTTING_DOWN', '中継サーバーは終了中です。');
      return;
    }
    if (authorize(req, res)) next();
  };
  app.post(
    '/v1/live/sessions',
    guard,
    express.json({ limit: '128kb', inflate: false }),
    async (req, res) => {
      const auth = authorize(req, res);
      if (!auth) return;
      const parsed = liveRequest.safeParse(req.body);
      if (!parsed.success || !limits.liveModels.includes(parsed.data.session.model)) {
        errorResponse(res, 400, 'INVALID_REQUEST', '音声接続の設定を確認してください。');
        return;
      }
      const s = auth.session;
      if (
        s.liveBusy ||
        (s.liveAttempts ?? 0) >= limits.tokenLiveAttempts ||
        liveAttempts >= limits.globalLiveAttempts ||
        liveBusy >= limits.globalLiveConcurrent
      ) {
        limit(res);
        return;
      }
      s.liveBusy = true;
      s.liveAttempts = (s.liveAttempts ?? 0) + 1;
      liveAttempts++;
      liveBusy++;
      const deadline = config.now() + limits.durationMs;
      const creation = upstream.createLiveSession(parsed.data);
      pendingCreates.add(creation);
      try {
        const answer = await creation;
        if (calls.has(answer.session.id)) throw new Error('Duplicate session');
        const call: Call = {
          id: answer.session.id,
          token: auth.token,
          deadline,
          heartbeat: config.now(),
          attempts: 0,
          closed: false,
        };
        calls.set(call.id, call);
        res.status(201).json(answer);
      } catch {
        unknownCreates++;
        errorResponse(
          res,
          502,
          'LIVE_CREATE_UNCONFIRMED',
          '音声接続の作成結果を確認できません。運営に確認してください。',
        );
      } finally {
        pendingCreates.delete(creation);
      }
    },
  );
  app.post(
    '/v1/responses',
    guard,
    express.json({ limit: '6mb', inflate: false }),
    async (req, res) => {
      const auth = authorize(req, res);
      if (!auth) return;
      const parsed = responseRequest.safeParse(req.body);
      if (
        !parsed.success ||
        !limits.responseModels.includes(parsed.data.model) ||
        parsed.data.max_output_tokens > limits.outputTokens
      ) {
        errorResponse(res, 400, 'INVALID_REQUEST', '認識要求の設定を確認してください。');
        return;
      }
      const s = auth.session;
      if (
        s.responseBusy ||
        (s.responseAttempts ?? 0) >= limits.tokenResponseAttempts ||
        responseAttempts >= limits.globalResponseAttempts ||
        responseBusy >= limits.globalResponseConcurrent
      ) {
        limit(res);
        return;
      }
      s.responseBusy = true;
      s.responseAttempts = (s.responseAttempts ?? 0) + 1;
      responseAttempts++;
      responseBusy++;
      try {
        res.json(await upstream.createResponse(parsed.data));
      } catch (e) {
        errorResponse(
          res,
          e instanceof UpstreamError ? e.status : 502,
          'UPSTREAM_FAILED',
          'AIへの接続に失敗しました。再試行してください。',
        );
      } finally {
        s.responseBusy = false;
        responseBusy--;
      }
    },
  );
  for (const operation of ['heartbeat', 'hangup'] as const)
    app.post(
      '/v1/live/:id/' + operation,
      guard,
      express.json({ limit: '32kb', inflate: false }),
      async (req, res) => {
        const auth = authorize(req, res);
        if (!auth) return;
        const call = calls.get(String(req.params.id));
        if (!call || call.token !== auth.token) {
          errorResponse(res, 404, 'NOT_FOUND', '接続が見つかりません。');
          return;
        }
        if (!z.object({}).strict().safeParse(req.body).success) {
          errorResponse(res, 400, 'INVALID_REQUEST', '送信内容を確認してください。');
          return;
        }
        if (operation === 'heartbeat') {
          if (
            call.closed ||
            call.closing ||
            config.now() >= call.deadline ||
            config.now() - call.heartbeat >= limits.heartbeatMs
          ) {
            await close(call);
            errorResponse(res, 410, 'LIVE_CLOSED', '音声接続が終了しています。');
            return;
          }
          call.heartbeat = config.now();
          res.json({ ok: true });
        } else if (await close(call)) res.json({ ok: true });
        else
          errorResponse(
            res,
            502,
            'HANGUP_UNCONFIRMED',
            '音声終了が未確認です。運営に確認してください。',
          );
      },
    );
}
