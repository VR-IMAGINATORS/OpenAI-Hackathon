import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Rpc } from '../tools/codex-poc/rpc.js';
import type { CodexWorker } from '../tools/codex-poc/worker.js';
import { generateCodexImage } from '../tools/codex-poc/image-responder.js';

const body = {
  model: 'codex-image-generation',
  prompt: 'A paper band in the public game scene',
  n: 1,
  size: '1024x1024',
  quality: 'low',
  output_format: 'jpeg',
};
async function fixture(t: any, mode = 'ok') {
  const work = await mkdtemp(join(tmpdir(), 'codex-image-test-'));
  const input = new PassThrough(),
    output = new PassThrough();
  const rpc = new Rpc(input, output, 16 * 1024 * 1024);
  const calls: any[] = [];
  let usable = true;
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'blue' } })
    .png()
    .toBuffer();
  const emit = (value: unknown) => output.write(JSON.stringify(value) + '\n');
  input.on('data', (buffer) => {
    const m = JSON.parse(buffer.toString());
    calls.push(m);
    let result: unknown = {};
    if (m.method === 'modelProvider/capabilities/read')
      result = { imageGeneration: mode !== 'unsupported' };
    if (m.method === 'thread/start') result = { thread: { id: 'image-thread' } };
    if (m.method === 'turn/start') {
      result = { turn: { id: 'image-turn' } };
      if (mode !== 'pending') {
        const item = {
          type: 'imageGeneration',
          id: 'image',
          status: mode === 'limit' ? 'failed' : 'completed',
          result:
            mode === 'invalid' ? 'not base64!' : mode === 'limit' ? '' : image.toString('base64'),
          savedPath: 'C:/must/not/read.png',
          failure: mode === 'limit' ? { type: 'usageLimitExceeded' } : null,
        };
        emit({
          method: 'item/completed',
          params: { threadId: 'stranger', turnId: 'image-turn', item },
        });
        emit({
          method: 'item/completed',
          params: { threadId: 'image-thread', turnId: 'image-turn', item },
        });
        emit({
          method: 'turn/completed',
          params: { threadId: 'image-thread', turn: { id: 'image-turn', status: 'completed' } },
        });
      }
    }
    if (m.method === 'turn/interrupt')
      emit({
        method: 'turn/completed',
        params: { threadId: 'image-thread', turn: { id: 'image-turn', status: 'interrupted' } },
      });
    emit({ id: m.id, result });
  });
  const worker: CodexWorker = {
    work,
    rpc,
    isUsable: () => usable,
    authenticate: async () => {},
    close: async () => {
      usable = false;
      rpc.fail();
    },
    invalidate: async () => {
      usable = false;
      rpc.fail();
    },
  };
  t.after(async () => {
    await worker.close();
    await rm(work, { recursive: true, force: true });
  });
  return { worker, calls, image };
}
test('native image output is captured before start reply, normalized, and cleaned without reading savedPath', async (t) => {
  const f = await fixture(t);
  const result = await generateCodexImage(f.worker, 'gpt-5.6-luna', body);
  assert.equal(
    (await sharp(Buffer.from(result.data[0].b64_json, 'base64')).metadata()).format,
    'jpeg',
  );
  assert.deepEqual(await readdir(f.worker.work), []);
  assert.equal(f.worker.isUsable(), true);
  assert.equal(
    f.worker.rpc.since(0).some((m) => m.params?.threadId === 'image-thread'),
    false,
  );
  assert.equal(
    f.calls.find((m) => m.method === 'thread/start').params.config['features.image_generation'],
    true,
  );
  assert.equal(f.calls.find((m) => m.method === 'turn/start').params.outputSchema, undefined);
});
for (const mode of ['unsupported', 'limit', 'invalid'])
  test(`image ${mode} fails without killing a completed worker or falling back`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(generateCodexImage(f.worker, 'gpt-5.6-luna', body), /CODEX_IMAGE_/);
    assert.equal(f.worker.isUsable(), true);
    assert.deepEqual(await readdir(f.worker.work), []);
  });
test('aborting generation interrupts the owned turn and releases its files', async (t) => {
  const f = await fixture(t, 'pending');
  const abort = new AbortController();
  const pending = generateCodexImage(f.worker, 'gpt-5.6-luna', body, abort.signal);
  const timer = setInterval(() => {
    if (f.calls.some((m) => m.method === 'turn/start')) abort.abort();
  }, 5);
  try {
    await assert.rejects(pending, /IMAGE_CANCELLED/);
  } finally {
    clearInterval(timer);
  }
  assert.ok(f.calls.some((m) => m.method === 'turn/interrupt'));
  assert.equal(f.worker.isUsable(), true);
  assert.deepEqual(await readdir(f.worker.work), []);
});
