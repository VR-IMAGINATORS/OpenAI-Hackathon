import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { childEnvironment, pocConfig, supportedVersion } from '../codex-poc.js';
import { probeVersion, resolveBinary, selectBinary } from './binary.js';
import { login, safeLimits } from './probe.js';
import { PocError, Rpc } from './rpc.js';

export async function startWorker() {
  const root = await mkdtemp(join(tmpdir(), 'call-to-past-codex-game-'));
  const home = join(root, 'codex');
  const work = join(root, 'work');
  let child: ReturnType<typeof spawn> | undefined;
  let rpc: Rpc | undefined;
  let closing: Promise<void> | undefined;
  let usable = true;
  async function close() {
    if (closing) return closing;
    usable = false;
    closing = (async () => {
      await rpc?.call('account/logout', {}, 1500).catch(() => {});
      rpc?.fail();
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((r) => child!.once('exit', () => r()));
        child.kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]);
          if (child.exitCode === null && child.signalCode === null)
            throw new PocError('WORKER_STOP_UNCONFIRMED');
        }
      }
      if (
        dirname(root) !== resolve(tmpdir()) ||
        !root.startsWith(join(tmpdir(), 'call-to-past-codex-game-'))
      )
        throw new PocError('CLEANUP_PATH_INVALID');
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    })();
    return closing;
  }
  try {
    await mkdir(home);
    await mkdir(work);
    await writeFile(join(home, 'config.toml'), pocConfig);
    const env = childEnvironment(process.env, home);
    const binary = selectBinary(
      await resolveBinary(env, process.env.CODEX_POC_BIN),
      supportedVersion,
      (p) => probeVersion(p, env),
    );
    child = spawn(binary, ['app-server', '--strict-config', '--listen', 'stdio://'], {
      cwd: work,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    rpc = new Rpc(child.stdin!, child.stdout!);
    child.stderr!.resume();
    child.once('error', () => {
      usable = false;
      rpc!.fail(new PocError('CODEX_SPAWN_FAILED'));
    });
    child.once('exit', () => {
      usable = false;
      rpc!.fail(new PocError('CODEX_EXITED'));
    });
    await rpc.call('initialize', {
      clientInfo: { name: 'call_to_past_game_poc', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    return {
      rpc,
      work,
      close,
      isUsable: () => usable,
      invalidate: async () => {
        usable = false;
        await close();
      },
      async authenticate(
        mode: 'device' | 'browser',
        show?: (v: { url: string; code?: string }) => void,
      ) {
        const plan = await login(
          rpc!,
          mode,
          show ??
            (({ url, code }) => {
              console.log(`ログインURL: ${url}`);
              if (code) console.log(`ワンタイムコード: ${code}`);
              console.log('本人のアカウントでログインしてください（3分以内）。');
            }),
        );
        safeLimits(await rpc!.call('account/rateLimits/read', {}));
        if (!show) console.log(`ChatGPT認証: OK / plan=${plan}`);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type CodexWorker = Awaited<ReturnType<typeof startWorker>>;
