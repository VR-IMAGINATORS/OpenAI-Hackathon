import test from 'node:test';
import assert from 'node:assert/strict';
import { AiService, AiServiceError } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import {
  createOpenAITransport,
  UpstreamError,
  type OpenAITransport,
} from '../packages/server/openai.js';

const liveBody = {
  session: {
    model: 'gpt-live-1',
    instructions: 'test',
    delegation: { type: 'client' },
    store: false,
  },
  transport: { type: 'webrtc', sdp: 'offer' },
};
const responseBody = {
  model: 'gpt-5.6-terra',
  instructions: 'test',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'test' }] }],
  text: { format: { type: 'json_schema', name: 'test', strict: true, schema: { type: 'object' } } },
  store: false,
  max_output_tokens: 1000,
};
const answer = {
  session: { id: 'test-live' },
  transport: { type: 'webrtc' as const, sdp: 'answer' },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function fake(overrides: Partial<OpenAITransport> = {}): OpenAITransport {
  return {
    createLiveSession: async () => answer,
    createResponse: async () => ({ output: [] }),
    hangup: async () => {},
    ...overrides,
  };
}
function config() {
  return { ...loadAiConfig({ AI_MODE: 'mock' }), timeoutMs: 30 };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof AiServiceError && error.code === expected;

test('internal game reasoning budget is bounded separately from public Responses', async () => {
  const seen: any[] = [];
  const ai = new AiService(
    { ...config(), gameOutputTokens: 3000 },
    fake({
      createResponse: async (body) => {
        seen.push(body);
        return { output: [] };
      },
    }),
    () => 0,
  );
  ai.register('one', 1000);
  const body = { ...responseBody, model: config().gameModel, max_output_tokens: 4096 };
  await assert.rejects(ai.respond('one', body), code('INVALID_REQUEST'));
  await ai.respondGame('one', body);
  assert.equal(seen[0].max_output_tokens, 3000);
  await assert.rejects(
    ai.respondGame('one', { ...body, max_output_tokens: 4097 }),
    code('INVALID_REQUEST'),
  );
  await assert.rejects(
    ai.respondGame('one', {
      ...body,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(16001) }] }],
    }),
    code('INVALID_REQUEST'),
  );
  assert.equal(ai.snapshot().responseAttempts, 1);
});

test('a game request waits for transient capacity without spending an extra attempt', async () => {
  const gate = deferred<unknown>();
  let calls = 0;
  const ai = new AiService(
    { ...config(), timeoutMs: 1000, responseConcurrentGlobal: 1 },
    fake({
      createResponse: async () => (++calls === 1 ? gate.promise : { output: [] }),
    }),
    () => 0,
  );
  ai.register('one', 1000);
  ai.register('two', 1000);
  const body = { ...responseBody, model: config().gameModel, max_output_tokens: 2048 };
  const first = ai.respondGame('one', body);
  const second = ai.respondGame('two', body);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(ai.snapshot().responseAttempts, 1);
  gate.resolve({ output: [] });
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(ai.snapshot().responseBusy, 0);
  assert.equal(ai.snapshot().responseAttempts, 2);
});

test('waiting game requests honor cancellation and hard attempt limits', async () => {
  const gate = deferred<unknown>();
  const ai = new AiService(
    { ...config(), timeoutMs: 1000, responsesPerPlay: 1 },
    fake({
      createResponse: () => gate.promise,
    }),
    () => 0,
  );
  ai.register('one', 1000);
  const body = { ...responseBody, model: config().gameModel };
  const first = ai.respondGame('one', body);
  await assert.rejects(ai.respondGame('one', body), code('REQUEST_LIMIT'));
  gate.resolve({ output: [] });
  await first;
  assert.equal(ai.snapshot().responseAttempts, 1);

  const pending = deferred<unknown>();
  const waiting = new AiService(
    { ...config(), timeoutMs: 1000 },
    fake({ createResponse: () => pending.promise }),
    () => 0,
  );
  waiting.register('one', 1000);
  const running = waiting.respondGame('one', body);
  const controller = new AbortController();
  const stopped = assert.rejects(
    waiting.respondGame('one', body, controller.signal),
    code('CONTROL_CANCELLED'),
  );
  controller.abort();
  await stopped;
  assert.equal(waiting.snapshot().responseAttempts, 1);
  pending.resolve({ output: [] });
  await running;
});

