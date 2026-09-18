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
