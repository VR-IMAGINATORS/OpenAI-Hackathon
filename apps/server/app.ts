import sharp from 'sharp';
import { ResultStore, ResultStoreError } from './result-store.js';
import { SceneJobs } from './scene-jobs.js';
import { EndingJobs, type EndingJobsOptions } from './ending-jobs.js';
import express, { type Request, type ErrorRequestHandler } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { baseApp, errorResponse } from '../../packages/server/http.js';
import { AiService, AiServiceError } from '../../packages/server/ai-service.js';
import type { OpenAITransport } from '../../packages/server/openai.js';
import { localizeScenario, publicScenario } from '../../packages/shared/scenario.js';
import type { PublicGameState } from '../../packages/shared/game.js';
import { difficultySchema } from '../../packages/shared/difficulty.js';
import { GameRuntime } from '../local-server/hosted-runtime.js';
import { GameError } from '../local-server/game.js';
import { LiveOutboxError } from '../local-server/live-outbox.js';
import { liveEventSchema } from '../local-server/live.js';
import { voiceActivitySchema } from '../../packages/shared/harness.js';
import type { HostedConfig } from './config.js';
import { SessionStore } from './session-store.js';
import { PlayRegistry, type PlayRuntime } from './play-registry.js';
import { SessionError, assertController } from './control.js';
import { PhotoQueue } from './photo-queue.js';
import { ScenarioConfigError } from './scenario-catalog.js';
import { operationalLog, type OperationalEvent } from './logging.js';
import type { GameResponder, PlayerJudgments } from './player-judgments.js';