test('response timeout aborts the transport so a cooperative client releases capacity for recovery', async () => {
  let calls = 0;
  let received: AbortSignal | undefined;
  const ai = new AiService(
    { ...config(), timeoutMs: 30 },
    fake({
      createResponse: async (_body, signal) => {
        if (++calls > 1) return { output: [] };
        received = signal;
        return new Promise((_, reject) =>
          signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      },
    }),
    () => 0,
  );
  ai.register('one', 1000);
  const body = { ...responseBody, model: config().gameModel };
  await assert.rejects(ai.respondGame('one', body), code('UPSTREAM_FAILED'));
  assert.equal(received!.aborted, true);
  assert.equal(ai.snapshot().responseBusy, 0);
  await ai.respondGame('one', body);
  assert.equal(calls, 2);
});

test('original upstream status survives the service error boundary', async () => {
  const ai = new AiService(
    config(),
    fake({
      createResponse: async () => {
        throw new UpstreamError(502, 400);
      },
    }),
    () => 0,
  );
  ai.register('one', 1000);
  await assert.rejects(
    ai.respond('one', responseBody),
    (error) => error instanceof AiServiceError && error.upstreamStatus === 400,
  );
});

test('hosted AI config is fail-closed in live mode and has five-player defaults', () => {
  assert.throws(() => loadAiConfig({ AI_MODE: 'live' }), /OPENAI_API_KEY required/);
  assert.throws(
    () => loadAiConfig({ AI_MODE: 'live', OPENAI_API_KEY: 'test-only' }),
    /AI_GLOBAL_LIVE_ATTEMPTS required/,
  );
  assert.equal(config().liveConcurrentGlobal, 5);
  assert.equal(config().gameModel, 'gpt-5.6-sol');
  assert.equal(config().responseModel, 'gpt-5.6-terra');
  assert.throws(() => new AiService(config()), /injected/);
});

test('hosted AI validates models and bodies before consuming attempts', async () => {
  const ai = new AiService(config(), fake(), () => 0);
  ai.register('one', 1000);
  await assert.rejects(ai.createLive('one', { ...liveBody, extra: true }), code('INVALID_REQUEST'));
  await assert.rejects(
    ai.respond('one', { ...responseBody, model: 'arbitrary' }),
    code('INVALID_REQUEST'),
  );
  await assert.rejects(
    ai.respond('one', { ...responseBody, max_output_tokens: 1001 }),
    code('INVALID_REQUEST'),
  );
  assert.equal(ai.snapshot().liveAttempts, 0);
  assert.equal(ai.snapshot().responseAttempts, 0);
});

test('hosted game requests preserve low reasoning through validation and transport', async () => {
  let received: unknown;
  const ai = new AiService(
    config(),
    fake({
      createResponse: async (body) => {
        received = body;
        return { output: [] };
      },
    }),
    () => 0,
  );
  ai.register('one', 1000);
  const body = { ...responseBody, model: config().gameModel, reasoning: { effort: 'low' } };
  await ai.respond('one', body);
  assert.deepEqual(received, body);
  await assert.rejects(
    ai.respond('one', { ...body, reasoning: { effort: 'invalid' } }),
    code('INVALID_REQUEST'),
  );
  assert.equal(ai.snapshot().responseAttempts, 1);
});

test('hosted Live reserves all five slots before awaiting and isolates budgets', async () => {
  const pending = deferred<typeof answer>();
  let nextId = 0;
  const ai = new AiService(
    config(),
    fake({
      createLiveSession: async () => ({
        ...(await pending.promise),
        session: { id: 'live-' + nextId++ },
      }),
    }),
    () => 0,
  );
  for (let i = 0; i < 6; i++) ai.register(String(i), 1000);
  const requests = Array.from({ length: 5 }, (_, i) => ai.createLive(String(i), liveBody));
  assert.equal(ai.snapshot().liveBusy, 5);
  await assert.rejects(ai.createLive('5', liveBody), code('REQUEST_LIMIT'));
  await assert.rejects(ai.createLive('0', liveBody), code('REQUEST_LIMIT'));
  pending.resolve(answer);
  await Promise.all(requests);
  assert.equal(ai.playSnapshot('5')?.liveAttempts, 0);
  assert.equal(await ai.shutdown(), true);
  assert.equal(ai.snapshot().liveBusy, 0);
});

test('hosted Responses concurrent reservation and failed attempts are not refunded', async () => {
  const pending = deferred<unknown>();
  const ai = new AiService(
    { ...config(), globalResponseAttempts: 2, responseConcurrentGlobal: 1 },
    fake({ createResponse: () => pending.promise }),
    () => 0,
  );
  ai.register('one', 1000);
  ai.register('two', 1000);
  const first = ai.respond('one', responseBody);
  await assert.rejects(ai.respond('two', responseBody), code('REQUEST_LIMIT'));
  pending.reject(new Error('private provider detail'));
  await assert.rejects(first, code('UPSTREAM_FAILED'));
  await assert.rejects(ai.respond('two', responseBody), code('UPSTREAM_FAILED'));
  await assert.rejects(ai.respond('one', responseBody), code('REQUEST_LIMIT'));
  assert.equal(ai.snapshot().responseAttempts, 2);
  assert.equal(ai.snapshot().responseBusy, 0);
});

test('hosted Live timeout keeps unknown reservation and late answer is hung up', async () => {
  const pending = deferred<typeof answer>();
  let closes = 0;
  const ai = new AiService(
    config(),
    fake({
      createLiveSession: () => pending.promise,
      hangup: async () => {
        closes++;
      },
    }),
    () => 0,
  );
  ai.register('one', 1000);
  await assert.rejects(ai.createLive('one', liveBody), code('LIVE_CREATE_UNCONFIRMED'));
  assert.equal(ai.snapshot().unknownCreates, 1);
  assert.equal(ai.snapshot().liveBusy, 1);
  assert.equal(await ai.retire('one'), false);
  assert.equal(ai.forget('one'), false);
  pending.resolve(answer);
  await new Promise((r) => setImmediate(r));
  assert.equal(closes, 1);
  assert.equal(ai.snapshot().unknownCreates, 0);
  assert.equal(ai.snapshot().liveBusy, 0);
  assert.equal(ai.forget('one'), true);
});

test('hosted shutdown recovers delayed creates and discards their answers', async () => {
  const pending = deferred<typeof answer>();
  let closes = 0;
  const ai = new AiService(
    config(),
    fake({
      createLiveSession: () => pending.promise,
      hangup: async () => {
        closes++;
      },
    }),
    () => 0,
  );
  ai.register('one', 1000);
  const creation = ai.createLive('one', liveBody);
  const denied = assert.rejects(creation, code('PLAY_EXPIRED'));
  const shutdown = ai.shutdown();
  pending.resolve(answer);
  await denied;
  assert.equal(await shutdown, true);
  assert.equal(closes, 1);
  await assert.rejects(ai.respond('one', responseBody), code('DRAINING'));
  assert.equal(ai.resume(), true);
  await assert.rejects(ai.respond('one', responseBody), code('PLAY_EXPIRED'));
});

test('hosted close calls share three attempts and keep unconfirmed slots', async () => {
  let closes = 0;
  const ai = new AiService(
    config(),
    fake({
      hangup: async () => {
        closes++;
        throw new Error('secret');
      },
    }),
    () => 0,
  );
  ai.register('one', 1000);
  await ai.createLive('one', liveBody);
  assert.deepEqual(await Promise.all([ai.closeLive('one'), ai.closeLive('one')]), [false, false]);
  assert.equal(closes, 3);
  assert.equal(ai.snapshot().unconfirmedLive, 1);
  assert.equal(await ai.shutdown(), false);
  assert.equal(closes, 3);
  assert.equal(ai.resume(), false);
});

test('hosted deadlines are immutable and late Responses cannot reach an expired game', async () => {
  let now = 0;
  const pending = deferred<unknown>();
  const ai = new AiService(config(), fake({ createResponse: () => pending.promise }), () => now);
  ai.register('one', 1000);
  assert.throws(() => ai.register('one', 2000), code('PLAY_EXPIRED'));
  const response = ai.respond('one', responseBody);
  now = 1000;
  pending.resolve({ output: [] });
  await assert.rejects(response, code('PLAY_EXPIRED'));
  await assert.rejects(ai.createLive('one', liveBody), code('PLAY_EXPIRED'));
});

test('hosted transport uses fixed upstream and bounds JSON response size', async () => {
  let url = '';
  let options: RequestInit | undefined;
  const transport = createOpenAITransport('sentinel-private-key', (async (input, init) => {
    url = String(input);
    options = init;
    return new Response('x'.repeat(256 * 1024 + 1));
  }) as typeof fetch);
  await assert.rejects(transport.createResponse(responseBody));
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(options?.redirect, 'error');
  assert.equal(
    (options?.headers as Record<string, string>).Authorization,
    'Bearer sentinel-private-key',
  );
  await assert.rejects(transport.hangup('../responses'));
});

test('hosted Responses timeout retains concurrency until transport settles', async () => {
  const pending = deferred<unknown>();
  const ai = new AiService(config(), fake({ createResponse: () => pending.promise }), () => 0);
  ai.register('one', 1000);
  await assert.rejects(ai.respond('one', responseBody), code('UPSTREAM_FAILED'));
  assert.equal(ai.snapshot().responseBusy, 1);
  await assert.rejects(ai.respond('one', responseBody), code('REQUEST_LIMIT'));
  assert.equal(await ai.shutdown(), false);
  pending.resolve({ output: [] });
  await new Promise((r) => setImmediate(r));
  assert.equal(ai.snapshot().responseBusy, 0);
  assert.equal(await ai.shutdown(), true);
});

test('hosted duplicate provider ID is quarantined without closing another play', async () => {
  let closes = 0;
  const ai = new AiService(
    config(),
    fake({
      hangup: async () => {
        closes++;
      },
    }),
    () => 0,
  );
  ai.register('one', 1000);
  ai.register('two', 1000);
  await ai.createLive('one', liveBody);
  await assert.rejects(ai.createLive('two', liveBody), code('LIVE_CREATE_UNCONFIRMED'));
  assert.equal(await ai.closeLive('two'), false);
  assert.equal(closes, 0);
  assert.equal(ai.snapshot().unknownCreates, 1);
  assert.equal(await ai.closeLive('one'), true);
});

test('retired response budget is discarded when its delayed transport settles', async () => {
  const pending = deferred<unknown>();
  const ai = new AiService(config(), fake({ createResponse: () => pending.promise }), () => 0);
  ai.register('one', 1000);
  const response = ai.respond('one', responseBody);
  await ai.retire('one');
  assert.equal(ai.forget('one'), false);
  pending.resolve({ output: [] });
  await assert.rejects(response, code('PLAY_EXPIRED'));
  assert.equal(ai.playSnapshot('one'), undefined);
});

test('ordinary Responses enforce each play concurrency limit', async () => {
  const pending = deferred<unknown>();
  const ai = new AiService(
    { ...config(), timeoutMs: 1000, responseConcurrentPerPlay: 1 },
    fake({ createResponse: () => pending.promise }),
    () => 0,
  );
  ai.register('one', 1000);
  const first = ai.respond('one', responseBody);
  await assert.rejects(ai.respond('one', responseBody), code('REQUEST_LIMIT'));
  assert.equal(ai.playSnapshot('one')!.responseAttempts, 1);
  pending.resolve({ output: [] });
  await first;
  assert.equal(ai.snapshot().responseBusy, 0);
});

test('aborted ordinary Responses retain the busy slot until transport settlement', async () => {
  const pending = deferred<unknown>();
  let receivedSignal: AbortSignal | undefined;
  const ai = new AiService(
    { ...config(), timeoutMs: 1000 },
    fake({
      createResponse: async (_body, signal) => {
        receivedSignal = signal;
        return pending.promise;
      },
    }),
    () => 0,
  );
  ai.register('one', 1000);
  const controller = new AbortController();
  const running = ai.respond('one', responseBody, controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rejected = assert.rejects(running, code('CONTROL_CANCELLED'));
  controller.abort();
  await rejected;
  assert.equal(receivedSignal!.aborted, true);
  assert.equal(ai.snapshot().responseBusy, 1);
  pending.resolve({ output: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ai.snapshot().responseBusy, 0);
});
