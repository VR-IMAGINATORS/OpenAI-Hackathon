import type { AuthMode } from '../../packages/shared/api.js';
import { bindHost, positiveInteger, readEnvironment } from '../../packages/server/config.js';
export interface LiveLimits {
 liveModels:string[];responseModels:string[];tokenLiveAttempts:number;tokenResponseAttempts:number;
 globalLiveAttempts:number;globalResponseAttempts:number;globalLiveConcurrent:number;globalResponseConcurrent:number;
 durationMs:number;heartbeatMs:number;outputTokens:number;
}
export interface RelayConfig {
  mode?: 'mock'|'live'; apiKey?:string; live?:LiveLimits; authGlobalMaxAttempts?:number;
  host: string;
  port: number;
  authMode: AuthMode;
  passphrase?: string;
  tokenTtlMs: number;
  tokenMaxRequests: number;
  maxSessions: number;
  maxRequests: number;
  authMaxAttempts: number;
  authWindowMs: number;
  now: () => number;
}
export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): RelayConfig {
  const values = readEnvironment('.env.relay.local', env, cwd);
  const demo = values.FOUNDATION_DEMO === '1';
  const authMode = demo ? 'required' : values.RELAY_AUTH_MODE ?? 'required';
  if (authMode !== 'required' && authMode !== 'none') throw new Error('RELAY_AUTH_MODE must be required or none');
  const passphrase = demo ? 'local-demo-only' : values.RELAY_PASSPHRASE;
  if (authMode === 'required' && (!passphrase?.trim() || passphrase.length > 256)) {
    throw new Error('RELAY_PASSPHRASE is required (1 to 256 characters)');
  }
  const mode = demo ? 'mock' : values.RELAY_MODE ?? 'mock';
  if(mode!=='mock'&&mode!=='live')throw new Error('Invalid RELAY_MODE');
  let live:LiveLimits|undefined;
  if(mode==='live'){
    if(!values.OPENAI_API_KEY?.trim())throw new Error('OPENAI_API_KEY required');
    for(const name of ['RELAY_GLOBAL_LIVE_ATTEMPTS','RELAY_GLOBAL_RESPONSE_ATTEMPTS','RELAY_GLOBAL_LIVE_CONCURRENT','RELAY_GLOBAL_RESPONSE_CONCURRENT','RELAY_AUTH_GLOBAL_MAX_ATTEMPTS'])if(!values[name])throw new Error(name+' required');
    const models=(name:string)=>{const entries=values[name]?.split(',').map(v=>v.trim()).filter(Boolean);if(!entries?.length||entries.some(v=>!/^[-a-zA-Z0-9.]+$/.test(v)))throw new Error(name+' required');return entries;};
    live={liveModels:models('RELAY_LIVE_MODELS'),responseModels:models('RELAY_RESPONSE_MODELS'),
      tokenLiveAttempts:positiveInteger(values,'RELAY_TOKEN_LIVE_ATTEMPTS',3,100),tokenResponseAttempts:positiveInteger(values,'RELAY_TOKEN_RESPONSE_ATTEMPTS',40,1000),
      globalLiveAttempts:positiveInteger(values,'RELAY_GLOBAL_LIVE_ATTEMPTS',1),globalResponseAttempts:positiveInteger(values,'RELAY_GLOBAL_RESPONSE_ATTEMPTS',1),
      globalLiveConcurrent:positiveInteger(values,'RELAY_GLOBAL_LIVE_CONCURRENT',1,100),globalResponseConcurrent:positiveInteger(values,'RELAY_GLOBAL_RESPONSE_CONCURRENT',1,100),
      durationMs:positiveInteger(values,'RELAY_LIVE_DURATION_SECONDS',600,3600)*1000,heartbeatMs:30000,outputTokens:positiveInteger(values,'RELAY_MAX_OUTPUT_TOKENS',1000,1000)};
  }
  return {
    mode, live, apiKey:mode==='live'?values.OPENAI_API_KEY:undefined,
    authGlobalMaxAttempts:positiveInteger(values,'RELAY_AUTH_GLOBAL_MAX_ATTEMPTS',1000),
    host: bindHost(values.RELAY_HOST, 'RELAY_HOST'),
    port: positiveInteger(values, 'RELAY_PORT', 4311, 65535),
    authMode, passphrase,
    tokenTtlMs: positiveInteger(values, 'RELAY_TOKEN_TTL_SECONDS', mode==='live'?900:300, 86400) * 1000,
    tokenMaxRequests: positiveInteger(values, 'RELAY_TOKEN_MAX_REQUESTS', 4, 10_000),
    maxSessions: positiveInteger(values, 'RELAY_MAX_SESSIONS', 100, 10_000),
    maxRequests: positiveInteger(values, 'RELAY_MAX_REQUESTS', 1000),
    authMaxAttempts: positiveInteger(values, 'RELAY_AUTH_MAX_ATTEMPTS', 30, 10_000),
    authWindowMs: positiveInteger(values, 'RELAY_AUTH_WINDOW_SECONDS', 60, 3600) * 1000,
    now: Date.now,
  };
}
