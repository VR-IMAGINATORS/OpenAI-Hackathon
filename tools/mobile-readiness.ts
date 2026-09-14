import { resolve4, resolve6, Resolver } from 'node:dns/promises';
import { get } from 'node:https';

export type HealthFailure = 'dns' | 'timeout' | 'connection' | 'http' | 'wrong-server';
type HealthResult = { ready: true } | { ready: false; reason: HealthFailure };

function failure(error: unknown): HealthResult {
  const code = (error as { code?: string; name?: string })?.code;
  return {
    ready: false,
    reason:
      code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA' || code === 'ETIMEOUT'
        ? 'dns'
        : (error as { name?: string })?.name === 'AbortError'
          ? 'timeout'
          : 'connection',
  };
}

export async function resolveMobileHost(
  hostname: string,
  signal: AbortSignal,
  systemResolve: (hostname: string) => Promise<string[]> = resolve4,
  cloudflareResolve?: (hostname: string) => Promise<string[]>,
): Promise<string[]> {
  try {
    return await systemResolve(hostname);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(hostname) ||
      !['ENOTFOUND', 'ENODATA', 'EAI_AGAIN', 'ETIMEOUT'].includes(code ?? '')
    )
      throw error;
    signal.throwIfAborted();
    if (cloudflareResolve) return cloudflareResolve(hostname);
    // Only public Cloudflare-generated hostnames use this fallback. Custom/private hosts do not.
    const resolver = new Resolver({ timeout: 1500, tries: 1 });
    resolver.setServers(['1.1.1.1', '1.0.0.1']);
    const cancel = () => resolver.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      return await resolver.resolve4(hostname);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
}

/** Resolve new tunnel names without trusting cached NXDOMAIN indefinitely.
 * HTTPS still verifies the original hostname and certificate. No system DNS settings change. */
export function probeMobileHealth(
  origin: string,
  bootId: string,
  signal: AbortSignal,
): Promise<HealthResult> {
  return new Promise((resolve) => {
    const request = get(
      new URL('/healthz', origin),
      {
        signal,
        lookup(hostname, options, callback) {
          let family = 4;
          void resolveMobileHost(hostname, signal)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENODATA') throw error;
              family = 6;
              return resolve6(hostname);
            })
            .then(
              (addresses) => {
                if (!addresses.length) {
                  callback(Object.assign(new Error('DNS_NOT_READY'), { code: 'ENODATA' }), '', 4);
                } else if (options.all) {
                  callback(
                    null,
                    addresses.map((address) => ({ address, family })),
                  );
                } else callback(null, addresses[0], family);
              },
              (error: NodeJS.ErrnoException) => callback(error, '', 4),
            );
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          resolve({ ready: false, reason: 'http' });
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
          if (Buffer.byteLength(body) >= 1024) {
            response.destroy();
            resolve({ ready: false, reason: 'wrong-server' });
          }
        });
        response.on('error', (error) => resolve(failure(error)));
        response.on('end', () => {
          try {
            resolve(
              JSON.parse(body).bootId === bootId
                ? { ready: true }
                : { ready: false, reason: 'wrong-server' },
            );
          } catch {
            resolve({ ready: false, reason: 'wrong-server' });
          }
        });
      },
    );
    request.on('error', (error) => resolve(failure(error)));
  });
}

export async function waitForMobileHealth(
  origin: string,
  bootId: string,
  options: {
    stopped: () => boolean;
    progress: (reason: HealthFailure) => void;
    probe?: typeof probeMobileHealth;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  },
): Promise<HealthResult> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 120_000);
  let nextProgress = now() + 15_000;
  let result: HealthResult = { ready: false, reason: 'connection' };
  while (!options.stopped() && now() < deadline) {
    result = await (options.probe ?? probeMobileHealth)(
      origin,
      bootId,
      AbortSignal.timeout(Math.max(1, Math.min(4000, Math.ceil(deadline - now())))),
    );
    if (result.ready) return result;
    if (now() >= nextProgress) {
      options.progress(result.reason);
      nextProgress = now() + 15_000;
    }
    if (!options.stopped() && now() < deadline) await sleep(Math.min(1000, deadline - now()));
  }
  return result;
}
