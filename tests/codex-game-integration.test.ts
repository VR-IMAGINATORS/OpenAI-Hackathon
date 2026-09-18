import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rpc } from '../tools/codex-poc/rpc.js';
import { createGameResponder } from '../tools/codex-poc/game-responder.js';
import { localCodexEnvironment } from '../tools/play-codex.js';
import { AiService, AiServiceError } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { canRetryJudgment } from '../apps/local-server/ai-failure.js';
import { responseText } from '../apps/local-server/structured-response.js';

const body = {
  model: 'gpt-5.6-sol',
  instructions: 'ゲーム固有の判断指示',
  input: [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: '確定状態' },
        { type: 'input_image', image_url: 'data:image/jpeg;base64,eA==' },
      ],
    },
  ],
  text: {
    format: {
      type: 'json_schema',
      name: 'game',
      strict: true,
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    },
  },
  store: false,
  max_output_tokens: 2048,
};

async function fixture(t: any, mode: 'success' | 'wait' | 'unknown-start' | 'limit' = 'success') {
  const work = await mkdtemp(join(tmpdir(), 'codex-adapter-test-'));
  const input = new PassThrough(),
    output = new PassThrough();
  const rpc = new Rpc(input, output);
  const calls: any[] = [];
  let usable = true;
  const emit = (v: any) => output.write(JSON.stringify(v) + '\n');
  let counter = 0;
  let threadId = '';
  let turnId = '';
  input.on('data', (b) => {
    const m = JSON.parse(b.toString());
    calls.push(m);
    if (m.method === 'account/rateLimits/read')
      emit({ id: m.id, result: { ordinaryUsageAllowed: mode !== 'limit' } });
    if (m.method === 'thread/start') {
      threadId = `t${++counter}`;
      emit({ id: m.id, result: { thread: { id: threadId } } });
    }
    if (m.method === 'turn/start') {
      turnId = `u${counter}`;
      if (mode === 'unknown-start') {
        emit({ id: m.id, error: { code: -1 } });
        return;
      }
      if (mode === 'success') {
        emit({
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: { id: 'a', type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' },
          },
        });
        emit({
          method: 'turn/completed',
          params: { threadId, turn: { id: turnId, status: 'completed', items: [] } },
        });
      }
      emit({ id: m.id, result: { turn: { id: turnId } } });
    }
    if (m.method === 'turn/interrupt') {
      emit({
        method: 'turn/completed',
        params: { threadId, turn: { id: turnId, status: 'interrupted' } },
      });
      emit({ id: m.id, result: {} });
    }
    if (m.method === 'thread/unsubscribe') emit({ id: m.id, result: {} });
  });
  t.after(async () => {
    rpc.fail();
    await rm(work, { recursive: true, force: true });
  });
  return {
    calls,
    work,
    rpc,
    worker: {
      rpc,
      work,
      isUsable: () => usable,
      invalidate: async () => {
        usable = false;
        rpc.fail();
      },
    },
  };
}

test('local launcher prevents public hosting and fixes single-player/live settings', () => {
  const env = localCodexEnvironment({
    HOST: '0.0.0.0',
    PUBLIC_APP_URL: 'https://example.com',
    MAX_PLAYERS: '5',
    AI_MODE: 'mock',
  });
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.MAX_PLAYERS, '1');
  assert.equal(env.PUBLIC_APP_URL, '');
  assert.equal(env.AI_MODE, 'live');
  assert.throws(() => localCodexEnvironment({ NODE_ENV: 'production' }), /LOCAL_ONLY/);
});

