import { positiveInteger } from './config.js';

export interface EndingConfig {
  enabled: boolean;
  apiKey?: string;
  globalAttempts: number;
  timeoutMs: number;
  concurrent: number;
}

/** Accepts loaded server settings. Never reads environment files or starts a provider. */
export function loadEndingConfig(values: NodeJS.ProcessEnv): EndingConfig {
  const flag = values.ENDING_VIDEO_ENABLED ?? 'false';
  if (flag !== 'true' && flag !== 'false') throw new Error('ENDING_VIDEO_ENABLED invalid');
  const enabled = flag === 'true';
  const timeoutSeconds = positiveInteger(values, 'ENDING_JOB_TIMEOUT_SECONDS', 480, 540);
  if (timeoutSeconds < 60) throw new Error('ENDING_JOB_TIMEOUT_SECONDS must be at least 60');
  const concurrent = positiveInteger(values, 'ENDING_CONCURRENT', 2, 2);
  if (enabled) {
    if (!values.FAL_KEY?.trim()) throw new Error('FAL_KEY required');
    if (!values.AI_GLOBAL_VIDEO_ATTEMPTS?.trim())
      throw new Error('AI_GLOBAL_VIDEO_ATTEMPTS required');
  }
  const attempts = positiveInteger(values, 'AI_GLOBAL_VIDEO_ATTEMPTS', 1, 1000);
  return {
    enabled,
    apiKey: enabled ? values.FAL_KEY : undefined,
    globalAttempts: enabled ? attempts : 0,
    timeoutMs: timeoutSeconds * 1000,
    concurrent,
  };
}