const uuid = z.string().uuid();
const createSchema = z
  .object({
    requestId: uuid,
    clientId: uuid,
    locale: z.enum(['ja', 'en']),
    difficulty: difficultySchema.optional(),
  })
  .strict();
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
    gameResponder?: GameResponder;
    playerJudgments?: PlayerJudgments;
    now?: () => number;
    wallNow?: () => number;
    log?: (event: OperationalEvent) => void;
    ending?: Omit<EndingJobsOptions, 'now'>;
  } = {},
) {
  if (config.ai.provider === 'codex' && (!options.playerJudgments || !options.transport))
    throw new Error('Subscription mode requires player authentication and transport');
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
    options.playerJudgments?.respond ?? options.gameResponder,
  );
  const clockOrigin = now(),
    wallOrigin = wallNow();
  const resultNow = () => wallOrigin + now() - clockOrigin;
  const sceneJobs = new SceneJobs(ai, {
    now,
    onFailure: (playId, stage, errorCode) =>
      log({ event: 'scene_failed', correlationId: playId, stage, errorCode }),
    onRecovery: (playId, stage, errorCode) =>
      log({ event: 'scene_recovery', correlationId: playId, stage, errorCode }),
  });
  let endingJobs: EndingJobs;
  const results = new ResultStore({
    now: resultNow,
    ttlMs: config.resultTtlMs ?? 300_000,
    maxEntryBytes: config.ending?.enabled ? 32 * 1024 * 1024 : undefined,
    onEvict: (id) => {
      sceneJobs.forgetPlay(id);
      endingJobs?.cancelPlay(id);
    },
  });
  endingJobs = new EndingJobs(
    ai,
    config.ending ?? {
      enabled: false,
      globalAttempts: 0,
      timeoutMs: 480_000,
      concurrent: 2,
    },
    results,
    {
      ...options.ending,
      now,
      onRecovery: (playId, stage, errorCode) => {
        log({ event: 'ending_recovery', correlationId: playId, stage, errorCode });
        options.ending?.onRecovery?.(playId, stage, errorCode);
      },
      onFailure: (playId, stage, errorCode, context) => {
        log({ event: 'ending_failed_' + stage, correlationId: playId, errorCode, ...context });
        options.ending?.onFailure?.(playId, stage, errorCode, context);
      },
    },
  );
  function safeDisplay(fn: () => void) {
    try {
      fn();
    } catch {
      /* Presentation capacity never rolls back a game action. */
    }
  }
  const registry = new PlayRegistry<GameRuntime, PublicGameState>({
    now,
    wallNow,
    capacity: config.capacity,
    ttlMs: config.ttlMs,
    recoveryMs: config.recoveryMs,
    resultTtlMs: config.resultTtlMs ?? 300_000,
    factory: (id, deadline, auth, request) => {
      options.playerJudgments?.bind(auth.digest, id);
      try {
        const snapshot = config.scenarioCatalog?.current(
          request.locale ?? 'ja',
          request.difficulty,
        );
        const scenario = snapshot
          ? localizeScenario(snapshot.scenarioV2, snapshot.locale)
          : structuredClone(config.scenario);
        if (!snapshot) return new GameRuntime(id, deadline, scenario, ai, config.ai, queue, now);
        results.create({
          playId: id,
          ownerDigest: auth.digest,
          locale: snapshot.locale,
          groupingGapMs: snapshot.coreConfig.chatGroupingGapMs,
          reserveEnding: true,
        });
        let openingSceneId: string | undefined;
        try {
          return new GameRuntime(
            id,
            deadline,
            scenario,
            ai,
            config.ai,
            queue,
            now,
            snapshot,
            {
              notice: (text, kind) =>
                safeDisplay(() => {
                  if (kind === 'opening-briefing' && openingSceneId) {
                    results.publishMessage(id, openingSceneId, text.slice(0, 4000));
                    return;
                  }
                  results.appendMessage(id, {
                    side: 'assistant',
                    kind: 'system',
                    text: text.slice(0, 4000),
                  });
                }),
              transcript: (fragment, messageId) =>
                safeDisplay(() => results.appendTranscript(id, fragment, messageId)),
              photos: async (photos) => {
                try {
                  const assetIds = [];
                  for (const photo of photos) {
                    const bytes = await sharp(photo.jpeg)
                      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
                      .jpeg({ quality: 70 })
                      .toBuffer();
                    assetIds.push(
                      await results.putAsset(id, { kind: 'photo', bytes, mime: 'image/jpeg' }),
                    );
                  }
                  if (assetIds.length)
                    results.appendMessage(id, { side: 'user', kind: 'photo', text: '', assetIds });
                } catch {
                  /* Recognition can continue even when a thumbnail cannot be retained. */
                }
              },
              scene: (input) =>
                safeDisplay(() => {
                  const deferDisplay = !!snapshot.scenarioV2.story && !!input.awaitTranscript;
                  if (deferDisplay) openingSceneId = input.messageId;
                  const deadlineIso = new Date(
                    resultNow() + (config.ai.imageJobTimeoutMs ?? 150_000),
                  ).toISOString();
                  const slot = {
                    status: 'queued' as const,
                    assetId: null,
                    errorCode: null,
                    deadline: deadlineIso,
                  };
                  results.appendMessage(
                    id,
                    {
                      id: input.messageId,
                      side: 'assistant',
                      // The initial scene belongs to the silent briefing. A system
                      // message also cannot absorb the call-check transcript deltas.
                      kind: deferDisplay ? 'system' : 'result',
                      text: input.awaitTranscript ? '' : input.text.slice(0, 4000),
                      relatedCommandSeq: input.commandSeq,
                      liveGeneration: input.generation,
                      imageSlot: slot,
                    },
                    { deferDisplay },
                  );
                  results.bindScene(id, input.messageId, input.gameVersion);
                  const fail = (
                    _errorCode = 'SCENE_RECEIVE_FAILED',
                    status: 'failed' | 'cancelled' = 'failed',
                  ) =>
                    safeDisplay(() =>
                      results.updateMessage(id, input.messageId, {
                        imageSlot: { ...slot, status, errorCode: 'SCENE_RECEIVE_FAILED' },
                      }),
                    );
                  try {
                    sceneJobs.enqueue(
                      {
                        playId: id,
                        messageId: input.messageId,
                        snapshot,
                        facts: input.facts,
                        situation: input.situation,
                        action: input.action,
                      },
                      {
                        ready: async (bytes) => {
                          try {
                            const assetId = await results.putAsset(id, {
                              kind: 'scene',
                              bytes,
                              mime: 'image/jpeg',
                            });
                            results.updateMessage(id, input.messageId, {
                              imageSlot: { ...slot, status: 'ready', assetId },
                            });
                          } catch {
                            log({
                              event: 'scene_failed',
                              correlationId: id,
                              stage: 'storage',
                              errorCode: 'SCENE_STORAGE_FAILED',
                            });
                            fail();
                          }
                        },
                        failed: fail,
                        stage: (stage) => {
                          // Inspection passed, but ready() must finish storing the asset first.
                          // Publish ready and its asset ID together in the callback above.
                          if (stage === 'ready') return;
                          safeDisplay(() =>
                            results.updateMessage(id, input.messageId, {
                              imageSlot: { ...slot, status: stage },
                            }),
                          );
                        },
                      },
                    );
                  } catch {
                    fail();
                  }
                }),
              ending: (packet, seal) => safeDisplay(() => endingJobs.enqueue(packet, seal)),
              ended: (state) =>
                safeDisplay(() => {
                  results.end(id, state);
                  if (state.status === 'expired') sceneJobs.cancelPlay(id, true);
                }),
            },
            config.enableGameTrace,
          );
        } catch (error) {
          results.evict(id);
          throw error;
        }
      } catch (error) {
        void options.playerJudgments?.release(id).catch(() => {});
        throw error;
      }
    },
    expire: (r) => r.expire(),
    close: async (r) => {
      try {
        return await r.close();
      } finally {
        await options.playerJudgments?.release(r.id);
      }
    },
    snapshot: (r) => r.state(),
    dispose: (r) => r.dispose(),
    transferControl: (r) => r.transferControl(),
    closeConfirmed: (playId) => ai.isLiveCloseConfirmed(playId),
  });
  const sessions = new SessionStore({
    now,
    authAttemptsPerMinute: config.authAttempts,
    hasActivePlay: (s) => registry.hasActivePlay(s),
    hasRetainedResult: (s) => results.hasOwner(s.digest),
  });
  const app = baseApp();
  let draining: Promise<void> | undefined;
  let drainRequestId: string | undefined;
  let disposed = false;
  const liveRequests = new WeakMap<GameRuntime, Set<string>>();
  function status() {
    registry.reconcileConfirmedClosures();
    const counts = ai.snapshot();
    const ending = endingJobs.snapshot();
    const blockers = {
      registryOccupied: registry.occupied,
      liveBusy: counts.liveBusy,
      pendingCreates: counts.pendingCreates,
      unknownCreates: counts.unknownCreates,
      unconfirmedLive: counts.unconfirmedLive,
      responseBusy: counts.responseBusy,
      imageBusy: counts.imageBusy ?? 0,
      inspectionBusy: counts.inspectionBusy ?? 0,
      endingJobs: ending.remaining,
    };
    const remaining =
      Math.max(
        blockers.registryOccupied,
        blockers.liveBusy +
          blockers.pendingCreates +
          blockers.responseBusy +
          blockers.unknownCreates +
          blockers.imageBusy +
          blockers.inspectionBusy,
      ) + blockers.endingJobs;
    return {
      readyToDeploy: registry.admission === 'draining' && remaining === 0,
      version: config.version,
      bootId,
      remaining,
      blockers,
    };
  }
  function drain(): Promise<void> {
    if (draining) return draining;
    registry.admission = 'draining';
    sceneJobs.cancelAll();
    log({ event: 'drain_started', version: config.version });
    draining = Promise.all([endingJobs.drain(), registry.drain(), ai.shutdown()]).then(() => {
      log({ event: 'drain_finished', version: config.version, count: status().remaining });
    });
    return draining;
  }
  async function runTick(waitForClose: boolean) {
    const work: Promise<void>[] = [registry.sweep(waitForClose)];
    if (options.playerJudgments) work.push(options.playerJudgments.sweep());
    for (const play of registry.plays.values()) {
      if (!play.runtime || ['closing', 'terminal', 'quarantined'].includes(play.lifecycle))
        continue;
      if (play.lifecycle === 'recovering') play.runtime.game.heartbeat('disconnected');
      play.runtime.game.check();
      if (now() >= play.runtime.closingAt) work.push(registry.end(play));
    }
    results.sweep();
    endingJobs.tick();
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
    try {
      await drain();
    } finally {
      await options.playerJudgments?.dispose();
    }
    results.clear();
    endingJobs.dispose();
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
  const requestPlays = new WeakMap<Request, string>();
  function controlled(req: Request) {
    const auth = owner(req);
    const id = playId(req);
    const { clientId, epoch } = credentials(req);
    // Only record a server-owned ID after its owner has been authenticated.
    requestPlays.set(req, registry.get(auth, id).id);
    return registry.assertControl(auth, id, clientId, epoch);
  }
  function update(play: PlayRuntime<GameRuntime, PublicGameState>) {
    const state = play.runtime?.state() ?? play.result;
    if (!state) throw new SessionError('PLAY_EXPIRED', 410);
    return {
      playId: play.id,
      resultRetainUntil: results.has(play.id) ? results.retainUntil(play.id) : null,
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
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/'))
      res.set({
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'X-Content-Type-Options': 'nosniff',
      });
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
      scenario: config.scenarioCatalog?.preview('ja') ?? publicScenario(config.scenario),
      supportedLocales: ['ja', 'en'],
      scenarios: config.scenarioCatalog
        ? Object.fromEntries(
            ['ja', 'en'].map((locale) => [
              locale,
              config.scenarioCatalog!.preview(locale as 'ja' | 'en'),
            ]),
          )
        : { ja: publicScenario(config.scenario), en: publicScenario(config.scenario) },
      auth: { required: false },
      ai: {
        mode: config.ai.mode,
        provider: config.ai.provider ?? 'api',
        ...(options.playerJudgments ? { playerLogin: 'codex' } : {}),
      },
    }),
  );
  app.post('/api/auth', (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const auth = sessions.createSession(cookieToken(req));
    res.cookie('play_session', auth.token, {
      httpOnly: true,
      secure: config.secureCookie,
      sameSite: 'strict',
      path: '/',
      maxAge: 1_800_000 + config.ttlMs + (config.resultTtlMs ?? 300_000),
    });
    res.json({ authenticated: true });
  });
  app.get('/api/session', (req, res) => {
    const auth = sessions.authorizeResult(cookieToken(req));
    const play = auth.activePlayId ? registry.plays.get(auth.activePlayId) : undefined;
    const retained =
      play &&
      (play.lifecycle !== 'terminal' ||
        (now() < (play.terminalUntil ?? 0) &&
          (!play.result?.automaticActions || results.has(play.id))))
        ? play
        : undefined;
    res.json({
      authenticated: true,
      playId: retained?.id ?? null,
      lifecycle: retained?.lifecycle ?? null,
      expiresAt: retained?.expiresAt ?? null,
    });
  });
  if (options.playerJudgments) {
    const judgments = options.playerJudgments;
    app.get('/api/codex/status', (req, res) => res.json(judgments.status(owner(req).digest)));
    app.post('/api/codex/login', (req, res) => {
      z.object({}).strict().parse(req.body);
      if (registry.admission !== 'open') throw new SessionError('DRAINING', 503);
      res.json(judgments.start(owner(req).digest));
    });
    app.post('/api/codex/logout', async (req, res) => {
      z.object({}).strict().parse(req.body);
      await judgments.logout(owner(req).digest);
      res.json({ status: 'disconnected' });
    });
  }
  app.post('/api/plays', (req, res) => {
    const body = config.scenarioCatalog
      ? createSchema.parse(req.body)
      : createSchema.omit({ locale: true, difficulty: true }).parse(req.body);
    const { play, reused } = registry.create(owner(req), body);
    if (!reused) log({ event: 'play_started', correlationId: play.id, count: registry.occupied });
    res.status(reused ? 200 : 201).json({ controlEpoch: play.controllerEpoch, ...update(play) });
  });
  app.get('/api/play/trace', (req, res) => {
    if (!config.enableGameTrace) throw new SessionError('NOT_FOUND', 404);
    const play = registry.get(owner(req), playId(req));
    res.json(play.runtime?.trace() ?? { entries: [] });
  });
  app.get('/api/play/feed', (req, res) => {
    const auth = sessions.authorizeResult(cookieToken(req));
    res.json(
      results.feed(
        auth.digest,
        playId(req),
        z.coerce
          .number()
          .int()
          .nonnegative()
          .parse(req.query.after ?? req.query.afterVersion ?? 0),
      ),
    );
  });
  app.get('/api/play/assets/:assetId', (req, res) => {
    const auth = sessions.authorizeResult(cookieToken(req));
    const asset = results.asset(auth.digest, playId(req), uuid.parse(req.params.assetId));
    res.type(asset.mime).send(asset.bytes);
  });
  function endingPlayId(req: Request) {
    const query = req.query.playId;
    const header = req.get('X-Play-Id');
    if (query !== undefined && header !== undefined && query !== header)
      throw new SessionError('INVALID_PLAY_ID', 400);
    return uuid.parse(query ?? header);
  }
  app.get('/api/play/ending', (req, res) => {
    const auth = sessions.authorizeResult(cookieToken(req));
    res.json(results.ending(auth.digest, endingPlayId(req)));
  });
  app.get('/api/play/ending/video', (req, res) => {
    const auth = sessions.authorizeResult(cookieToken(req));
    const id = endingPlayId(req);
    const download = z.literal('1').optional().parse(req.query.download);
    const bytes = results.endingVideo(auth.digest, id);
    if (download) res.attachment(`call-to-the-past-${id}.mp4`);
    res.set({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
    const range = req.get('Range');
    if (!range) {
      res.set('Content-Length', String(bytes.length));
      return res.send(bytes);
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = 0,
      end = bytes.length - 1;
    if (
      !match ||
      (!match[1] && !match[2]) ||
      [match[1], match[2]].some((n) => n && !Number.isSafeInteger(Number(n)))
    ) {
      res.set('Content-Range', `bytes */${bytes.length}`);
      return res.status(416).end();
    }
    if (!match[1]) start = Math.max(0, bytes.length - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      start >= bytes.length ||
      (!match[1] && Number(match[2]) <= 0)
    ) {
      res.set('Content-Range', `bytes */${bytes.length}`);
      return res.status(416).end();
    }
    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      'Content-Length': String(end - start + 1),
    });
    return res.send(bytes.subarray(start, end + 1));
  });
  app.get('/api/play/state', (req, res) => {
    const auth = sessions.authorizeResult(cookieToken(req)),
      id = playId(req);
    const play = registry.plays.get(id);
    if (play?.runtime) return res.json(update(registry.get(auth, id)));
    if (results.has(id)) {
      const state = results.result(auth.digest, id);
      if (state)
        return res.json({
          playId: id,
          state,
          lifecycle: 'terminal',
          expiresAt: play?.expiresAt ?? results.retainUntil(id),
          recoveryExpiresAt: null,
          resultRetainUntil: results.retainUntil(id),
        });
    }
    if (play?.result?.automaticActions) throw new SessionError('RESULT_EXPIRED', 410);
    res.json(update(registry.get(auth, id)));
  });
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
  const eventRates = new WeakMap<
    import('./session-store.js').AuthSession,
    { tokens: number; at: number }
  >();
  app.post('/api/play/events', async (req, res) => {
    const auth = owner(req);
    const rate = eventRates.get(auth) ?? { tokens: 80, at: now() };
    rate.tokens = Math.min(80, rate.tokens + Math.max(0, now() - rate.at) * 0.04);
    rate.at = now();
    eventRates.set(auth, rate);
    if (rate.tokens < 1) throw new SessionError('EVENT_RATE_LIMIT', 429);
    rate.tokens--;
    const play = controlled(req);
    const body = eventSchema.parse(req.body);
    const current = runtime(play);
    const commands = await current.event(body.generation, body.event);
    validAfter(req, play);
    if (current.coreSnapshot) res.status(202).json({ accepted: true });
    else res.json({ ...update(play), commands });
  });
  const voiceActivityRates = new WeakMap<
    import('./session-store.js').AuthSession,
    { tokens: number; at: number }
  >();
  app.post('/api/play/voice-activity', (req, res) => {
    const play = controlled(req);
    const auth = owner(req);
    const at = now();
    const rate = voiceActivityRates.get(auth) ?? { tokens: 8, at };
    rate.tokens = Math.min(8, rate.tokens + Math.max(0, at - rate.at) * 0.004);
    rate.at = at;
    voiceActivityRates.set(auth, rate);
    if (rate.tokens < 1) throw new SessionError('VOICE_ACTIVITY_RATE_LIMIT', 429);
    rate.tokens--;
    const body = voiceActivitySchema.parse(req.body);
    runtime(play).reportVoiceActivity(body);
    res.status(202).json({ accepted: true });
  });
  app.post('/api/play/commands/poll', (req, res) => {
    const play = controlled(req);
    const body = z
      .object({
        generation: z.number().int().positive(),
        ackThrough: z.number().int().nonnegative(),
      })
      .strict()
      .parse(req.body);
    const current = runtime(play);
    res.json({ ...current.pollCommands(body.generation, body.ackThrough), state: current.state() });
  });
  app.post('/api/play/actions', async (req, res) => {
    const play = controlled(req);
    if (runtime(play).coreSnapshot)
      return errorResponse(
        res,
        410,
        'LEGACY_ACTION_DISABLED',
        '画面を更新し、音声で指示してください。',
      );
    const body = actionSchema.parse(req.body);
    const commands = await runtime(play).action(body.actionId, body.proposalRevision);
    validAfter(req, play);
    res.json({ ...update(play), commands });
  });
  app.post('/api/play/heartbeat', async (req, res) => {
    const play = controlled(req);
    const body = heartbeatSchema.parse(req.body);
    const r = runtime(play);
    if (body.generation !== r.voiceGeneration) throw new SessionError('STALE_GENERATION', 409);
    const auth = owner(req);
    const { clientId, epoch } = credentials(req);
    registry.heartbeat(auth, play.id, clientId, epoch, body.voiceState);
    // A closed peer can be a page reload. Only /end explicitly ends a game.
    r.heartbeat(body.voiceState === 'closed' ? 'disconnected' : body.voiceState);
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
    sceneJobs.resume();
    endingJobs.resume();
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
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    let status = 500,
      code = 'INTERNAL_ERROR';
    if (
      error instanceof SessionError ||
      error instanceof AiServiceError ||
      error instanceof LiveOutboxError ||
      error instanceof ResultStoreError
    ) {
      status = error.status;
      code = error.code;
    } else if (error instanceof GameError) {
      status = error.status;
      code =
        error.code ??
        (status === 409
          ? 'PLAY_CONFLICT'
          : status === 410
            ? 'PLAY_EXPIRED'
            : status === 503
              ? 'PHOTO_BUSY'
              : 'GAME_REQUEST_FAILED');
    } else if (
      error instanceof Error &&
      ['CONVERSATION_LIMIT', 'DELEGATION_LIMIT'].includes(error.message)
    ) {
      status = 429;
      code = error.message;
    } else if (error instanceof z.ZodError) {
      status = 400;
      code = 'INVALID_REQUEST';
    } else if (error instanceof ScenarioConfigError) {
      status = error.status;
      code = error.code;
    } else if (error?.status === 413) {
      status = 413;
      code = 'BODY_TOO_LARGE';
    } else if (error?.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_REQUEST';
    }
    if (code === 'PLAY_CAPACITY') res.setHeader('Retry-After', '5');
    log({
      event: 'request_failed',
      errorCode: code,
      correlationId: requestPlays.get(req),
      route: typeof req.route?.path === 'string' ? req.route.path : undefined,
      method: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method)
        ? req.method
        : undefined,
    });
    const message =
      code === 'PLAY_CAPACITY'
        ? 'ただいま満員です。少し待って再試行してください。'
        : status === 410
          ? '体験が終了したか、セッションの期限が切れました。'
          : status === 401
            ? '開始画面から参加してください。'
            : status === 409
              ? '状態が変わりました。画面を確認して再試行してください。'
              : status === 503
                ? '更新または処理中です。少し待って再試行してください。'
                : '処理できませんでした。画面と接続状態を確認してください。';
    errorResponse(res, status, code, message);
  };
  app.use(errors);
  return {
    app,
    registry,
    ai,
    sessions,
    results,
    sceneJobs,
    endingJobs,
    tick,
    drain,
    dispose,
    bootId,
  };
}
