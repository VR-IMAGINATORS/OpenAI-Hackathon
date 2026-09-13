import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import {
  deploy,
  parseAwsOutput,
  deploymentConfig,
  deploymentDocument,
  type DeployDependencies,
} from '../tools/deploy.js';

const sha = 'a'.repeat(40),
  oldSha = 'b'.repeat(40);
const env = {
  DEPLOY_SHA: sha,
  LIGHTSAIL_SERVICE_NAME: 'game-dev',
  AWS_REGION: 'ap-northeast-1',
  PUBLIC_APP_URL: 'https://game-dev.example.ap-northeast-1.cs.amazonlightsail.com',
  OPENAI_API_KEY: 'sentinel-api-private',
  APP_PASSPHRASE: 'sentinel-passphrase-private',
  OPS_TOKEN: 'sentinel-ops-private',
  AI_GLOBAL_LIVE_ATTEMPTS: '50',
  AI_GLOBAL_RESPONSE_ATTEMPTS: '1000',
};
const config = () => deploymentConfig(env);
const image = ':game-dev.sha-' + sha + '.1';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function harness(
  options: {
    stuck?: boolean;
    mismatchedBoot?: boolean;
    failDeploy?: boolean;
    initial?: boolean;
    healthStatus?: number;
    healthFailures?: number;
    healthNetworkFailure?: boolean;
  } = {},
) {
  let time = 0,
    deployed = false;
  let healthAttempts = 0;
  const events: string[] = [],
    temporaryFiles: string[] = [],
    logs: unknown[] = [];
  const deps: DeployDependencies = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    log: (...args) => logs.push(args),
    aws: async (args) => {
      events.push(args[1]);
      if (args[1] === 'get-container-services')
        return {
          containerServices: [
            {
              containerServiceName: 'game-dev',
              url: env.PUBLIC_APP_URL + '/',
              scale: 1,
              power: 'micro',
              state: options.initial && !deployed ? 'READY' : 'RUNNING',
              nextDeployment: null,
              currentDeployment:
                options.initial && !deployed
                  ? null
                  : {
                      state: 'ACTIVE',
                      containers: { app: { image: deployed ? image : ':game-dev.old.1' } },
                    },
            },
          ],
        };
      if (args[1] === 'push-container-image')
        return parseAwsOutput(
          args[1],
          `Digest: sha256:example\nImage "call-to-the-past:${sha}" registered.\nRefer to this image as "${image}" in deployments.\n`,
        );
      if (args[1] === 'create-container-service-deployment') {
        const file = args[args.indexOf('--cli-input-json') + 1].slice(7);
        temporaryFiles.push(file);
        const document = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(document.serviceName, 'game-dev');
        assert.equal(document.containers.app.environment.OPENAI_API_KEY, env.OPENAI_API_KEY);
        assert.equal(document.containers.app.image, image);
        if (options.failDeploy) throw new Error('fake failure');
        deployed = true;
        return {};
      }
      throw new Error('Unexpected operation');
    },
    request: async (url, init) => {
      const path = new URL(url).pathname;
      events.push((init?.method ?? 'GET') + path);
      assert.equal(init?.redirect, 'error');
      if (path === '/healthz') {
        if (deployed && healthAttempts++ < (options.healthFailures ?? 0)) {
          if (options.healthNetworkFailure) throw new TypeError('fetch failed');
          return json({}, options.healthStatus ?? 503);
        }
        return json({ version: deployed ? sha : oldSha, bootId: 'old-boot' });
      }
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        'Bearer ' + env.OPS_TOKEN,
      );
      assert.equal((init?.headers as Record<string, string>).Origin, undefined);
      if (init?.method === 'POST')
        assert.equal(JSON.parse(init.body as string).expectedVersion, oldSha);
      return json({
        version: oldSha,
        bootId: options.mismatchedBoot ? 'different' : 'old-boot',
        readyToDeploy: !options.stuck,
        remaining: options.stuck ? 1 : 0,
      });
    },
  };
  return { deps, events, temporaryFiles, logs };
}

test('hosted deploy validates all target values and serializes secrets only into runtime env', () => {
  assert.throws(() => deploymentConfig({ ...env, DEPLOY_SHA: '$(malicious)' }));
  assert.throws(() => deploymentConfig({ ...env, PUBLIC_APP_URL: 'http://example.com' }));
  assert.throws(() => deploymentConfig({ ...env, AI_GLOBAL_LIVE_ATTEMPTS: '' }));
  const doc = deploymentDocument(config(), image);
  assert.equal(doc.publicEndpoint.healthCheck.path, '/healthz');
  assert.equal(doc.containers.app.ports['4310'], 'HTTP');
  assert.throws(() => deploymentDocument(config(), ':other.sha.1'));
});

test('hosted deploy confirms old drain before deploy and verifies registered image and SHA', async () => {
  const h = harness();
  await deploy(config(), h.deps);
  assert.ok(
    h.events.indexOf('POST/api/ops/drain') <
      h.events.indexOf('create-container-service-deployment'),
  );
  assert.ok(h.logs.some((entry) => (entry as string[])[0] === 'deployment_confirmed'));
  assert.ok(JSON.stringify(h.logs).includes(image));
  for (const secret of [env.OPENAI_API_KEY, env.OPS_TOKEN, env.APP_PASSPHRASE])
    assert.equal(JSON.stringify(h.logs).includes(secret), false);
  for (const file of h.temporaryFiles) await assert.rejects(access(file));
});

