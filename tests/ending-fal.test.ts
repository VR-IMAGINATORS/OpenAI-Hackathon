import { syntheticEndingMp4 as mp4 } from './helpers/ending-mp4.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFalTransport,
  FalSubmitError,
  FalTransportError,
  FAL_VIDEO_MODEL,
  type FalRequestHandle,
} from '../packages/server/fal.js';
import {
  EndingVideoMediaError,
  MAX_ENDING_VIDEO_BYTES,
  validateEndingMp4,
} from '../packages/server/ending-video-media.js';

const requestId = 'request_test-123';
const base = 'https://queue.fal.run/minimax/h3-max-turbo/requests/' + requestId;
const handle: FalRequestHandle = {
  requestId,
  statusUrl: base + '/status',
  resultUrl: base,
  cancelUrl: base + '/cancel',
};
const input = {
  prompt: 'The same confirmed ending, with only environmental sounds.',
  startImageDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
  endImageDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('fal submits once with fixed production parameters and separately retrieves its result', async () => {
  const requests: { url: string; options: RequestInit }[] = [];
  const responses = [
    json({
      request_id: requestId,
      status_url: handle.statusUrl,
      response_url: handle.resultUrl,
      cancel_url: handle.cancelUrl,
    }),
    json({ request_id: requestId, status: 'IN_QUEUE' }),
    json({ request_id: requestId, status: 'IN_PROGRESS' }),
    json({ request_id: requestId, status: 'COMPLETED', response_url: handle.resultUrl }),
    json({ video: { url: 'https://v3.fal.media/files/ending.mp4', file_size: 10 } }),
    new Response(new Uint8Array([1, 2, 3])),
  ];
  const transport = createFalTransport('private-fal-test', async (url, options) => {
    requests.push({ url: String(url), options: options! });
    return responses.shift()!;
  });
  const accepted = await transport.submit(input);
  assert.deepEqual(accepted, handle);
  assert.equal(await transport.status(accepted), 'IN_QUEUE');
  assert.equal(await transport.status(accepted), 'IN_PROGRESS');
  assert.equal(await transport.status(accepted), 'COMPLETED');
  const result = await transport.result(accepted);
  assert.equal(result.videoUrl, 'https://v3.fal.media/files/ending.mp4');
  assert.deepEqual(await transport.downloadVideo(result.videoUrl), Buffer.from([1, 2, 3]));
  assert.equal(requests[0].url, 'https://queue.fal.run/' + FAL_VIDEO_MODEL);
  assert.equal(requests.filter((value) => value.options.method === 'POST').length, 1);
  const headers = new Headers(requests[0].options.headers);
  assert.equal(headers.get('authorization'), 'Key private-fal-test');
  assert.equal(headers.get('x-fal-no-retry'), '1');
  assert.deepEqual(JSON.parse(String(requests[0].options.body)), {
    prompt: input.prompt,
    image_url: input.startImageDataUrl,
    end_image_url: input.endImageDataUrl,
    duration: 15,
    resolution: '768P',
    prompt_expansion_mode: 'balanced',
    enable_safety_checker: true,
  });
  assert(requests.every((value) => value.options.redirect === 'error' && value.options.signal));
  assert.equal(requests.at(-1)!.options.headers, undefined);
  assert.equal(requests.at(-1)!.options.credentials, 'omit');
});

test('fal submit distinguishes rejection from ambiguous acceptance without automatic retry', async () => {
  for (const status of [400, 401, 403, 413, 422, 429, 408, 409, 500, 503]) {
    let calls = 0;
    const transport = createFalTransport('test', async () => {
      calls++;
      return json({}, status);
    });
    await assert.rejects(transport.submit(input), (error: unknown) => {
      assert(error instanceof FalSubmitError);
      assert.equal(
        error.acceptance,
        [408, 409, 500, 503].includes(status) ? 'unknown' : 'rejected',
      );
      return true;
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  const transport = createFalTransport('private-key', async () => {
    calls++;
    throw new Error('Sensitive upstream text private-key https://provider.invalid');
  });
  await assert.rejects(transport.submit(input), (error: unknown) => {
    assert(error instanceof FalSubmitError);
    assert.equal(error.acceptance, 'unknown');
    assert.equal(error.requestHandle, undefined);
    assert(!String(error).includes('private-key'));
    assert(!String(error).includes('provider.invalid'));
    return true;
  });
  assert.equal(calls, 1);
});

test('fal retains a safe recovery handle when accepted response has an invalid URL', async () => {
  for (const responseUrl of [
    'https://attacker.invalid/requests/' + requestId,
    base.replace(requestId, 'other-play'),
    base + '?next=other',
    base + '/../' + requestId,
    base.replace('queue.fal.run', 'queue.fal.run@attacker.invalid'),
  ]) {
    const transport = createFalTransport('test', async () =>
      json({ request_id: requestId, response_url: responseUrl }),
    );
    await assert.rejects(transport.submit(input), (error: unknown) => {
      assert(error instanceof FalSubmitError);
      assert.equal(error.acceptance, 'unknown');
      assert.deepEqual(error.requestHandle, handle);
      return true;
    });
  }
  const fullBase = 'https://queue.fal.run/' + FAL_VIDEO_MODEL + '/requests/' + requestId;
  const transport = createFalTransport('test', async () =>
    json({
      request_id: requestId,
      status_url: fullBase + '/status',
      response_url: fullBase + '/response',
      cancel_url: fullBase + '/cancel',
    }),
  );
  assert.equal((await transport.submit(input)).resultUrl, fullBase + '/response');
});

test('queue URLs are revalidated before credentials are sent, including mutable handles', async () => {
  let calls = 0;
  const transport = createFalTransport('private-key', async () => {
    calls++;
    return json({});
  });
  for (const url of [
    'http://queue.fal.run/a',
    base + '/status?logs=1',
    base.replace(requestId, 'other') + '/status',
  ]) {
    await assert.rejects(transport.status({ ...handle, statusUrl: url }), FalTransportError);
  }
  await assert.rejects(
    transport.result({ ...handle, resultUrl: 'https://localhost/' }),
    FalTransportError,
  );
  await assert.rejects(
    transport.cancel({ ...handle, cancelUrl: 'https://v3.fal.media/' }),
    FalTransportError,
  );
  assert.equal(calls, 0);
});

test('fal rejects arbitrary image URLs and pre-aborted work before submitting', async () => {
  let calls = 0;
  const transport = createFalTransport('test', async () => {
    calls++;
    return json({});
  });
  for (const image of [
    'https://localhost/private.jpg',
    'data:image/png;base64,/9j/2Q==',
    'data:image/jpeg;base64,aaaa',
  ]) {
    await assert.rejects(
      transport.submit({ ...input, startImageDataUrl: image }),
      (error: unknown) => error instanceof FalSubmitError && error.acceptance === 'rejected',
    );
  }
  await assert.rejects(
    transport.submit(input, AbortSignal.abort()),
    (error: unknown) => error instanceof FalSubmitError && error.acceptance === 'rejected',
  );
  assert.equal(calls, 0);
});

test('fal completion and cancellation distinguish confirmed termination from a cancellation signal', async () => {
  const responses = [
    json({ status: 'CANCELLATION_REQUESTED' }, 202),
    json({ status: 'ALREADY_COMPLETED' }, 400),
    json({ status: 'NOT_FOUND' }, 404),
    json({ status: 'IN_PROGRESS' }),
    json({ status: 'NOT_FOUND' }, 404),
    json({ status: 'COMPLETED', error: 'private-provider-details' }),
    json({ detail: 'opaque error' }, 422),
  ];
  const transport = createFalTransport('test', async () => responses.shift()!);
  assert.deepEqual(await transport.cancel(handle), { stopConfirmed: false });
  assert.deepEqual(await transport.cancel(handle), { stopConfirmed: true });
  assert.deepEqual(await transport.cancel(handle), { stopConfirmed: true });
  assert.equal(await transport.status(handle), 'IN_PROGRESS');
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      transport.status(handle),
      (error: unknown) => error instanceof FalTransportError && error.terminal,
    );
  }
  await assert.rejects(
    transport.status(handle),
    (error: unknown) => error instanceof FalTransportError && !error.terminal,
  );
});

test('fal rejects cross-request status and unexpected redirect responses', async () => {
  const transport = createFalTransport('test', async () =>
    json({ request_id: 'other-play', status: 'COMPLETED' }),
  );
  await assert.rejects(
    transport.status(handle),
    (error: unknown) => error instanceof FalTransportError && !error.terminal,
  );
  let calls = 0;
  const redirect = createFalTransport('test', async () => {
    calls++;
    return new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid' } });
  });
  await assert.rejects(
    redirect.submit(input),
    (error: unknown) => error instanceof FalSubmitError && error.acceptance === 'unknown',
  );
  await assert.rejects(redirect.downloadVideo('https://fal.media/video.mp4'), FalTransportError);
  assert.equal(calls, 2);
});

test('fal media permits only HTTPS fal.media hosts and rejects misleading suffixes, credentials, and ports', async () => {
  let calls = 0;
  const transport = createFalTransport('test', async () => {
    calls++;
    return new Response('abc');
  });
  for (const url of [
    'http://fal.media/video.mp4',
    'https://fal.media.attacker.invalid/video.mp4',
    'https://evilfal.media/video.mp4',
    'https://user:pass@fal.media/video.mp4',
    'https://127.0.0.1/video.mp4',
    'https://fal.media:444/video.mp4',
    'https://fal.media./video.mp4',
    'https://fal.media/video.mp4#fragment',
  ])
    await assert.rejects(transport.downloadVideo(url), FalTransportError);
  assert.equal(calls, 0);
  await transport.downloadVideo('https://fal.media/video.mp4');
  await transport.downloadVideo('https://v3.fal.media/video.mp4?token=temporary');
  assert.equal(calls, 2);
});

function oversizedStream(limit: number) {
  let cancelled = false;
  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks++;
      controller.enqueue(new Uint8Array(Math.min(limit, 32 * 1024)));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(stream), cancelled: () => cancelled, chunks: () => chunks };
}

test('fal enforces submit, query, and media byte limits while streaming', async () => {
  for (const kind of ['submit', 'status', 'download'] as const) {
    const limit =
      kind === 'submit' ? 64 * 1024 : kind === 'status' ? 256 * 1024 : MAX_ENDING_VIDEO_BYTES;
    const stream = oversizedStream(limit);
    const transport = createFalTransport('test', async () => stream.response);
    if (kind === 'submit') await assert.rejects(transport.submit(input), FalSubmitError);
    else if (kind === 'status') await assert.rejects(transport.status(handle), FalTransportError);
    else
      await assert.rejects(
        transport.downloadVideo('https://fal.media/video.mp4'),
        FalTransportError,
      );
    assert(stream.cancelled());
    assert(stream.chunks() <= Math.ceil(limit / (32 * 1024)) + 2);
  }
  const declared = createFalTransport(
    'test',
    async () =>
      new Response('abc', { headers: { 'Content-Length': String(MAX_ENDING_VIDEO_BYTES + 1) } }),
  );
  await assert.rejects(declared.downloadVideo('https://fal.media/video.mp4'), FalTransportError);
});

test('abort interrupts a stalled media body and preserves unknown submit acceptance', async () => {
  for (const submit of [false, true]) {
    const controller = new AbortController();
    let cancelled = false;
    const transport = createFalTransport(
      'test',
      async () =>
        new Response(
          new ReadableStream({
            start() {
              setTimeout(() => controller.abort(), 5);
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const pending = submit
      ? transport.submit(input, controller.signal)
      : transport.downloadVideo('https://fal.media/video.mp4', controller.signal);
    await assert.rejects(pending, (error: unknown) =>
      submit
        ? error instanceof FalSubmitError && error.acceptance === 'unknown'
        : error instanceof FalTransportError,
    );
    assert(cancelled);
  }
});

test('MP4 technical validation accepts bounded 15-second square 768P video with audio samples', () => {
  const bytes = mp4();
  assert.deepEqual(validateEndingMp4(bytes), {
    durationSeconds: 15,
    width: 768,
    height: 768,
    hasAudio: true,
    byteLength: bytes.length,
  });
});

test('MP4 technical validation rejects missing audio, wrong duration/dimensions and external or invalid sample references', () => {
  for (const options of [
    { audio: false },
    { width: 1024 },
    { seconds: 5 },
    { external: true },
    { outsideMdat: true },
  ]) {
    assert.throws(() => validateEndingMp4(mp4(options)), EndingVideoMediaError);
  }
  assert.throws(
    () => validateEndingMp4(new Uint8Array(MAX_ENDING_VIDEO_BYTES + 1)),
    EndingVideoMediaError,
  );
  assert.throws(
    () => validateEndingMp4(Buffer.from('<html>not a video</html>')),
    EndingVideoMediaError,
  );
});

test('MP4 technical validation rejects truncated and unbounded boxes and manipulated timing', () => {
  const bytes = mp4();
  for (const cut of [1, 5, 9, 40])
    assert.throws(
      () => validateEndingMp4(bytes.subarray(0, bytes.length - cut)),
      EndingVideoMediaError,
    );
  for (const size of [0, 4, 0xffffffff]) {
    const invalid = Buffer.from(bytes);
    invalid.writeUInt32BE(size);
    assert.throws(() => validateEndingMp4(invalid), EndingVideoMediaError);
  }
  const badTiming = Buffer.from(bytes);
  const stts = badTiming.indexOf('stts');
  badTiming.writeUInt32BE(2, stts + 12);
  assert.throws(() => validateEndingMp4(badTiming), EndingVideoMediaError);
  const invalidExtended = Buffer.from(bytes);
  invalidExtended.writeUInt32BE(1);
  invalidExtended.writeBigUInt64BE(2n ** 63n, 8);
  assert.throws(() => validateEndingMp4(invalidExtended), EndingVideoMediaError);
});
