import { positiveInteger } from './config.js';

// Presentation budget retained independently of the game's photo-send allowance.
export const SCENE_ACTION_BUDGET = 4;

export interface AiConfig {
  mode: 'mock' | 'live';
  apiKey?: string;
  liveModel: string;
  responseModel: string;
  gameModel: string;
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
  gameOutputTokens: number;
  timeoutMs: number;
  imageModel: string;
  inspectionModel: string;
  imageRequestsPerMinute: number;
  imageConcurrent: number;
  inspectionConcurrent: number;
  globalImageAttempts: number;
  globalInspectionAttempts: number;
  imageJobTimeoutMs: number;
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
  if (mode === 'live' && values.NODE_ENV === 'production') {
    for (const name of ['AI_GLOBAL_IMAGE_ATTEMPTS', 'AI_GLOBAL_INSPECTION_ATTEMPTS']) {
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
  const gameModel = model('GAME_MODEL', 'gpt-5.6-sol');
  const imageModel = model('IMAGE_MODEL', 'gpt-image-2.5-flare');
  const inspectionModel = model('IMAGE_INSPECTION_MODEL', 'gpt-5.6-luna');
  if (imageModel !== 'gpt-image-2.5-flare' || inspectionModel !== 'gpt-5.6-luna')
    throw new Error('Unsupported media model');
  if (positiveInteger(values, 'IMAGE_JOB_TIMEOUT_SECONDS', 150, 300) < 30)
    throw new Error('IMAGE_JOB_TIMEOUT_SECONDS invalid');
  return {
    imageModel,
    inspectionModel,
    imageRequestsPerMinute: positiveInteger(values, 'IMAGE_REQUESTS_PER_MINUTE', 5, 1000),
    imageConcurrent: positiveInteger(values, 'IMAGE_CONCURRENT', 2, 5),
    inspectionConcurrent: positiveInteger(values, 'IMAGE_INSPECTION_CONCURRENT', 2, 5),
    globalImageAttempts: positiveInteger(values, 'AI_GLOBAL_IMAGE_ATTEMPTS', 100),
    globalInspectionAttempts: positiveInteger(values, 'AI_GLOBAL_INSPECTION_ATTEMPTS', 100),
    imageJobTimeoutMs: positiveInteger(values, 'IMAGE_JOB_TIMEOUT_SECONDS', 150, 300) * 1000,
    mode,
    apiKey: mode === 'live' ? values.OPENAI_API_KEY : undefined,
    liveModel,
    responseModel,
    gameModel,
    liveModels: [liveModel],
    responseModels: [...new Set([responseModel, gameModel])],
    liveAttemptsPerPlay: positiveInteger(values, 'AI_LIVE_ATTEMPTS_PER_PLAY', 3, 100),
    responsesPerPlay: positiveInteger(values, 'AI_RESPONSES_PER_PLAY', 80, 1000),
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
    gameOutputTokens: positiveInteger(values, 'AI_GAME_MAX_OUTPUT_TOKENS', 4096, 4096),
    timeoutMs: 30000,
  };
}
