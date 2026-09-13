import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface DeployConfig {
  region: string;
  serviceName: string;
  publicUrl: string;
  version: string;
  initial: boolean;
  environment: Record<string, string>;
  opsToken: string;
}
export interface ServiceInfo {
  serviceName: string;
  url: string;
  power: string;
  scale: number;
  state: string;
  currentDeployment?: { state: string; containers: Record<string, { image: string }> };
  nextDeployment?: { state: string };
}
export interface DeployDependencies {
  aws(args: string[]): Promise<unknown>;
  request(url: string, init?: RequestInit): Promise<Response>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(event: string, version: string, image?: string): void;
}

export function deploymentConfig(env: NodeJS.ProcessEnv): DeployConfig {
  const required = (name: string) => {
    if (!env[name]?.trim()) throw new Error(name + ' required');
    return env[name]!;
  };
  const version = required('DEPLOY_SHA');
  if (!/^[a-f0-9]{40}$/.test(version)) throw new Error('DEPLOY_SHA invalid');
  const serviceName = required('LIGHTSAIL_SERVICE_NAME');
  if (!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(serviceName)) throw new Error('Service name invalid');
  const region = required('AWS_REGION');
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new Error('Region invalid');
  const url = new URL(required('PUBLIC_APP_URL'));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !url.hostname.endsWith('.cs.amazonlightsail.com')
  )
    throw new Error('Standard Lightsail HTTPS origin required');
  const environment: Record<string, string> = {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '4310',
    APP_VERSION: version,
    PUBLIC_APP_URL: url.origin,
    AI_MODE: 'live',
    MAX_PLAYERS: '5',
    OPENAI_API_KEY: required('OPENAI_API_KEY'),
    APP_PASSPHRASE: required('APP_PASSPHRASE'),
    OPS_TOKEN: required('OPS_TOKEN'),
    AI_GLOBAL_LIVE_ATTEMPTS: required('AI_GLOBAL_LIVE_ATTEMPTS'),
    AI_GLOBAL_RESPONSE_ATTEMPTS: required('AI_GLOBAL_RESPONSE_ATTEMPTS'),
    LIVE_MODEL: env.LIVE_MODEL || 'gpt-live-1',
    RESPONSE_MODEL: env.RESPONSE_MODEL || 'gpt-5.6-terra',
  };
  for (const name of ['AI_GLOBAL_LIVE_ATTEMPTS', 'AI_GLOBAL_RESPONSE_ATTEMPTS']) {
    if (!/^[1-9]\d*$/.test(environment[name]) || Number(environment[name]) > 1000000)
      throw new Error(name + ' invalid');
  }
  return {
    region,
    serviceName,
    publicUrl: url.origin,
    version,
    initial: env.INITIAL_DEPLOYMENT === 'true',
    environment,
    opsToken: required('OPS_TOKEN'),
  };
}

export function deploymentDocument(config: DeployConfig, image: string) {
  if (!new RegExp('^:' + config.serviceName + '\\.[a-z0-9-]+\\.[1-9][0-9]*$').test(image))
    throw new Error('Image identifier invalid');
  return {
    serviceName: config.serviceName,
    containers: { app: { image, environment: config.environment, ports: { '4310': 'HTTP' } } },
    publicEndpoint: {
      containerName: 'app',
      containerPort: 4310,
      healthCheck: {
        healthyThreshold: 2,
        unhealthyThreshold: 3,
        timeoutSeconds: 5,
        intervalSeconds: 10,
        path: '/healthz',
        successCodes: '200',
      },
    },
  };
}

/** All CLI output is captured; error objects never contain stderr or environment. */
export function awsCommand(args: string[]): Promise<unknown> {
  return new Promise((resolveValue, reject) => {
    execFile(
      'aws',
      [...args, '--output', 'json', '--no-cli-pager'],
      { maxBuffer: 4 * 1024 * 1024, timeout: 600000, env: { ...process.env, AWS_PAGER: '' } },
      (error, stdout) => {
        if (error) return reject(new Error('AWS command failed'));
        try {
          // lightsailctl may prepend non-JSON progress text; never forward it to logs.
          const start = stdout.indexOf('{');
          if (start < 0) throw new Error('Missing JSON');
          resolveValue(JSON.parse(stdout.slice(start)));
        } catch {
          reject(new Error('AWS response invalid'));
        }
      },
    );
  });
}

