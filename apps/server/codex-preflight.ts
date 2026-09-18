import { startWorker } from '../../tools/codex-poc/worker.js';

/** Build/startup contract probe: no login, user data, or billable generation. */
export async function codexPreflight() {
  const worker = await startWorker();
  try {
    const capabilities = await worker.rpc.call('modelProvider/capabilities/read', {});
    if (capabilities.imageGeneration !== true) throw new Error('CODEX_IMAGE_UNAVAILABLE');
    await worker.rpc.call('thread/realtime/listVoices', {});
  } finally {
    await worker.close();
  }
}

/** Explicit network probe: obtains a fresh device challenge, never displays it, then cancels. */
export async function codexDeviceLoginPreflight() {
  const worker = await startWorker();
  try {
    const result = await worker.rpc.call(
      'account/login/start',
      { type: 'chatgptDeviceCode' },
      30_000,
    );
    if (
      typeof result.loginId !== 'string' ||
      typeof result.userCode !== 'string' ||
      new URL(result.verificationUrl).origin !== 'https://auth.openai.com'
    )
      throw new Error('LOGIN_PREFLIGHT_INVALID_RESPONSE');
    await worker.rpc.call('account/login/cancel', { loginId: result.loginId });
  } finally {
    await worker.close();
  }
}
