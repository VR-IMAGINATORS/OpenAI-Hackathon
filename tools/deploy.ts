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
  containerServiceName: string;
  url: string;
  power: string;
  scale: number;
  state: string;
  currentDeployment?: { state: string; containers: Record<string, { image: string }> } | null;
  nextDeployment?: { state: string } | null;
}
export interface DeployDependencies {
  aws(args: string[]): Promise<unknown>;
  request(url: string, init?: RequestInit): Promise<Response>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(event: string, version: string, image?: string, progress?: DrainProgress): void;
}
const drainBlockerKeys = [
  'registryOccupied',
  'liveBusy',
  'pendingCreates',
  'unknownCreates',
  'unconfirmedLive',
  'responseBusy',
  'imageBusy',
  'inspectionBusy',
  'endingJobs',
] as const;
interface DrainProgress {
  remaining: number;
  elapsedSeconds: number;
  blockers?: Partial<Record<(typeof drainBlockerKeys)[number], number>>;
}
interface DrainStatus {
  version: string;
  bootId: string;
  readyToDeploy: boolean;
  remaining: number;
  blockers?: DrainProgress['blockers'];
}
function drainStatus(value: any): DrainStatus {
  if (
    !value ||
    typeof value.version !== 'string' ||
    typeof value.bootId !== 'string' ||
    typeof value.readyToDeploy !== 'boolean' ||
    !Number.isSafeInteger(value.remaining) ||
    value.remaining < 0
  )
    throw new Error('Drain status invalid');
  const blockers: NonNullable<DrainProgress['blockers']> = {};
  for (const key of drainBlockerKeys) {
    const count = value.blockers?.[key];
    if (Number.isSafeInteger(count) && count >= 0) blockers[key] = count;
  }
  return {
    version: value.version,
    bootId: value.bootId,
    readyToDeploy: value.readyToDeploy,
    remaining: value.remaining,
    ...(Object.keys(blockers).length ? { blockers } : {}),
  };
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
  // Keep this script dependency-free: Actions runs it with Node's native type stripping.
  const provider = env.AI_PROVIDER || 'api';
  if (provider !== 'api' && provider !== 'codex') throw new Error('AI_PROVIDER invalid');
  const endingFlag = provider === 'codex' ? 'false' : env.ENDING_VIDEO_ENABLED || 'false';
  if (endingFlag !== 'true' && endingFlag !== 'false')
    throw new Error('ENDING_VIDEO_ENABLED invalid');
  const bounded = (name: string, fallback: string, min: number, max: number) => {
    const value = env[name] || fallback;
    if (!/^[1-9]\d*$/.test(value) || Number(value) < min || Number(value) > max)
      throw new Error(name + ' invalid');
    return value;
  };
  const endingTimeout = bounded('ENDING_JOB_TIMEOUT_SECONDS', '480', 60, 540);
  const endingConcurrent = bounded('ENDING_CONCURRENT', '2', 1, 2);
  const resultTtl = bounded('RESULT_TTL_SECONDS', endingFlag === 'true' ? '600' : '300', 150, 600);
  if (endingFlag === 'true' && Number(resultTtl) < Number(endingTimeout) + 60)
    throw new Error('RESULT_TTL_SECONDS must cover the ending deadline plus 60 seconds');
  const environment: Record<string, string> = {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '4310',
    APP_VERSION: version,
    PUBLIC_APP_URL: url.origin,
    AI_MODE: 'live',
    AI_PROVIDER: provider,
    MAX_PLAYERS: bounded('MAX_PLAYERS', provider === 'codex' ? '2' : '5', 1, 5),
    OPS_TOKEN: required('OPS_TOKEN'),
    AI_GLOBAL_LIVE_ATTEMPTS: required('AI_GLOBAL_LIVE_ATTEMPTS'),
    AI_GLOBAL_RESPONSE_ATTEMPTS: required('AI_GLOBAL_RESPONSE_ATTEMPTS'),
    LIVE_MODEL: env.LIVE_MODEL || 'gpt-live-1',
    LIVE_VOICE: env.LIVE_VOICE || 'gleam',
    RESPONSE_MODEL: env.RESPONSE_MODEL || 'gpt-5.6-terra',
    GAME_MODEL: env.GAME_MODEL || (provider === 'codex' ? 'gpt-5.6-luna' : 'gpt-5.6-sol'),
    IMAGE_MODEL: env.IMAGE_MODEL || 'gpt-image-2.5-flare',
    IMAGE_INSPECTION_MODEL: env.IMAGE_INSPECTION_MODEL || 'gpt-5.6-luna',
    AI_GLOBAL_IMAGE_ATTEMPTS: required('AI_GLOBAL_IMAGE_ATTEMPTS'),
    AI_GLOBAL_INSPECTION_ATTEMPTS: required('AI_GLOBAL_INSPECTION_ATTEMPTS'),
    IMAGE_REQUESTS_PER_MINUTE: env.IMAGE_REQUESTS_PER_MINUTE || '5',
    IMAGE_CONCURRENT: env.IMAGE_CONCURRENT || '2',
    IMAGE_INSPECTION_CONCURRENT: env.IMAGE_INSPECTION_CONCURRENT || '2',
    IMAGE_JOB_TIMEOUT_SECONDS:
      env.IMAGE_JOB_TIMEOUT_SECONDS || (provider === 'codex' ? '300' : '150'),
    RESULT_TTL_SECONDS: resultTtl,
    ENDING_VIDEO_ENABLED: endingFlag,
    ENDING_JOB_TIMEOUT_SECONDS: endingTimeout,
    ENDING_CONCURRENT: endingConcurrent,
    AI_RESPONSES_PER_PLAY: env.AI_RESPONSES_PER_PLAY || '80',
    ENABLE_GAME_TRACE: '0',
  };
  if (provider === 'api') environment.OPENAI_API_KEY = required('OPENAI_API_KEY');
  else environment.CODEX_POC_BIN = '/opt/codex/package/vendor/x86_64-unknown-linux-musl/bin/codex';
  if (endingFlag === 'true') {
    environment.FAL_KEY = required('FAL_KEY');
    environment.AI_GLOBAL_VIDEO_ATTEMPTS = bounded(
      'AI_GLOBAL_VIDEO_ATTEMPTS',
      required('AI_GLOBAL_VIDEO_ATTEMPTS'),
      1,
      1000,
    );
  }
  for (const name of [
    'AI_GLOBAL_LIVE_ATTEMPTS',
    'AI_GLOBAL_RESPONSE_ATTEMPTS',
    'AI_GLOBAL_IMAGE_ATTEMPTS',
    'AI_GLOBAL_INSPECTION_ATTEMPTS',
  ]) {
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

/** lightsailctl v1.0.8 prints a registration sentence even with --output json. */
export function parseAwsOutput(operation: string, stdout: string): unknown {
  try {
    if (operation === 'push-container-image') {
      const matches = [
        ...stdout.matchAll(
          /^Refer to this image as "(:[a-z0-9-]+\.[a-z0-9-]+\.[1-9][0-9]*)" in deployments\.\r?$/gm,
        ),
      ];
      if (matches.length !== 1) throw new Error('Missing registration');
      return { containerImage: { image: matches[0][1] } };
    }
    return JSON.parse(stdout);
  } catch {
    throw new Error('AWS response invalid');
  }
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
          resolveValue(parseAwsOutput(args[1], stdout));
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
  const entry = result.containerServices?.find(
    (item) => item.containerServiceName === config.serviceName,
  );
  if (
    !entry ||
    entry.scale !== 1 ||
    entry.power !== 'micro' ||
    entry.url.replace(/\/$/, '') !== config.publicUrl
  )
    throw new Error('Service configuration mismatch');
  return entry;
}
class ApplicationRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, code?: string) {
    super('Application request failed');
    this.status = status;
    this.code = code;
  }
}
function retryableHealthFailure(error: unknown): boolean {
  if (error instanceof ApplicationRequestError)
    return [404, 408, 429, 500, 502, 503, 504].includes(error.status);
  return (
    error instanceof TypeError ||
    (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
  );
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
  const text = await response.text();
  if (Buffer.byteLength(text) > 16384) throw new Error('Application response too large');
  if (!response.ok) {
    let code: string | undefined;
    try {
      // Retain only the one protocol code needed for safe retry; never log response bodies.
      if (JSON.parse(text)?.error?.code === 'DRAIN_ALREADY_STARTED') code = 'DRAIN_ALREADY_STARTED';
    } catch {
      /* Non-JSON error bodies still remain ordinary request failures. */
    }
    throw new ApplicationRequestError(response.status, code);
  }
  return JSON.parse(text);
}

export async function deploy(config: DeployConfig, deps: DeployDependencies): Promise<void> {
  deps.log('service_check_started', config.version);
  const old = await service(config, deps);
  if (old.nextDeployment) throw new Error('Another deployment is pending');
  if (!old.currentDeployment && !config.initial)
    throw new Error('Initial deployment requires explicit setting');
  if (old.currentDeployment && config.initial)
    throw new Error('Initial deployment flag must be disabled');
  deps.log('image_push_started', config.version);
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
  deps.log('image_registered', config.version, image);
  if (old.currentDeployment) {
    const health = await jsonRequest(deps, config.publicUrl + '/healthz');
    if (!/^[a-f0-9]{40}$/.test(health.version ?? '') || typeof health.bootId !== 'string')
      throw new Error('Old version unavailable');
    const headers = {
      Authorization: 'Bearer ' + config.opsToken,
      'Content-Type': 'application/json',
    };
    const started = deps.now();
    let status: DrainStatus;
    try {
      status = drainStatus(
        await jsonRequest(deps, config.publicUrl + '/api/ops/drain', {
          method: 'POST',
          headers,
          body: JSON.stringify({ requestId: randomUUID(), expectedVersion: health.version }),
        }),
      );
    } catch (error) {
      if (
        !(error instanceof ApplicationRequestError) ||
        error.status !== 409 ||
        error.code !== 'DRAIN_ALREADY_STARTED'
      )
        throw error;
      // A previous workflow may have timed out while this same instance kept draining.
      status = drainStatus(
        await jsonRequest(deps, config.publicUrl + '/api/ops/drain', { headers }),
      );
    }
    let previousProgress = '';
    for (;;) {
      if (status.version !== health.version || status.bootId !== health.bootId)
        throw new Error('Drain instance changed');
      const progress = { remaining: status.remaining, blockers: status.blockers };
      const fingerprint = JSON.stringify(progress);
      if (fingerprint !== previousProgress) {
        deps.log('drain_progress', health.version, undefined, {
          ...progress,
          elapsedSeconds: Math.floor((deps.now() - started) / 1000),
        });
        previousProgress = fingerprint;
      }
      if (status.readyToDeploy === true && status.remaining === 0) break;
      if (deps.now() - started >= 120000) {
        deps.log('drain_timeout', health.version, undefined, {
          ...progress,
          elapsedSeconds: Math.floor((deps.now() - started) / 1000),
        });
        throw new Error('Drain unconfirmed; deployment stopped');
      }
      await deps.sleep(2000);
      status = drainStatus(
        await jsonRequest(deps, config.publicUrl + '/api/ops/drain', { headers }),
      );
    }
    deps.log('drain_confirmed', health.version);
  }
  const temporary = await mkdtemp(join(tmpdir(), 'call-to-past-deploy-'));
  try {
    const file = join(temporary, 'deployment.json');
    await writeFile(file, JSON.stringify(document), { mode: 0o600 });
    deps.log('deployment_create_started', config.version, image);
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
      try {
        const health = await jsonRequest(deps, config.publicUrl + '/healthz');
        if (health.version === config.version) {
          deps.log('deployment_confirmed', config.version, image);
          return;
        }
      } catch (error) {
        // AWS can mark the deployment ACTIVE before its public endpoint is ready.
        // Only the read-only health check is retried, within the existing deadline.
        if (!retryableHealthFailure(error)) throw error;
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
    log: (event, version, image, progress) =>
      console.log(JSON.stringify({ event, version, image, ...progress })),
  }).catch((error: unknown) => {
    const safeMessages = new Set([
      'AWS command failed',
      'AWS response invalid',
      'Service configuration mismatch',
      'Another deployment is pending',
      'Initial deployment requires explicit setting',
      'Initial deployment flag must be disabled',
      'Image registration missing',
      'Image identifier invalid',
      'Application request failed',
      'Application response too large',
      'Old version unavailable',
      'Drain instance changed',
      'Drain status invalid',
      'Drain unconfirmed; deployment stopped',
      'Deployment failed; verify old version before resume',
      'Deployment verification timed out; no automatic resume',
    ]);
    if (error instanceof Error && safeMessages.has(error.message)) console.error(error.message);
    console.error('Deployment stopped. Check version, drain state, and the recovery procedure.');
    process.exitCode = 1;
  });
}
