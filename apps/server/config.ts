import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  allowedHosts,
  allowedOrigins,
  bindHost,
  positiveInteger,
  readEnvironment,
} from '../../packages/server/config.js';
import { loadAiConfig, type AiConfig } from '../../packages/server/ai-config.js';
import {
  localizeScenario,
  parseScenarioV2,
  type Scenario,
} from '../../packages/shared/scenario.js';
import { ScenarioCatalog, readConfigJson } from './scenario-catalog.js';

export interface HostedConfig {
  host: string;
  port: number;
  publicUrl?: string;
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  secureCookie: boolean;
  passphrase: string;
  opsToken: string;
  version: string;
  scenario: Scenario;
  scenarioCatalog?: ScenarioCatalog;
  webRoot: string;
  capacity: number;
  ttlMs: number;
  recoveryMs: number;
  authAttempts: number;
  ai: AiConfig;
}
export function loadHostedConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): HostedConfig {
  const values =
    env.NODE_ENV === 'production' || env.HOSTED_NO_ENV_FILE === '1'
      ? env
      : readEnvironment('.env.local', env, cwd);
  const port = positiveInteger(values, 'PORT', 4310, 65535);
  let publicUrl: string | undefined;
  if (values.PUBLIC_APP_URL) {
    const url = new URL(values.PUBLIC_APP_URL);
    if (
      url.protocol !== 'https:' ||
      url.origin !== values.PUBLIC_APP_URL ||
      url.username ||
      url.password
    )
      throw new Error('PUBLIC_APP_URL must be an HTTPS origin');
    publicUrl = url.origin;
  }
  const passphrase = values.APP_PASSPHRASE ?? '';
  if (!passphrase.trim() || passphrase.length > 256) throw new Error('APP_PASSPHRASE is required');
  const opsToken = values.OPS_TOKEN ?? '';
  if (opsToken && opsToken.length < 32)
    throw new Error('OPS_TOKEN requires at least 32 characters');
  if (values.NODE_ENV === 'production' && (!publicUrl || !opsToken))
    throw new Error('Production requires PUBLIC_APP_URL and OPS_TOKEN');
  const hosts = ['127.0.0.1:' + port, 'localhost:' + port];
  const origins = hosts.map((host) => 'http://' + host);
  if (publicUrl) {
    hosts.push(new URL(publicUrl).host);
    origins.push(publicUrl);
  }
  const scenarioPath = resolve(cwd, values.SCENARIO_PATH ?? 'scenarios/mobile-playtest.json');
  // Keep detailed planner field errors at startup; HTTP admission uses CONFIG_INVALID.
  const scenario = localizeScenario(parseScenarioV2(readConfigJson(scenarioPath)), 'ja');
  const scenarioCatalog = new ScenarioCatalog({
    scenarioPath,
    coreConfigPath: resolve(cwd, 'config/game-core.json'),
  });
  scenarioCatalog.current('ja');
  const ai = loadAiConfig(values);
  const capacity = positiveInteger(values, 'MAX_PLAYERS', 5, 100);
  if (ai.liveConcurrentGlobal < capacity)
    throw new Error('AI live concurrency must cover MAX_PLAYERS');
  return {
    host: bindHost(
      values.HOST ?? (values.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
      'HOST',
    ),
    port,
    publicUrl,
    allowedHosts: allowedHosts(values.APP_ALLOWED_HOSTS, hosts),
    allowedOrigins: allowedOrigins(values.APP_ALLOWED_ORIGINS, origins),
    secureCookie: !!publicUrl,
    passphrase,
    opsToken,
    version: values.APP_VERSION ?? 'local',
    scenario,
    scenarioCatalog,
    webRoot: resolve(cwd, 'dist/web'),
    capacity,
    ttlMs: positiveInteger(values, 'PLAY_TTL_SECONDS', 600, 600) * 1000,
    recoveryMs: positiveInteger(values, 'RECOVERY_GRACE_SECONDS', 60, 60) * 1000,
    authAttempts: positiveInteger(values, 'AUTH_ATTEMPTS_PER_MINUTE', 100, 10000),
    ai,
  };
}