test('hosted deploy stops after 120-second unconfirmed drain and never resumes', async () => {
  const h = harness({ stuck: true });
  await assert.rejects(deploy(config(), h.deps), /Drain unconfirmed/);
  assert.equal(h.events.includes('create-container-service-deployment'), false);
  assert.equal(
    h.events.some((event) => event.includes('resume')),
    false,
  );
});

test('hosted deploy rejects a different boot during drain', async () => {
  const h = harness({ mismatchedBoot: true });
  await assert.rejects(deploy(config(), h.deps), /Drain instance changed/);
  assert.equal(h.events.includes('create-container-service-deployment'), false);
});

test('hosted deployment failure deletes temporary secrets without automatic resume', async () => {
  const h = harness({ failDeploy: true });
  await assert.rejects(deploy(config(), h.deps));
  for (const file of h.temporaryFiles) await assert.rejects(access(file));
  assert.equal(
    h.events.some((event) => event.includes('resume')),
    false,
  );
});

test('hosted first deployment requires explicit initial setting and no active deployment', async () => {
  const h = harness({ initial: true });
  await assert.rejects(deploy(config(), h.deps), /Initial deployment/);
  await deploy({ ...config(), initial: true }, h.deps);
  assert.equal(h.events.includes('POST/api/ops/drain'), false);
  await assert.rejects(
    deploy({ ...config(), initial: true }, harness().deps),
    /flag must be disabled/,
  );
});

test('hosted workflows isolate requested SHA from credential job and pin all actions', async () => {
  for (const file of ['deploy-dev.yml', 'deploy-judging.yml']) {
    const yaml = await readFile('.github/workflows/' + file, 'utf8');
    assert.match(yaml, /cancel-in-progress: false/);
    assert.equal((yaml.match(/if: github.ref == 'refs\/heads\/main'/g) ?? []).length, 2);
    for (const match of yaml.matchAll(/uses: (.+)/g))
      assert.match(match[1], /@[a-f0-9]{40}(?: |$)/);
    const [build, deployJob] = yaml.split(/\r?\n  deploy:\r?\n/);
    assert.doesNotMatch(build, /secrets\.|id-token: write|environment:/);
    assert.match(deployJob, /ref: \$\{\{ github.sha \}\}/);
    assert.doesNotMatch(deployJob, /npm (ci|install|run)|docker (build|run)/);
    assert.match(deployJob, /node --experimental-strip-types tools\/deploy.ts/);
    assert.match(yaml, /git merge-base --is-ancestor/);
  }
  const ignore = await readFile('.dockerignore', 'utf8');
  assert.match(ignore, /\.env\.\*/);
  assert.match(ignore, /artifacts/);
  assert.match(ignore, /node_modules/);
  const docker = await readFile('Dockerfile', 'utf8');
  assert.match(docker, /USER node/);
  assert.match(docker, /@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(docker, /OPENAI_API_KEY|APP_PASSPHRASE|OPS_TOKEN/);
});

// Output format from aws/lightsailctl v1.0.8 internal/cs/pushimage.go.
test('Lightsail push parses the unique registration sentence instead of expecting JSON', () => {
  const output = `Digest: sha256:example\nImage "local-image" registered.\nRefer to this image as "${image}" in deployments.\n`;
  assert.deepEqual(parseAwsOutput('push-container-image', output), { containerImage: { image } });
  assert.deepEqual(parseAwsOutput('push-container-image', output.replaceAll('\n', '\r\n')), {
    containerImage: { image },
  });
  for (const invalid of [
    '',
    'sentinel-private-token',
    output + output,
    JSON.stringify({ containerImage: { image } }),
  ]) {
    assert.throws(
      () => parseAwsOutput('push-container-image', invalid),
      (error) => {
        assert.equal((error as Error).message, 'AWS response invalid');
        return true;
      },
    );
  }
  assert.deepEqual(parseAwsOutput('get-container-services', '{"containerServices":[]}'), {
    containerServices: [],
  });
});

test('deployment waits for transient endpoint readiness without repeating deployment', async () => {
  for (const healthNetworkFailure of [false, true]) {
    const h = harness({ initial: true, healthFailures: 2, healthNetworkFailure });
    await deploy({ ...config(), initial: true }, h.deps);
    assert.equal(h.events.filter((e) => e === 'create-container-service-deployment').length, 1);
    assert.equal(h.events.filter((e) => e === 'GET/healthz').length, 3);
  }
});
test('persistent endpoint unavailability times out; authentication errors fail immediately', async () => {
  const unavailable = harness({ initial: true, healthFailures: 1000 });
  await assert.rejects(
    deploy({ ...config(), initial: true }, unavailable.deps),
    /verification timed out/,
  );
  assert.equal(
    unavailable.events.filter((e) => e === 'create-container-service-deployment').length,
    1,
  );
  const forbidden = harness({ initial: true, healthFailures: 1000, healthStatus: 403 });
  await assert.rejects(
    deploy({ ...config(), initial: true }, forbidden.deps),
    /Application request failed/,
  );
  assert.equal(forbidden.events.filter((e) => e === 'GET/healthz').length, 1);
});

test('deployment script loads with native Node strip-only TypeScript and no dev runtime', () => {
  execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      "await import('./tools/deploy.ts')",
    ],
    { stdio: 'pipe' },
  );
});