test('adapter preserves real game instructions/schema and releases each thread/photo/journal', async (t) => {
  const f = await fixture(t);
  const responder = createGameResponder(f.worker, body.model);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(JSON.parse(responseText(await responder(body))), { ok: true });
    assert.deepEqual(await readdir(f.work), []);
    assert.equal(f.rpc.cursor(), 0);
  }
  const start = f.calls.find((m) => m.method === 'thread/start');
  assert.equal(start.params.developerInstructions, body.instructions);
  assert.equal(start.params.ephemeral, true);
  const turn = f.calls.find((m) => m.method === 'turn/start');
  assert.deepEqual(turn.params.outputSchema, body.text.format.schema);
  assert.equal(turn.params.input[0].text, '確定状態');
  assert.equal(turn.params.input[1].type, 'localImage');
  await assert.rejects(readFile(turn.params.input[1].path), /ENOENT/);
  assert.equal(f.calls.filter((m) => m.method === 'thread/unsubscribe').length, 3);
});

test('abort interrupts and confirms the correct turn without destroying a healthy worker', async (t) => {
  const f = await fixture(t, 'wait');
  const controller = new AbortController();
  const responder = createGameResponder(f.worker, body.model);
  const pending = responder(body, controller.signal);
  while (!f.calls.some((m) => m.method === 'turn/start'))
    await new Promise((r) => setTimeout(r, 1));
  controller.abort();
  await assert.rejects(pending, (e: any) => e.code === 'CONTROL_CANCELLED');
  assert.deepEqual(f.calls.find((m) => m.method === 'turn/interrupt').params, {
    threadId: 't1',
    turnId: 'u1',
  });
  assert.equal(f.worker.isUsable(), true);
  assert.deepEqual(await readdir(f.work), []);
});

test('unknown start and usage exhaustion fail without fallback or automatic retry', async (t) => {
  for (const mode of ['unknown-start', 'limit'] as const) {
    const f = await fixture(t, mode);
    await assert.rejects(
      createGameResponder(f.worker, body.model)(body),
      (e: any) => e.code === 'CODEX_UNAVAILABLE' && !canRetryJudgment(e),
    );
    assert.equal(f.worker.isUsable(), false);
    assert.equal(f.calls.filter((m) => m.method === 'turn/start').length, mode === 'limit' ? 0 : 1);
  }
});

test('AiService routes only the game lane and retains admission budgets and no fallback', async () => {
  let apiCalls = 0,
    codexCalls = 0;
  const config = { ...loadAiConfig({ AI_MODE: 'mock' }), responsesPerPlay: 2, timeoutMs: 1000 };
  const ai = new AiService(
    config,
    {
      createResponse: async () => {
        apiCalls++;
        return {};
      },
      createLiveSession: async () => {
        throw Error('not used');
      },
      hangup: async () => {},
    },
    () => 0,
    async () => {
      codexCalls++;
      throw new AiServiceError(503, 'CODEX_UNAVAILABLE', '停止');
    },
  );
  ai.register('p', 1000);
  await assert.rejects(ai.respondGame('p', body), (e: any) => e.code === 'CODEX_UNAVAILABLE');
  assert.equal(apiCalls, 0);
  assert.equal(codexCalls, 1);
  await ai.respond('p', { ...body, model: config.responseModel, max_output_tokens: 1000 });
  assert.equal(apiCalls, 1);
  await assert.rejects(ai.respondGame('p', body), (e: any) => e.code === 'REQUEST_LIMIT');
  assert.equal(codexCalls, 1);
  assert.equal(ai.snapshot().responseAttempts, 2);
});

test('already cancelled requests do not start Codex or spend budget', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createGameResponder(f.worker, body.model)(body, controller.signal),
    (e: any) => e.code === 'CONTROL_CANCELLED',
  );
  assert.equal(f.calls.length, 0);
});

test('cleanup failure invalidates the worker and is not a retryable upstream error', async (t) => {
  const f = await fixture(t);
  f.rpc.clearEvents = () => {
    throw new Error('cleanup failed');
  };
  await assert.rejects(
    createGameResponder(f.worker, body.model)(body),
    (e: any) => e.code === 'CODEX_UNAVAILABLE' && !canRetryJudgment(e),
  );
  assert.equal(f.worker.isUsable(), false);
});
