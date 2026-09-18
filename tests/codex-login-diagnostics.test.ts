import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Rpc } from '../tools/codex-poc/rpc.js';
import { loginRpcFailure } from '../tools/codex-poc/login-diagnostics.js';

test('login diagnostics return only fixed labels and never upstream credentials', async () => {
  assert.equal(
    loginRpcFailure('certificate verify failed: UnknownIssuer secret=private'),
    'LOGIN_TLS_ERROR',
  );
  assert.equal(loginRpcFailure('HTTP 403 Forbidden secret=private'), 'LOGIN_HTTP_403');
  assert.equal(
    loginRpcFailure('error sending request for url https://auth.openai.com/private'),
    'LOGIN_NETWORK_ERROR',
  );
  assert.equal(loginRpcFailure('access_token=private'), undefined);
  const input = new PassThrough(),
    output = new PassThrough();
  const rpc = new Rpc(input, output);
  input.on('data', (bytes) => {
    const request = JSON.parse(bytes.toString());
    output.write(
      JSON.stringify({
        id: request.id,
        error: { code: -32603, message: 'certificate UnknownIssuer access_token=private' },
      }) + '\n',
    );
  });
  await assert.rejects(rpc.call('account/login/start'), { message: 'LOGIN_TLS_ERROR' });
  await assert.rejects(rpc.call('other/method'), { message: 'RPC_ERROR_-32603' });
  rpc.fail();
});
