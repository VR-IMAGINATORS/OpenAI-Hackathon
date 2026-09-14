import { resolve } from 'node:path';
import {
  allowedHosts,
  allowedOrigins,
  bindHost,
  positiveInteger,
  readEnvironment,
} from '../../packages/server/config.js';
import { loadAiConfig, type AiConfig } from '../../packages/server/ai-config.js';
import { loadEndingConfig, type EndingConfig } from '../../packages/server/ending-config.js';
import { localizeScenario, type Scenario } from '../../packages/shared/scenario.js';
import {
  DEFAULT_SCENARIO_PATH,
  ScenarioCatalog,
  parseScenarioSource,
  readConfigJson,
} from './scenario-catalog.js';
import { compileStoryScenario } from '../../packages/shared/story-catalog.js';

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
  resultTtlMs?: number;
  enableGameTrace?: boolean;
  capacity: number;
  ttlMs: number;
  recoveryMs: number;
  authAttempts: number;
  ai: AiConfig;
  ending?: EndingConfig;
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
  const ttlMs = positiveInteger(values, 'PLAY_TTL_SECONDS', 600, 600) * 1000;
  const recoveryMs = positiveInteger(values, 'RECOVERY_GRACE_SECONDS', 60, 60) * 1000;
  const scenarioPath = resolve(cwd, values.SCENARIO_PATH ?? DEFAULT_SCENARIO_PATH);
  // Keep detailed planner field errors at startup; HTTP admission uses CONFIG_INVALID.
  const source = parseScenarioSource(readConfigJson(scenarioPath));
  const scenario = localizeScenario(
    source.version === 3 ? compileStoryScenario(source, 0) : source,
    'ja',
  );
  const scenarioCatalog = new ScenarioCatalog({
    scenarioPath,
    coreConfigPath: resolve(cwd, 'config/game-core.json'),
    playTtlMs: ttlMs,
    lifecycleReserveMs: recoveryMs + 60_000 + 12_000,
  });
  scenarioCatalog.validate();
  const ai = loadAiConfig(values);
  const ending = loadEndingConfig(values);
  const resultTtlMs =
    positiveInteger(values, 'RESULT_TTL_SECONDS', ending.enabled ? 600 : 300, 600) * 1000;
  if (resultTtlMs < 150_000 || resultTtlMs < ai.imageJobTimeoutMs)
    throw new Error('RESULT_TTL_SECONDS must cover the image job deadline (at least 150 seconds)');
  if (ending.enabled && resultTtlMs < ending.timeoutMs + 60_000)
    throw new Error('RESULT_TTL_SECONDS must cover the ending deadline plus 60 seconds');
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
    resultTtlMs,
    enableGameTrace: values.ENABLE_GAME_TRACE === '1' && values.NODE_ENV !== 'production',
    capacity,
    ttlMs,
    recoveryMs,
    authAttempts: positiveInteger(values, 'AUTH_ATTEMPTS_PER_MINUTE', 100, 10000),
    ai,
    ending,
  };
}
