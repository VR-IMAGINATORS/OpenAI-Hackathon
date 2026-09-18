import express from 'express';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { SessionStore } from '../apps/server/session-store.js';
import { SessionError } from '../apps/server/control.js';
import { CodexLiveProbe } from './codex-poc/live-probe.js';
import { startWorker } from './codex-poc/worker.js';
import { failureMessage } from './codex-poc/binary.js';
import { PocError } from './codex-poc/rpc.js';

export function createVoiceProbeApp(probe = new CodexLiveProbe(), port = 4311) {
  const app = express();
  const sessions = new SessionStore({ capacity: 10, authAttemptsPerMinute: 10, ttlMs: 900_000 });
  const token = (req: express.Request) => {
    const cookies = (req.headers.cookie ?? '')
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith('voice_probe='));
    if (cookies.length > 1) throw new SessionError('AUTH_REQUIRED', 401);
    return cookies[0]?.slice('voice_probe='.length);
  };
  const owner = (req: express.Request) => sessions.authorize(token(req)).digest;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'",
    });
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? ''))
      throw new SessionError('HOST_FORBIDDEN', 403);
    if (
      (req.get('Origin') || req.method !== 'GET') &&
      ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.get('Origin') ?? '')
    )
      throw new SessionError('ORIGIN_FORBIDDEN', 403);
    next();
  });
  app.use(express.json({ limit: '96kb', strict: true, inflate: false }));
  const empty = (req: express.Request) => z.object({}).strict().parse(req.body);
  app.post('/api/auth', (req, res) => {
    empty(req);
    const session = sessions.createSession(token(req));
    res.cookie('voice_probe', session.token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 900_000,
    });
    res.json({ ok: true });
  });
  app.get('/api/status', (req, res) => res.json(probe.status(owner(req))));
  app.post('/api/login', (req, res) => {
    empty(req);
    res.json(probe.login(owner(req)));
  });
  app.post('/api/start', async (req, res) => {
    const id = owner(req);
    const { sdp } = z
      .object({ sdp: z.string().min(5).max(65536).startsWith('v=0') })
      .strict()
      .parse(req.body);
    res.json(await probe.start(id, sdp));
  });
  app.post('/api/speech', async (req, res) => {
    empty(req);
    await probe.speak(owner(req));
    res.json({ accepted: true });
  });
  app.post('/api/stop', async (req, res) => {
    empty(req);
    const id = owner(req);
    await probe.stop(id);
    res.json(probe.status(id));
  });
  const root = fileURLToPath(new URL('./codex-live-ui/', import.meta.url));
  app.get('/', (_req, res) => res.sendFile(resolve(root, 'index.html')));
  app.get('/probe.js', (_req, res) => res.sendFile(resolve(root, 'probe.js')));
  app.get('/style.css', (_req, res) => res.sendFile(resolve(root, 'style.css')));
  const errors: express.ErrorRequestHandler = (error, _req, res, _next) => {
    const status =
      error instanceof SessionError ? error.status : error instanceof z.ZodError ? 400 : 503;
    const code =
      error instanceof SessionError || error instanceof PocError
        ? error.code
        : 'VOICE_PROBE_FAILED';
    res.status(status).json({ error: { code } });
  };
  app.use(errors);
  return app;
}

async function main() {
  if (process.argv.slice(2).join(' ') === '--check') {
    const worker = await startWorker();
    try {
      const voices = await worker.rpc.call('thread/realtime/listVoices', {});
      console.log(
        `音声RPC応答: OK / v1=${voices.voices.v1.length} / v2=${voices.voices.v2.length}`,
      );
      console.log('これは未認証の能力確認です。GPT-Live接続・サブスク利用成功は未確認です。');
    } finally {
      await worker.close();
    }
    return;
  }
  if (process.argv.length > 2) throw new PocError('UNKNOWN_ARGUMENT');
  const probe = new CodexLiveProbe();
  const app = createVoiceProbeApp(probe);
  const server = app.listen(4311, '127.0.0.1');
  server.requestTimeout = 45_000;
  server.headersTimeout = 10_000;
  let closing: Promise<void> | undefined;
  const timer = setInterval(() => {
    void probe.tick().catch(() => {});
  }, 1000);
  timer.unref();
  const stop = () =>
    (closing ??= (async () => {
      clearInterval(timer);
      server.close();
      server.closeAllConnections();
      await probe.dispose();
    })());
  const signal = () => {
    void stop().catch(() => {
      console.log('終了確認に失敗しました。');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', signal);
  process.once('SIGTERM', signal);
  try {
    await new Promise<void>((yes, no) => {
      server.once('listening', yes);
      server.once('error', no);
    });
    console.log('GPT-Liveサブスク接続PoC: http://127.0.0.1:4311');
    console.log(
      'APIキー不使用 / 音声モデルはCodex標準（未確認） / v3 / 最大60秒 / ログインは画面から',
    );
    await new Promise<void>((yes) => server.once('close', yes));
  } finally {
    await stop();
    process.removeListener('SIGINT', signal);
    process.removeListener('SIGTERM', signal);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.log(failureMessage(error));
    process.exitCode = 1;
  });
}
