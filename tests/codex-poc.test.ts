import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Rpc } from '../tools/codex-poc/rpc.js';
import { finalText, judge, login, requireChatGPT, safeLimits } from '../tools/codex-poc/probe.js';
import { childEnvironment, parseArgs } from '../tools/codex-poc.js';
import { failureMessage, selectBinary, resolveBinary } from '../tools/codex-poc/binary.js';
import { PocError } from '../tools/codex-poc/rpc.js';

test('binary discovery selects the compatible desktop executable when PATH is missing or older', () => {
  for (const pathVersion of [null, 'old']) {
    assert.equal(
      selectBinary(['codex.exe', '/desktop/codex.exe'], 'expected', (p) =>
        p === 'codex.exe' ? pathVersion : 'expected',
      ),
      '/desktop/codex.exe',
    );
  }
  assert.throws(() => selectBinary(['missing'], 'expected', () => null), /BINARY_UNAVAILABLE/);
  assert.throws(() => selectBinary(['old'], 'expected', () => 'old'), /VERSION_MISMATCH/);
});

test('explicit executable is not replaced by an automatically discovered one', async () => {
  const path = process.platform === 'win32' ? 'C:\\chosen\\codex.exe' : '/chosen/codex';
  assert.deepEqual(await resolveBinary({}, path), [path]);
  await assert.rejects(resolveBinary({}, 'relative'), /BINARY_MUST_BE_ABSOLUTE/);
});

test('startup diagnosis provides an actionable hint without raw error details', () => {
  assert.match(failureMessage(new PocError('CODEX_BINARY_UNAVAILABLE')), /CODEX_POC_BIN/);
  assert.equal(failureMessage(new Error('secret token')).includes('secret'), false);
});

function fixture(handle?: (m: any, emit: (m: any) => void) => void) {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new Rpc(input, output);
  const emit = (m: any) => output.write(JSON.stringify(m) + '\n');
  input.on('data', (b) => handle?.(JSON.parse(b.toString()), emit));
  return { rpc, emit, output };
}

test('isolated environment drops every API/auth/session value, uses a separate home', () => {
  const env = childEnvironment(
    {
      PATH: 'path',
      OPENAI_API_KEY: 'secret',
      CODEX_ACCESS_TOKEN: 'secret',
      CODEX_HOME: 'original',
      CODEX_THREAD_ID: 'old',
      AWS_ACCESS_KEY_ID: 'secret',
    },
    'isolated',
  );
  assert.deepEqual(env, { PATH: 'path', CODEX_HOME: 'isolated' });
});
test('CLI rejects unknown/missing inputs and defaults to one Luna judgment', () => {
  assert.equal(parseArgs([]).model, 'gpt-5.6-luna');
  assert.throws(() => parseArgs(['--prompt']));
  assert.throws(() => parseArgs(['--login', 'token']));
  assert.throws(() => parseArgs(['--fallback']));
});
test('RPC handles split JSON, early notifications, and response IDs', async () => {
  const { rpc, output } = fixture((m) => {
    output.write('{"method":"done","params":{}}\n{"id":');
    output.write(`${m.id},"result":{"ok":true}}\n`);
  });
  const cursor = rpc.cursor();
  assert.deepEqual(await rpc.call('test'), { ok: true });
  assert.equal((await rpc.wait(cursor, (m) => m.method === 'done', 100)).method, 'done');
  rpc.fail();
});
test('RPC timeout closes the whole connection; late replies cannot revive it', async () => {
  const { rpc, emit } = fixture();
  await assert.rejects(rpc.call('test', {}, 10), /RPC_TIMEOUT/);
  emit({ id: 1, result: 'late' });
  await assert.rejects(rpc.call('again'), /RPC_TIMEOUT/);
});
test('malformed JSON and unexpected server requests fail closed', async () => {
  for (const payload of ['{oops}\n', '{"id":99,"method":"tool/requestUserInput"}\n']) {
    const { rpc, output } = fixture();
    const result = rpc.call('test');
    output.write(payload);
    await assert.rejects(result, /RPC_INVALID_JSON|UNEXPECTED_SERVER_REQUEST/);
  }
});
test('RPC errors redact upstream messages', async () => {
  const { rpc } = fixture((m, emit) =>
    emit({ id: m.id, error: { code: -32600, message: 'secret' } }),
  );
  await assert.rejects(
    rpc.call('test'),
    (e) => e instanceof Error && e.message === 'RPC_ERROR_-32600',
  );
  rpc.fail();
});
test('login accepts early completion but rejects API key and non-OpenAI URLs', async () => {
  const { rpc } = fixture((m, emit) => {
    if (m.method === 'account/login/start') {
      emit({ method: 'account/login/completed', params: { loginId: 'l', success: true } });
      emit({ method: 'account/updated', params: { authMode: 'chatgpt' } });
      emit({
        id: m.id,
        result: {
          loginId: 'l',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'TEST',
        },
      });
    } else
      emit({
        id: m.id,
        result: { account: { type: 'chatgpt', planType: 'plus', email: 'private' } },
      });
  });
  let shown = false;
  assert.equal(
    await login(rpc, 'device', () => {
      shown = true;
    }),
    'plus',
  );
  assert.equal(shown, true);
  rpc.fail();
  assert.throws(() => requireChatGPT({ account: { type: 'apiKey' } }), /CHATGPT_LOGIN_REQUIRED/);
  const bad = fixture((m, emit) =>
    emit({
      id: m.id,
      result: { loginId: 'l', verificationUrl: 'https://attacker.example/', userCode: 'x' },
    }),
  );
  await assert.rejects(
    login(bad.rpc, 'device', () => assert.fail()),
    /INVALID_LOGIN_URL/,
  );
  bad.rpc.fail();
});
test('login waits for auth reload after completion, ignoring earlier account updates', async () => {
  let reads = 0;
  let loaded = false;
  const { rpc, emit } = fixture((m, send) => {
    if (m.method === 'account/login/start') {
      send({ method: 'account/updated', params: { authMode: null } });
      send({
        id: m.id,
        result: {
          loginId: 'l',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'TEST',
        },
      });
    } else if (m.method === 'account/read') {
      reads++;
      send({
        id: m.id,
        result: { account: loaded ? { type: 'chatgpt', planType: 'plus' } : null },
      });
    } else send({ id: m.id, result: {} });
  });
  const result = login(rpc, 'device', () => {});
  emit({ method: 'account/login/completed', params: { loginId: 'l', success: true } });
  // Allow the completion handler to run while the native auth cache is still empty.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reads, 0);
  loaded = true;
  emit({ method: 'account/updated', params: { authMode: 'chatgpt' } });
  assert.equal(await result, 'plus');
  assert.equal(reads, 1);
  rpc.fail();
});