async function service(config: DeployConfig, deps: DeployDependencies): Promise<ServiceInfo> {
  const result = (await deps.aws([
    'lightsail',
    'get-container-services',
    '--service-name',
    config.serviceName,
    '--region',
    config.region,
  ])) as { containerServices?: ServiceInfo[] };
  const entry = result.containerServices?.find((item) => item.serviceName === config.serviceName);
  if (
    !entry ||
    entry.scale !== 1 ||
    entry.power !== 'micro' ||
    entry.url.replace(/\/$/, '') !== config.publicUrl
  )
    throw new Error('Service configuration mismatch');
  return entry;
}
async function jsonRequest(
  deps: DeployDependencies,
  url: string,
  init?: RequestInit,
): Promise<any> {
  const response = await deps.request(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Application request failed');
  const text = await response.text();
  if (Buffer.byteLength(text) > 16384) throw new Error('Application response too large');
  return JSON.parse(text);
}

export async function deploy(config: DeployConfig, deps: DeployDependencies): Promise<void> {
  const old = await service(config, deps);
  if (old.nextDeployment) throw new Error('Another deployment is pending');
  if (!old.currentDeployment && !config.initial)
    throw new Error('Initial deployment requires explicit setting');
  if (old.currentDeployment && config.initial)
    throw new Error('Initial deployment flag must be disabled');
  const imageResult = (await deps.aws([
    'lightsail',
    'push-container-image',
    '--service-name',
    config.serviceName,
    '--label',
    'sha-' + config.version,
    '--image',
    'call-to-the-past:' + config.version,
    '--region',
    config.region,
  ])) as { containerImage?: { image?: string } };
  const image = imageResult.containerImage?.image;
  if (!image) throw new Error('Image registration missing');
  const document = deploymentDocument(config, image);
  if (old.currentDeployment) {
    const health = await jsonRequest(deps, config.publicUrl + '/healthz');
    if (!/^[a-f0-9]{40}$/.test(health.version ?? '') || typeof health.bootId !== 'string')
      throw new Error('Old version unavailable');
    const headers = {
      Authorization: 'Bearer ' + config.opsToken,
      'Content-Type': 'application/json',
    };
    const started = deps.now();
    let status = await jsonRequest(deps, config.publicUrl + '/api/ops/drain', {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: randomUUID(), expectedVersion: health.version }),
    });
    for (;;) {
      if (status.version !== health.version || status.bootId !== health.bootId)
        throw new Error('Drain instance changed');
      if (status.readyToDeploy === true && status.remaining === 0) break;
      if (deps.now() - started >= 120000) throw new Error('Drain unconfirmed; deployment stopped');
      await deps.sleep(2000);
      status = await jsonRequest(deps, config.publicUrl + '/api/ops/drain', { headers });
    }
    deps.log('drain_confirmed', health.version);
  }
  const temporary = await mkdtemp(join(tmpdir(), 'call-to-past-deploy-'));
  try {
    const file = join(temporary, 'deployment.json');
    await writeFile(file, JSON.stringify(document), { mode: 0o600 });
    await deps.aws([
      'lightsail',
      'create-container-service-deployment',
      '--cli-input-json',
      'file://' + file,
      '--region',
      config.region,
    ]);
  } finally {
    await rm(join(temporary, 'deployment.json'), { force: true });
    await rmdir(temporary);
  }
  const started = deps.now();
  while (deps.now() - started < 600000) {
    const current = await service(config, deps);
    if (current.state === 'DISABLED' || current.nextDeployment?.state === 'FAILED')
      throw new Error('Deployment failed; verify old version before resume');
    if (
      current.currentDeployment?.state === 'ACTIVE' &&
      current.currentDeployment.containers.app?.image === image
    ) {
      const health = await jsonRequest(deps, config.publicUrl + '/healthz');
      if (health.version === config.version) {
        deps.log('deployment_confirmed', config.version, image);
        return;
      }
    }
    await deps.sleep(5000);
  }
  throw new Error('Deployment verification timed out; no automatic resume');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void deploy(deploymentConfig(process.env), {
    aws: awsCommand,
    request: fetch,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (event, version, image) => console.log(JSON.stringify({ event, version, image })),
  }).catch(() => {
    console.error('Deployment stopped. Check version, drain state, and the recovery procedure.');
    process.exitCode = 1;
  });
}
