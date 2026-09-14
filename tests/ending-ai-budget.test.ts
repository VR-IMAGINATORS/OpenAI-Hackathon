import test from 'node:test';
import assert from 'node:assert/strict';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { createOpenAITransport, type OpenAITransport } from '../packages/server/openai.js';
import { endingResponseRequest } from '../packages/server/ending-ai-request.js';

const jpeg = Buffer.from([255, 216, 255, 217]);
const image = {
  type: 'input_image',
  image_url: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
};
function responseBody(model = 'gpt-5.6-terra', tokens = 1000, text = 'Confirmed play evidence') {
  return {
    model,
    instructions: 'Only use the supplied evidence.',
    input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
    text: {
      format: {
        type: 'json_schema',
        name: 'ending_test',
        strict: true,
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    store: false,
    max_output_tokens: tokens,
  };
}
const frameBody = {
  model: 'gpt-image-2.5-flare',
  prompt: 'Consistent scene.',
  images: [jpeg],
  n: 1 as const,
  size: '1024x1024' as const,
  quality: 'low' as const,
  output_format: 'jpeg' as const,
};
function fixture(values: NodeJS.ProcessEnv = {}, overrides: Partial<OpenAITransport> = {}) {
  let now = 0;
  const seen = { responses: [] as unknown[], edits: [] as unknown[], images: [] as unknown[] };
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock', ...values }),
    {
      async createLiveSession() {
        throw new Error('unused');
      },
      async hangup() {},
      async createResponse(body) {
        seen.responses.push(body);
        return { output: [] };
      },
      async createImageEdit(body) {
        seen.edits.push(body);
        return { data: [] };
      },
      async createImage(body) {
        seen.images.push(body);
        return { data: [] };
      },
      ...overrides,
    },
    () => now,
  );
  ai.register('play', 1000);
  const permit = ai.registerEnding('play', 'ending', 500_000);
  const signal = new AbortController().signal;
  return {
    ai,
    permit,
    signal,
    seen,
    setNow(value: number) {
      now = value;
    },
    call: (
      kind: 'extraction' | 'story' | 'direction' | 'frame' | 'inspection',
      body: unknown,
      frame: 'start' | 'end' = 'start',
    ) => ai.endingCall('ending', 0, kind, body, signal, frame),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('ending authority is reserved before retirement and survives Live/player deadline without recreating a play', async () => {
  const f = fixture();
  await f.ai.retire('play');
  f.setNow(2000);
  assert.throws(() => f.ai.registerEnding('play', 'late', 3000), { code: 'PLAY_EXPIRED' });
  assert.equal(f.ai.forget('play'), false);
  await f.call('story', responseBody(undefined, 4096, 'a'.repeat(20_000)));
  assert.equal(f.seen.responses.length, 1);
  assert.equal(f.ai.snapshot().responseAttempts, 1);
  await assert.rejects(f.ai.respond('play', responseBody()), { code: 'PLAY_EXPIRED' });
  f.ai.releaseMedia('ending');
  assert.equal(f.ai.forget('play'), true);
});

test('one ending permit bounds extraction/story/start/end/inspection independently and counts global attempts', async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) await f.call('extraction', responseBody(undefined, 2048));
  await assert.rejects(f.call('extraction', responseBody()), { code: 'REQUEST_LIMIT' });
  await f.call('story', responseBody(undefined, 4096));
  await assert.rejects(f.call('story', responseBody()), { code: 'REQUEST_LIMIT' });
  await f.call('direction', responseBody(undefined, 4096));
  await assert.rejects(f.call('direction', responseBody()), { code: 'REQUEST_LIMIT' });
  for (const frame of ['start', 'end'] as const) {
    await f.call('frame', frameBody, frame);
    await f.call('frame', frameBody, frame);
    await assert.rejects(f.call('frame', frameBody, frame), { code: 'REQUEST_LIMIT' });
  }
  for (let i = 0; i < 4; i++) await f.call('inspection', responseBody('gpt-5.6-luna'));
  await assert.rejects(f.call('inspection', responseBody('gpt-5.6-luna')), {
    code: 'REQUEST_LIMIT',
  });
  assert.deepEqual(f.permit.ending, {
    extraction: 6,
    story: 1,
    direction: 1,
    start: 2,
    end: 2,
    inspection: 4,
  });
  assert.equal(f.ai.snapshot().responseAttempts, 8);
  assert.equal(f.ai.snapshot().imageAttempts, 4);
  assert.equal(f.ai.snapshot().inspectionAttempts, 4);
  assert.equal(f.seen.responses.length, 12);
  assert.equal(f.seen.edits.length, 4);
  assert.equal(f.seen.images.length, 0);
});

test('ordinary Responses keep the 16000-character/1000-token contract and cannot use ending authority', async () => {
  const f = fixture();
  await assert.rejects(f.ai.respond('play', responseBody(undefined, 4096)), {
    code: 'INVALID_REQUEST',
  });
  await assert.rejects(f.ai.respond('play', responseBody(undefined, 1000, 'a'.repeat(16_001))), {
    code: 'INVALID_REQUEST',
  });
  await assert.rejects(f.ai.mediaCall('ending', 0, 'generation', frameBody, 1000), {
    code: 'MEDIA_EXPIRED',
  });
  assert.equal(f.seen.responses.length, 0);
  await f.call('story', responseBody(undefined, 4096, 'a'.repeat(20_000)));
  assert.equal(f.seen.responses.length, 1);
});

test('ending validates byte-based text caps, at most two 1MiB images, models and per-purpose tokens before charging', async () => {
  const f = fixture();
  const oversizedText = responseBody(undefined, 4096, 'あ'.repeat(44_000));
  assert.equal(endingResponseRequest.safeParse(oversizedText).success, false);
  await assert.rejects(f.call('story', oversizedText));
  for (const content of [
    [image, image, image],
    [
      {
        ...image,
        image_url: 'data:image/jpeg;base64,' + Buffer.alloc(1024 * 1024 + 1).toString('base64'),
      },
    ],
  ]) {
    await assert.rejects(
      f.call('story', { ...responseBody(), input: [{ role: 'user', content }] }),
    );
  }
  await assert.rejects(f.call('extraction', responseBody(undefined, 2049)), {
    code: 'INVALID_REQUEST',
  });
  await assert.rejects(f.call('inspection', responseBody('gpt-5.6-luna', 1001)), {
    code: 'INVALID_REQUEST',
  });
  await assert.rejects(f.call('story', responseBody('wrong-model')), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.call('frame', { ...frameBody, images: [Buffer.from('not-jpeg')] }));
  await assert.rejects(f.call('frame', { ...frameBody, images: [jpeg, jpeg, jpeg] }));
  await assert.rejects(f.call('frame', { ...frameBody, model: 'wrong-model' }), {
    code: 'INVALID_REQUEST',
  });
  assert.equal(f.ai.snapshot().responseAttempts, 0);
  assert.equal(f.ai.snapshot().imageAttempts, 0);
  assert.equal(f.ai.snapshot().inspectionAttempts, 0);
  assert.equal(f.seen.responses.length + f.seen.edits.length, 0);
});

test('ending and ordinary calls share global Responses attempt and concurrency budgets', async () => {
  const f = fixture({ AI_GLOBAL_RESPONSE_ATTEMPTS: '2' });
  await f.ai.respond('play', responseBody());
  await f.call('story', responseBody());
  await assert.rejects(f.call('extraction', responseBody()), { code: 'REQUEST_LIMIT' });
  assert.equal(f.ai.snapshot().responseAttempts, 2);

  const gate = deferred<unknown>();
  let requests = 0;
  const held = fixture(
    { AI_RESPONSE_CONCURRENT_GLOBAL: '1' },
    {
      async createResponse() {
        requests++;
        return gate.promise;
      },
    },
  );
  const ordinary = held.ai.respond('play', responseBody());
  await assert.rejects(held.call('extraction', responseBody()), { code: 'REQUEST_LIMIT' });
  assert.equal(held.permit.ending!.extraction, 0);
  gate.resolve({ output: [] });
  await ordinary;
  await held.call('extraction', responseBody());
  assert.equal(requests, 2);
});

test('ending image/inspection attempts share the ordinary media global limits', async () => {
  const f = fixture({ AI_GLOBAL_IMAGE_ATTEMPTS: '1', AI_GLOBAL_INSPECTION_ATTEMPTS: '1' });
  f.ai.registerMedia('play', 'scene', 1000, 4);
  const { images: _images, ...generationBody } = frameBody;
  await f.ai.mediaCall('scene', 0, 'generation', generationBody, 1000);
  const inspect = responseBody('gpt-5.6-luna');
  await f.ai.mediaCall(
    'scene',
    0,
    'inspection',
    {
      ...inspect,
      input: [{ role: 'user', content: [image] }],
    },
    1000,
  );
  await assert.rejects(f.call('frame', frameBody), { code: 'REQUEST_LIMIT' });
  await assert.rejects(f.call('inspection', inspect), { code: 'REQUEST_LIMIT' });
  assert.equal(f.permit.generationAttempts, 0);
  assert.equal(f.permit.inspectionAttempts, 0);
});

test('cancelled, expired, stale or already-aborted ending permits do not reach transport', async () => {
  for (const cause of ['cancel', 'expiry', 'epoch', 'signal'] as const) {
    const f = fixture();
    if (cause === 'cancel') f.ai.cancelMedia('ending');
    if (cause === 'expiry') f.setNow(500_000);
    const controller = new AbortController();
    if (cause === 'signal') controller.abort();
    await assert.rejects(
      f.ai.endingCall(
        'ending',
        cause === 'epoch' ? 1 : 0,
        'story',
        responseBody(),
        controller.signal,
      ),
      { code: 'ENDING_EXPIRED' },
    );
    assert.equal(f.seen.responses.length, 0);
    assert.equal(f.ai.snapshot().responseAttempts, 0);
  }
});

test('drain aborts ending transport but retains occupied concurrency until it settles', async () => {
  const gate = deferred<unknown>();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const f = fixture(
    {},
    {
      async createImageEdit(_body, receivedSignal) {
        calls++;
        signal = receivedSignal;
        return gate.promise;
      },
    },
  );
  const pending = f.call('frame', frameBody);
  assert.equal(await f.ai.shutdown(), false);
  assert.equal(signal?.aborted, true);
  assert.equal(f.ai.snapshot().imageBusy, 1);
  assert.equal(f.ai.resume(), false);
  await assert.rejects(f.call('story', responseBody()), { code: 'ENDING_EXPIRED' });
  assert.throws(() => f.ai.register('other', 1000), { code: 'DRAINING' });
  gate.resolve({ data: [] });
  await assert.rejects(pending, { code: 'ENDING_EXPIRED' });
  assert.equal(calls, 1);
  assert.equal(f.ai.snapshot().imageBusy, 0);
  assert.equal(f.ai.resume(), true);
  await assert.rejects(f.call('frame', frameBody), { code: 'ENDING_EXPIRED' });
});

test('ambiguous ending response failure consumes its attempt and is not automatically retried', async () => {
  let calls = 0;
  const f = fixture(
    {},
    {
      async createResponse() {
        calls++;
        throw new Error('network reset');
      },
    },
  );
  await assert.rejects(f.call('story', responseBody()), /network reset/);
  await assert.rejects(f.call('story', responseBody()), { code: 'REQUEST_LIMIT' });
  assert.equal(calls, 1);
  assert.equal(f.ai.snapshot().responseAttempts, 1);
});

test('injected image-edit transport receives a fixed authenticated multipart request with both JPEG references', async () => {
  let calls = 0;
  const transport = createOpenAITransport('test-only-key', async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-only-key');
    assert.equal(new Headers(init?.headers).has('Content-Type'), false);
    assert.ok(init?.body instanceof FormData);
    const body = init.body;
    assert.equal(body.get('model'), frameBody.model);
    assert.equal(body.get('n'), '1');
    assert.equal(body.get('quality'), 'low');
    const references = body.getAll('image[]');
    assert.equal(references.length, 2);
    for (const reference of references) {
      assert.ok(reference instanceof Blob);
      assert.equal(reference.type, 'image/jpeg');
      assert.deepEqual(Buffer.from(await reference.arrayBuffer()), jpeg);
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  await transport.createImageEdit!({ ...frameBody, images: [jpeg, jpeg] });
  assert.equal(calls, 1);
});