test('login rejects non-ChatGPT or missing accounts after the update and cancels', async () => {
  for (const authMode of [null, 'apikey', 'chatgpt']) {
    let cancelled = false;
    const { rpc } = fixture((m, emit) => {
      if (m.method === 'account/login/start') {
        emit({
          id: m.id,
          result: {
            loginId: 'l',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'TEST',
          },
        });
        emit({ method: 'account/login/completed', params: { loginId: 'l', success: true } });
        emit({ method: 'account/updated', params: { authMode } });
      } else {
        if (m.method === 'account/login/cancel') cancelled = true;
        emit({ id: m.id, result: { account: null } });
      }
    });
    await assert.rejects(
      login(rpc, 'device', () => {}),
      /CHATGPT_LOGIN_REQUIRED/,
    );
    assert.equal(cancelled, true);
    rpc.fail();
  }
});

test('usage gates block exhausted or explicitly forbidden ordinary usage', () => {
  assert.throws(() => safeLimits({ ordinaryUsageAllowed: false }), /INCLUDED_USAGE/);
  assert.throws(() => safeLimits({ rateLimits: { primary: { usedPercent: 100 } } }), /USAGE_LIMIT/);
  assert.deepEqual(safeLimits({ rateLimits: { primary: null } }), [
    { limitId: undefined, primaryUsedPercent: null, secondaryUsedPercent: null },
  ]);
});
test('final message selection excludes commentary, duplicates, tools and unsuccessful turns', () => {
  const item = { type: 'agentMessage', id: 'a', phase: 'final_answer', text: '{"ok":true}' };
  const events = [{ method: 'item/completed', params: { threadId: 't', turnId: 'u', item } }];
  assert.equal(finalText(events, 't', 'u', { status: 'completed', items: [item] }), item.text);
  assert.throws(() => finalText(events, 't', 'u', { status: 'failed' }), /NOT_COMPLETED/);
  assert.throws(
    () =>
      finalText([], 't', 'u', { status: 'completed', items: [{ ...item, phase: 'commentary' }] }),
    /INVALID_FINAL/,
  );
  assert.throws(
    () =>
      finalText(events, 't', 'u', {
        status: 'completed',
        items: [{ type: 'commandExecution', id: 'cmd' }],
      }),
    /TOOL/,
  );
});
test('judge matches turn IDs and accepts notifications before turn/start response', async () => {
  const decision = { possible: true, reason: '紙は切れます', observedObject: '写真なし' };
  const { rpc } = fixture((m, emit) => {
    if (m.method === 'model/list')
      emit({
        id: m.id,
        result: { data: [{ model: 'm', inputModalities: ['text'] }], nextCursor: null },
      });
    if (m.method === 'thread/start') emit({ id: m.id, result: { thread: { id: 't' } } });
    if (m.method === 'turn/start') {
      emit({
        method: 'turn/completed',
        params: { threadId: 'other', turn: { id: 'u', status: 'failed' } },
      });
      emit({
        method: 'item/completed',
        params: {
          threadId: 't',
          turnId: 'u',
          item: {
            type: 'agentMessage',
            id: 'a',
            phase: 'final_answer',
            text: JSON.stringify(decision),
          },
        },
      });
      emit({
        method: 'turn/completed',
        params: { threadId: 't', turn: { id: 'u', status: 'completed', items: [] } },
      });
      emit({ id: m.id, result: { turn: { id: 'u' } } });
    }
  });
  assert.deepEqual((await judge(rpc, { model: 'm', prompt: 'p', cwd: '.' })).decision, decision);
  rpc.fail();
});
