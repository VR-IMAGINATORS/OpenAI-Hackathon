import express, { type Request, type ErrorRequestHandler } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { baseApp, errorResponse } from '../../packages/server/http.js';
import { AiService, AiServiceError } from '../../packages/server/ai-service.js';
import type { OpenAITransport } from '../../packages/server/openai.js';
import { publicScenario } from '../../packages/shared/scenario.js';
import type { PublicGameState } from '../../packages/shared/game.js';
import { GameRuntime } from '../local-server/hosted-runtime.js';
import { GameError } from '../local-server/game.js';
import { liveEventSchema } from '../local-server/live.js';
import type { HostedConfig } from './config.js';
import { SessionStore } from './session-store.js';
import { PlayRegistry, type PlayRuntime } from './play-registry.js';
import { SessionError, assertController } from './control.js';
import { PhotoQueue } from './photo-queue.js';
import { operationalLog, type OperationalEvent } from './logging.js';

const uuid = z.string().uuid();
const createSchema = z.object({ requestId: uuid, clientId: uuid }).strict();
const liveSchema = z.object({ requestId: uuid, sdp: z.string().min(1).max(65536) }).strict();
const photoSchema = z
  .object({ requestId: uuid, images: z.array(z.string().max(2796204)).max(2) })
  .strict();
const heartbeatSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    voiceState: z.enum(['connecting', 'connected', 'disconnected', 'failed', 'closed']),
  })
  .strict();
const controlSchema = z.object({ clientId: uuid, takeover: z.boolean() }).strict();
const actionSchema = z
  .object({ actionId: uuid, proposalRevision: z.number().int().nonnegative() })
  .strict();
const eventSchema = z
  .object({ generation: z.number().int().nonnegative(), event: liveEventSchema })
  .strict();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
function cookieToken(req: Request): string | undefined {
  const cookies = (req.headers.cookie ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith('play_session='));
  if (cookies.length > 1) throw new SessionError('AUTH_REQUIRED', 401);
  return cookies[0]?.slice('play_session='.length);
}
function secretEquals(left: string, right: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(left), hash(right));
}

