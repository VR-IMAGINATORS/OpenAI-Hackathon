import type { AuthMode } from '../../packages/shared/api.js';
import { bindHost, positiveInteger, readEnvironment } from '../../packages/server/config.js';
export interface RelayConfig {
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
  return {
    host: bindHost(values.RELAY_HOST, 'RELAY_HOST'),
    port: positiveInteger(values, 'RELAY_PORT', 4311, 65535),
    authMode, passphrase,
    tokenTtlMs: positiveInteger(values, 'RELAY_TOKEN_TTL_SECONDS', 300, 86400) * 1000,
    tokenMaxRequests: positiveInteger(values, 'RELAY_TOKEN_MAX_REQUESTS', 4, 10_000),
    maxSessions: positiveInteger(values, 'RELAY_MAX_SESSIONS', 100, 10_000),
    maxRequests: positiveInteger(values, 'RELAY_MAX_REQUESTS', 1000),
    authMaxAttempts: positiveInteger(values, 'RELAY_AUTH_MAX_ATTEMPTS', 30, 10_000),
    authWindowMs: positiveInteger(values, 'RELAY_AUTH_WINDOW_SECONDS', 60, 3600) * 1000,
    now: Date.now,
  };
}
