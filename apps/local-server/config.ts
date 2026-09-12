import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { parseScenario, type Scenario } from '../../packages/shared/scenario.js';
import {
  allowedHosts,
  allowedOrigins,
  bindHost,
  positiveInteger,
  readEnvironment,
  relayUrl,
} from '../../packages/server/config.js';

export interface LocalConfig {
  host: string;
  port: number;
  relayUrl: string;
  scenario: Scenario;
  scenarioPath: string;
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  timeoutMs: number;
  webRoot: string;
}
export function loadLocalConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): LocalConfig {
  const values = readEnvironment('.env.local', env, cwd);
  const port = positiveInteger(values, 'LOCAL_PORT', 4310, 65535);
  const scenarioPath = resolve(cwd, values.SCENARIO_PATH ?? 'scenarios/default.json');
  let scenario: Scenario;
  try {
    scenario = parseScenario(JSON.parse(readFileSync(scenarioPath, 'utf8').replace(/^\uFEFF/, '')));
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(
        'SCENARIO_PATH validation failed: ' +
          error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('; '),
      );
    }
    throw new Error('SCENARIO_PATH could not be read as JSON');
  }
  const hosts = ['127.0.0.1:' + port, 'localhost:' + port, '127.0.0.1:5173', 'localhost:5173'];
  return {
    host: bindHost(values.LOCAL_HOST, 'LOCAL_HOST'),
    port,
    relayUrl: relayUrl(values.RELAY_URL),
    scenario,
    scenarioPath,
    allowedHosts: allowedHosts(values.LOCAL_ALLOWED_HOSTS, hosts),
    allowedOrigins: allowedOrigins(
      values.LOCAL_ALLOWED_ORIGINS,
      hosts.map((host) => 'http://' + host),
    ),
    timeoutMs: positiveInteger(values, 'LOCAL_RELAY_TIMEOUT_MS', 10_000, 30_000),
    webRoot: resolve(cwd, 'dist/web'),
  };
}