export function createHostedApp(
  config: HostedConfig,
  options: {
    transport?: OpenAITransport;
    now?: () => number;
    wallNow?: () => number;
    log?: (event: OperationalEvent) => void;
  } = {},
) {
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;
  const log = options.log ?? operationalLog;
  const bootId = randomUUID();
  const queue = new PhotoQueue();
  const disabledTransport: OpenAITransport = {
    async createLiveSession() {
      throw new Error('MOCK_AUDIO_DISABLED');
    },
    async createResponse() {
      throw new Error('MOCK_AI_DISABLED');
    },
    async hangup() {},
  };
  const ai = new AiService(
    config.ai,
    options.transport ?? (config.ai.mode === 'mock' ? disabledTransport : undefined),
    now,
  );
  const registry = new PlayRegistry<GameRuntime, PublicGameState>({
    now,
    wallNow,
    capacity: config.capacity,
    ttlMs: config.ttlMs,
    recoveryMs: config.recoveryMs,
    factory: (id, deadline) =>
      new GameRuntime(id, deadline, structuredClone(config.scenario), ai, config.ai, queue, now),
    expire: (r) => r.expire(),
    close: (r) => r.close(),
    snapshot: (r) => r.game.state(),
    dispose: (r) => r.dispose(),
    transferControl: (r) => r.transferControl(),
  });
  const sessions = new SessionStore({
    passphrase: config.passphrase,
    now,
    authAttemptsPerMinute: config.authAttempts,
    hasActivePlay: (s) => registry.hasActivePlay(s),
  });
  const app = baseApp();
  let draining: Promise<void> | undefined;
  let drainRequestId: string | undefined;
  let disposed = false;
  const liveRequests = new WeakMap<GameRuntime, Set<string>>();
  function status() {
    const counts = ai.snapshot();
    const remaining = Math.max(
      registry.occupied,
      counts.liveBusy + counts.pendingCreates + counts.responseBusy + counts.unknownCreates,
    );
    return {
      readyToDeploy: registry.admission === 'draining' && remaining === 0,
      version: config.version,
      bootId,
      remaining,
    };
  }
  function drain(): Promise<void> {
    if (draining) return draining;
    registry.admission = 'draining';
    log({ event: 'drain_started', version: config.version });
    draining = Promise.all([registry.drain(), ai.shutdown()]).then(() => {
      log({ event: 'drain_finished', version: config.version, count: status().remaining });
    });
    return draining;
  }
  async function runTick(waitForClose: boolean) {
    const work: Promise<void>[] = [registry.sweep(waitForClose)];
    for (const play of registry.plays.values()) {
      if (!play.runtime || ['closing', 'terminal', 'quarantined'].includes(play.lifecycle))
        continue;
      if (play.lifecycle === 'recovering') play.runtime.game.heartbeat('disconnected');
      play.runtime.game.check();
      if (now() >= play.runtime.closingAt) work.push(registry.end(play));
    }
    sessions.sweep();
    const completion = Promise.all(work);
    if (waitForClose) await completion;
    else
      void completion.catch(() => log({ event: 'watchdog_failed', errorCode: 'INTERNAL_ERROR' }));
  }
  let tickPromise: Promise<void> | undefined;
  let watchdogPromise: Promise<void> | undefined;
  function tick(): Promise<void> {
    if (!tickPromise)
      tickPromise = runTick(true).finally(() => {
        tickPromise = undefined;
      });
    return tickPromise;
  }
  const watchdog = setInterval(() => {
    // Classify every player's deadlines even while another provider close is pending.
    if (!watchdogPromise)
      watchdogPromise = runTick(false)
        .catch(() => log({ event: 'watchdog_failed', errorCode: 'INTERNAL_ERROR' }))
        .finally(() => {
          watchdogPromise = undefined;
        });
  }, 1000);
  watchdog.unref();
  async function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(watchdog);
    queue.dispose();
    await drain();
  }
  function owner(req: Request) {
    return sessions.authorize(cookieToken(req));
  }
  function playId(req: Request) {
    return uuid.parse(req.get('X-Play-Id'));
  }
  function credentials(req: Request) {
    return {
      clientId: uuid.parse(req.get('X-Client-Id')),
      epoch: z.coerce.number().int().positive().parse(req.get('X-Control-Epoch')),
    };
  }
  function controlled(req: Request) {
    const auth = owner(req);
    const id = playId(req);
    const { clientId, epoch } = credentials(req);
    return registry.assertControl(auth, id, clientId, epoch);
  }
  function update(play: PlayRuntime<GameRuntime, PublicGameState>) {
    const state = play.runtime?.game.state() ?? play.result;
    if (!state) throw new SessionError('PLAY_EXPIRED', 410);
    return {
      playId: play.id,
      state,
      lifecycle: play.lifecycle,
      expiresAt: play.expiresAt,
      recoveryExpiresAt:
        play.recoveryDeadline === null
          ? null
          : new Date(wallNow() + Math.max(0, play.recoveryDeadline - now())).toISOString(),
    };
  }
  function runtime(play: PlayRuntime<GameRuntime, PublicGameState>) {
    if (!play.runtime) throw new SessionError('PLAY_EXPIRED', 410);
    return play.runtime;
  }
  function validAfter(req: Request, play: PlayRuntime<GameRuntime, PublicGameState>) {
    const current = controlled(req);
    if (current !== play) throw new SessionError('PLAY_EXPIRED', 410);
  }
  app.use((_req, res, next) => {
    const startedAt = now();
    res.once('finish', () =>
      log({ event: 'request_finished', durationMs: Math.max(0, now() - startedAt) }),
    );
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ version: config.version, bootId }));
  app.use((req, res, next) => {
    if (!config.allowedHosts.has(req.headers.host ?? ''))
      return errorResponse(res, 403, 'HOST_FORBIDDEN', '接続先を確認してください。');
    if (
      !req.path.startsWith('/api/ops/') &&
      (req.get('Origin') !== undefined || !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) &&
      !config.allowedOrigins.has(req.get('Origin') ?? '')
    )
      return errorResponse(res, 403, 'ORIGIN_FORBIDDEN', 'この画面から操作できません。');
    next();
  });
  app.use('/api/ops', (req, res, next) => {
    if (req.get('Origin') !== undefined)
      return errorResponse(res, 403, 'OPS_FORBIDDEN', '管理操作を許可できません。');
    const bearer = req.get('Authorization') ?? '';
    if (
      !config.opsToken ||
      !bearer.startsWith('Bearer ') ||
      bearer.length > 1024 ||
      !secretEquals(bearer.slice(7), config.opsToken)
    )
      return errorResponse(res, 401, 'OPS_AUTH_REQUIRED', '管理認証が必要です。');
    next();
  });
  // Authenticate before buffering the larger photo payload.
  app.put('/api/play/photos', (req, _res, next) => {
    controlled(req);
    next();
  });
  app.use((req, res, next) => {
    const limit =
      req.method === 'PUT' && req.path === '/api/play/photos' ? 6 * 1024 * 1024 : 96 * 1024;
    express.json({ limit, strict: true, inflate: false })(req, res, next);
  });
  app.get('/api/bootstrap', (_req, res) =>
    res.json({
      app: { name: 'Call to the Past', stage: 'hosted-multiplayer' },
      scenario: publicScenario(config.scenario),
      auth: { required: true },
      ai: { mode: config.ai.mode },
    }),
  );
  app.post('/api/auth', (req, res) => {
    const body = z
      .object({ passphrase: z.string().min(1).max(256) })
      .strict()
      .parse(req.body);
    const auth = sessions.authenticate(body.passphrase, cookieToken(req));
    res.cookie('play_session', auth.token, {
      httpOnly: true,
      secure: config.secureCookie,
      sameSite: 'strict',
      path: '/',
      maxAge: 1_800_000 + config.ttlMs,
    });
    res.json({ authenticated: true });
  });
  app.get('/api/session', (req, res) => {
    const auth = owner(req);
    const play = auth.activePlayId ? registry.plays.get(auth.activePlayId) : undefined;
    const retained =
      play && (play.lifecycle !== 'terminal' || now() < (play.terminalUntil ?? 0))
        ? play
        : undefined;
    res.json({
      authenticated: true,
      playId: retained?.id ?? null,
      lifecycle: retained?.lifecycle ?? null,
      expiresAt: retained?.expiresAt ?? null,
    });
  });
  app.post('/api/plays', (req, res) => {
    const { play, reused } = registry.create(owner(req), createSchema.parse(req.body));
    if (!reused) log({ event: 'play_started', correlationId: play.id, count: registry.occupied });
    res.status(reused ? 200 : 201).json({ controlEpoch: play.controllerEpoch, ...update(play) });
  });
  app.get('/api/play/state', (req, res) => res.json(update(registry.get(owner(req), playId(req)))));
  app.post('/api/play/control', async (req, res) => {
    const body = controlSchema.parse(req.body);
    const play = await registry.control(owner(req), playId(req), body.clientId, body.takeover);
    res.json({ controlEpoch: play.controllerEpoch, ...update(play) });
  });
  app.post('/api/play/live', async (req, res) => {
    const play = controlled(req);
    const body = liveSchema.parse(req.body);
    if (config.ai.mode === 'mock' && !options.transport)
      throw new SessionError('LIVE_DISABLED', 409);
    try {
      const current = runtime(play);
      const seen = liveRequests.get(current) ?? new Set<string>();
      const reused = seen.has(body.requestId);
      const pending = current.live(body.requestId, body.sdp);
      seen.add(body.requestId);
      liveRequests.set(current, seen);
      const answer = await pending;
      validAfter(req, play);
      res.status(reused ? 200 : 201).json(answer);
    } catch (error) {
      if (error instanceof AiServiceError && error.code === 'LIVE_CREATE_UNCONFIRMED')
        void registry.end(play);
      throw error;
    }
  });
  app.post('/api/play/start', (req, res) => {
    const play = controlled(req);
    const commands = runtime(play).start();
    res.json({ ...update(play), commands });
  });
  app.put('/api/play/photos', async (req, res) => {
    const play = controlled(req);
    const body = photoSchema.parse(req.body);
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.once('close', onClose);
    try {
      await runtime(play).photos(body.requestId, body.images, abort.signal);
    } finally {
      res.off('close', onClose);
    }
    validAfter(req, play);
    res.json(update(play));
  });
  app.post('/api/play/events', async (req, res) => {
    const play = controlled(req);
    const body = eventSchema.parse(req.body);
    const commands = await runtime(play).event(body.generation, body.event);
    validAfter(req, play);
    res.json({ ...update(play), commands });
  });
  app.post('/api/play/actions', async (req, res) => {
    const play = controlled(req);
    const body = actionSchema.parse(req.body);
    const commands = await runtime(play).action(body.actionId, body.proposalRevision);
    validAfter(req, play);
    res.json({ ...update(play), commands });
  });
  app.post('/api/play/heartbeat', async (req, res) => {
    const play = controlled(req);
    const body = heartbeatSchema.parse(req.body);
    const r = runtime(play);
    if (body.generation !== r.game.generation) throw new SessionError('STALE_GENERATION', 409);
    const auth = owner(req);
    const { clientId, epoch } = credentials(req);
    registry.heartbeat(auth, play.id, clientId, epoch, body.voiceState);
    // A closed peer can be a page reload. Only /end explicitly ends a game.
    r.game.heartbeat(body.voiceState === 'closed' ? 'disconnected' : body.voiceState);
    if (['disconnected', 'failed', 'closed'].includes(body.voiceState)) {
      const confirmed = await ai.closeLive(play.id);
      if (!confirmed) await registry.end(play);
      else if (play.lifecycle !== 'terminal' && play.lifecycle !== 'quarantined')
        validAfter(req, play);
    }
    res.json(update(play));
  });
  app.post('/api/play/end', async (req, res) => {
    const play = registry.get(owner(req), playId(req));
    const { clientId, epoch } = credentials(req);
    assertController(play, clientId, epoch);
    await registry.end(play);
    log({ event: 'play_ended', correlationId: play.id, count: registry.occupied });
    res.json(update(play));
  });
  app.post('/api/ops/drain', (req, res) => {
    const body = z.object({ requestId: uuid, expectedVersion: sha }).strict().parse(req.body);
    if (body.expectedVersion !== config.version) throw new SessionError('VERSION_MISMATCH', 409);
    if (drainRequestId && drainRequestId !== body.requestId)
      throw new SessionError('DRAIN_ALREADY_STARTED', 409);
    drainRequestId = body.requestId;
    void drain();
    res.status(202).json(status());
  });
  app.get('/api/ops/drain', (_req, res) => res.json(status()));
  app.post('/api/ops/resume', (req, res) => {
    const body = z.object({ expectedVersion: sha, expectedBootId: uuid }).strict().parse(req.body);
    if (body.expectedVersion !== config.version || body.expectedBootId !== bootId)
      throw new SessionError('VERSION_MISMATCH', 409);
    if (!status().readyToDeploy || !ai.resume()) throw new SessionError('DRAIN_INCOMPLETE', 409);
    registry.resume();
    draining = undefined;
    drainRequestId = undefined;
    res.json(status());
  });
  app.use('/api', (_req, res) =>
    errorResponse(res, 404, 'NOT_FOUND', '指定された操作はありません。'),
  );
  app.use(express.static(config.webRoot));
  app.get('/', (_req, res) => res.sendFile(join(config.webRoot, 'index.html')));
  app.use((_req, res) => errorResponse(res, 404, 'NOT_FOUND', '指定されたページはありません。'));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    let status = 500,
      code = 'INTERNAL_ERROR';
    if (error instanceof SessionError || error instanceof AiServiceError) {
      status = error.status;
      code = error.code;
    } else if (error instanceof GameError) {
      status = error.status;
      code =
        status === 409
          ? 'PLAY_CONFLICT'
          : status === 410
            ? 'PLAY_EXPIRED'
            : status === 503
              ? 'PHOTO_BUSY'
              : 'GAME_REQUEST_FAILED';
    } else if (error instanceof z.ZodError) {
      status = 400;
      code = 'INVALID_REQUEST';
    } else if (error?.status === 413) {
      status = 413;
      code = 'BODY_TOO_LARGE';
    } else if (error?.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_REQUEST';
    }
    if (code === 'PLAY_CAPACITY') res.setHeader('Retry-After', '5');
    log({ event: 'request_failed', errorCode: code });
    const message =
      code === 'PLAY_CAPACITY'
        ? 'ただいま満員です。少し待って再試行してください。'
        : status === 410
          ? '体験が終了したか、セッションの期限が切れました。'
          : status === 401
            ? '合言葉を入力してください。'
            : status === 409
              ? '状態が変わりました。画面を確認して再試行してください。'
              : status === 503
                ? '更新または処理中です。少し待って再試行してください。'
                : '処理できませんでした。画面と接続状態を確認してください。';
    errorResponse(res, status, code, message);
  };
  app.use(errors);
  return { app, registry, ai, sessions, tick, drain, dispose, bootId };
}
