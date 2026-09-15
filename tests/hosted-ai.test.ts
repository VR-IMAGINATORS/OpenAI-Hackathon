import test from 'node:test';
import assert from 'node:assert/strict';
import { AiService, AiServiceError } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { createOpenAITransport, type OpenAITransport } from '../packages/server/openai.js';

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

const controlBody = {
  ...responseBody,
  text: { format: { ...responseBody.text.format, name: 'harness_control' } },
};

test('internal control lane admits one beside judgment but preserves normal and global ceilings', async () => {
  const pending = deferred<unknown>();
  const ai = new AiService(
    { ...config(), timeoutMs: 1000 },
    fake({ createResponse: async () => pending.promise }),
    () => 0,
  );
  ai.register('one', 1000);
  const normal = ai.respond('one', responseBody);
  const control = ai.respondControl('one', controlBody);
  await assert.rejects(ai.respond('one', responseBody), code('REQUEST_LIMIT'));
  await assert.rejects(ai.respondControl('one', controlBody), code('REQUEST_LIMIT'));
  assert.equal(ai.playSnapshot('one')!.responseBusy, 2);
  assert.equal(ai.snapshot().responseAttempts, 2);
  pending.resolve({ output: [] });
  await Promise.all([normal, control]);
  assert.equal(ai.snapshot().responseBusy, 0);

  const gate = deferred<unknown>();
  const limited = new AiService(
    { ...config(), timeoutMs: 1000, responseConcurrentGlobal: 1 },
    fake({ createResponse: async () => gate.promise }),
    () => 0,
  );
  limited.register('one', 1000);
  const running = limited.respond('one', responseBody);
  await assert.rejects(limited.respondControl('one', controlBody), code('REQUEST_LIMIT'));
  gate.resolve({ output: [] });
  await running;
});

test('control and normal replies share play and global attempt budgets', async () => {
  const ai = new AiService(
    { ...config(), responsesPerPlay: 2, globalResponseAttempts: 2 },
    fake(),
    () => 0,
  );
  ai.register('one', 1000);
  ai.register('two', 1000);
  await ai.respondControl('one', controlBody);
  await ai.respond('one', responseBody);
  await assert.rejects(ai.respondControl('one', controlBody), code('REQUEST_LIMIT'));
  await assert.rejects(ai.respondControl('two', controlBody), code('REQUEST_LIMIT'));
  assert.equal(ai.snapshot().responseAttempts, 2);
});

test('control lane cannot be selected by body fields or unrelated schemas', async () => {
  const ai = new AiService(config(), fake(), () => 0);
  ai.register('one', 1000);
  await assert.rejects(
    ai.respond('one', { ...responseBody, lane: 'control' }),
    code('INVALID_REQUEST'),
  );
  await assert.rejects(ai.respondControl('one', responseBody), code('INVALID_REQUEST'));
  assert.equal(ai.snapshot().responseAttempts, 0);
});

test('aborting control settles the caller but retains real busy until transport settles', async () => {
  const gate = deferred<unknown>();
  let receivedSignal: AbortSignal | undefined;
  const ai = new AiService(
    { ...config(), timeoutMs: 1000 },
    fake({
      createResponse: async (_body, signal) => {
        receivedSignal = signal;
        return gate.promise;
      },
    }),
    () => 0,
  );
  ai.register('one', 1000);
  const controller = new AbortController();
  const running = ai.respondControl('one', controlBody, controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rejected = assert.rejects(running, code('CONTROL_CANCELLED'));
  controller.abort();
  await rejected;
  assert.equal(receivedSignal, controller.signal);
  assert.equal(ai.snapshot().responseBusy, 1);
  await assert.rejects(ai.respondControl('one', controlBody), code('REQUEST_LIMIT'));
  await ai.retire('one');
  assert.equal(ai.forget('one'), false);
  gate.resolve({ output: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ai.snapshot().responseBusy, 0);
  assert.equal(ai.forget('one'), true);
});

test('cooperative control abort frees its lane and pre-aborted calls spend no attempt', async () => {
  const ai = new AiService(
    { ...config(), timeoutMs: 1000 },
    fake({
      createResponse: async (_body, signal) => {
        if (!signal) return { output: [] };
        return new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      },
    }),
    () => 0,
  );
  ai.register('one', 1000);
  const controller = new AbortController();
  const running = ai.respondControl('one', controlBody, controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rejected = assert.rejects(running, code('CONTROL_CANCELLED'));
  controller.abort();
  await rejected;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ai.snapshot().responseBusy, 0);
  await ai.respondControl('one', controlBody);
  const before = ai.snapshot().responseAttempts;
  await assert.rejects(
    ai.respondControl('one', controlBody, controller.signal),
    code('CONTROL_CANCELLED'),
  );
  assert.equal(ai.snapshot().responseAttempts, before);
});
