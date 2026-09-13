import { positiveInteger } from './config.js';

export interface AiConfig {
  mode: 'mock' | 'live';
  apiKey?: string;
  liveModel: string;
  responseModel: string;
  liveModels: string[];
  responseModels: string[];
  liveAttemptsPerPlay: number;
  responsesPerPlay: number;
  responseConcurrentPerPlay: number;
  liveConcurrentGlobal: number;
  responseConcurrentGlobal: number;
  globalLiveAttempts: number;
  globalResponseAttempts: number;
  outputTokens: number;
  timeoutMs: number;
}

/** Receives already-loaded settings; never reads a private environment file. */
export function loadAiConfig(values: NodeJS.ProcessEnv): AiConfig {
  const mode = values.AI_MODE ?? 'mock';
  if (mode !== 'mock' && mode !== 'live') throw new Error('Invalid AI_MODE');
  if (mode === 'live') {
    for (const name of [
      'OPENAI_API_KEY',
      'AI_GLOBAL_LIVE_ATTEMPTS',
      'AI_GLOBAL_RESPONSE_ATTEMPTS',
    ]) {
      if (!values[name]?.trim()) throw new Error(name + ' required');
    }
  }
  function model(name: string, fallback: string): string {
    const value = values[name] ?? fallback;
    if (!/^[-a-zA-Z0-9.]+$/.test(value)) throw new Error(name + ' invalid');
    return value;
  }
  const liveModel = model('LIVE_MODEL', 'gpt-live-1');
  const responseModel = model('RESPONSE_MODEL', 'gpt-5.6-terra');
  return {
    mode,
    apiKey: mode === 'live' ? values.OPENAI_API_KEY : undefined,
    liveModel,
    responseModel,
    liveModels: [liveModel],
    responseModels: [responseModel],
    liveAttemptsPerPlay: positiveInteger(values, 'AI_LIVE_ATTEMPTS_PER_PLAY', 3, 100),
    responsesPerPlay: positiveInteger(values, 'AI_RESPONSES_PER_PLAY', 40, 1000),
    responseConcurrentPerPlay: positiveInteger(values, 'AI_RESPONSE_CONCURRENT_PER_PLAY', 1, 100),
    liveConcurrentGlobal: positiveInteger(
      values,
      'AI_LIVE_CONCURRENT_GLOBAL',
      positiveInteger(values, 'MAX_PLAYERS', 5, 100),
      100,
    ),
    responseConcurrentGlobal: positiveInteger(values, 'AI_RESPONSE_CONCURRENT_GLOBAL', 5, 100),
    globalLiveAttempts: positiveInteger(values, 'AI_GLOBAL_LIVE_ATTEMPTS', 50),
    globalResponseAttempts: positiveInteger(values, 'AI_GLOBAL_RESPONSE_ATTEMPTS', 1000),
    outputTokens: positiveInteger(values, 'AI_MAX_OUTPUT_TOKENS', 1000, 1000),
    timeoutMs: 30000,
  };
}
