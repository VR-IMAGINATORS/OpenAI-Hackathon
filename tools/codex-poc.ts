import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { judge, login, safeLimits } from './codex-poc/probe.js';
import { PocError, Rpc } from './codex-poc/rpc.js';
import { failureMessage, probeVersion, resolveBinary, selectBinary } from './codex-poc/binary.js';

export const pocConfig = [
  'cli_auth_credentials_store = "ephemeral"',
  'forced_login_method = "chatgpt"',
  'model_provider = "openai"',
  'approval_policy = "never"',
  'sandbox_mode = "read-only"',
  'web_search = "disabled"',
  'project_doc_max_bytes = 0',
  '[history]',
  'persistence = "none"',
  '[analytics]',
  'enabled = false',
  '[features]',
  'shell_tool = false',
  'unified_exec = false',
  'apps = false',
  'multi_agent = false',
  'shell_snapshot = false',
  '[features.code_mode]',
  'enabled = false',
].join('\n');

export const supportedVersion = 'codex-cli 0.154.0-alpha.6.2';
export function childEnvironment(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const allowed = new Set([
    'path',
    'systemroot',
    'windir',
    'comspec',
    'pathext',
    'temp',
    'tmp',
    'userprofile',
    'home',
    'localappdata',
    'appdata',
    'lang',
    'lc_all',
    'ssl_cert_file',
    'ssl_cert_dir',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source))
    if (allowed.has(key.toLowerCase())) env[key] = value;
  env.CODEX_HOME = home;
  return env;
}

export function parseArgs(args: string[]) {
  const result = {
    check: false,
    loginOnly: false,
    help: false,
    mode: 'device' as 'device' | 'browser',
    model: 'gpt-5.6-luna',
    prompt: '脱出ゲームです。紙製の帯を、手元の普通のハサミで切る工夫は物理的に可能ですか。',
    image: undefined as string | undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check') result.check = true;
    else if (arg === '--login-only') result.loginOnly = true;
    else if (arg === '--help') result.help = true;
    else if (['--login', '--model', '--prompt', '--image'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new PocError('MISSING_ARGUMENT');
      if (arg === '--login') {
        if (value !== 'device' && value !== 'browser') throw new PocError('INVALID_LOGIN_MODE');
        result.mode = value;
      } else if (arg === '--model') result.model = value;
      else if (arg === '--prompt') result.prompt = value;
      else result.image = resolve(value);
    } else throw new PocError('UNKNOWN_ARGUMENT');
  }
  if (
    !result.prompt.trim() ||
    result.prompt.length > 4000 ||
    !/^[-a-zA-Z0-9.]+$/.test(result.model)
  )
    throw new PocError('INVALID_INPUT');
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      'npm run poc:codex -- [--check | --login-only] [--login device|browser] [--model gpt-5.6-luna] [--prompt "説明"] [--image "写真.jpg"]',
    );
    console.log(
      'CODEX_POC_BIN: codex実行ファイルの絶対パス。1回だけ推論し、終了時に専用認証を破棄します。',
    );
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'call-to-past-codex-'));
  const home = join(root, 'codex');
  const work = join(root, 'work');
  let child: ReturnType<typeof spawn> | undefined;
  let rpc: Rpc | undefined;
  const abort = () => {
    rpc?.fail(new PocError('CANCELLED'));
    child?.kill();
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    await mkdir(home);
    await mkdir(work);
    const env = childEnvironment(process.env, home);
    console.log('Codex実行ファイルを確認しています…');
    const binary = selectBinary(
      await resolveBinary(env, process.env.CODEX_POC_BIN),
      supportedVersion,
      (candidate) => probeVersion(candidate, env),
    );
    console.log(`Codex: ${supportedVersion}`);
    // Config is created by this probe. Never copy the user's auth/config or read .env files.
    await writeFile(join(home, 'config.toml'), pocConfig);
    let image: string | undefined;
    if (options.image && !options.check && !options.loginOnly) {
      const info = await stat(options.image);
      if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new PocError('IMAGE_SIZE_LIMIT');
      const bytes = await sharp(await readFile(options.image), { limitInputPixels: 25_000_000 })
        .rotate()
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      image = join(work, 'photo.jpg');
      await writeFile(image, bytes);
    }
    child = spawn(binary, ['app-server', '--strict-config', '--listen', 'stdio://'], {
      cwd: work,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    rpc = new Rpc(child.stdin!, child.stdout!);
    child.stderr!.resume(); // Consume but never expose auth errors or payloads.
    child.once('error', () => rpc!.fail(new PocError('CODEX_SPAWN_FAILED')));
    child.once('exit', () => rpc!.fail(new PocError('CODEX_EXITED')));
    await rpc.call('initialize', {
      clientInfo: { name: 'call_to_past_poc', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    console.log('App Server初期化: OK（stdio）');
    if (options.check) return;
    console.log('専用ログインを開始します。認証後は本人のCodex枠を利用します。');
    const plan = await login(rpc, options.mode, ({ url, code }) => {
      console.log(`ログインURL: ${url}`);
      if (code) console.log(`ワンタイムコード: ${code}`);
      console.log('上記をブラウザで開いてログインしてください（最大3分待機）。');
    });
    console.log(`ChatGPT認証: OK / plan=${plan}`);
    const before = safeLimits(await rpc.call('account/rateLimits/read', {}));
    console.log('利用枠（実行前）:', JSON.stringify(before));
    if (options.loginOnly) return;
    console.log(`1回の判断を実行: ${options.model} / 写真=${Boolean(image)}`);
    const start = performance.now();
    const result = await judge(rpc, { ...options, cwd: work, image });
    console.log('判断結果:', JSON.stringify(result.decision, null, 2));
    console.log(
      `所要時間: ${Math.round(performance.now() - start)}ms / usage=${JSON.stringify(result.usage)}`,
    );
    const after = await rpc
      .call('account/rateLimits/read', {})
      .then(safeLimits)
      .catch(() => null);
    console.log('利用枠（実行後）:', JSON.stringify(after));
  } catch (error) {
    // Keep the diagnosis before cleanup and on stdout for terminals capturing stdout only.
    console.log(failureMessage(error));
    process.exitCode = 1;
  } finally {
    await rpc?.call('account/logout', {}, 2_000).catch(() => {});
    rpc?.fail();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((r) => child!.once('exit', () => r()));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    // Only delete the exact mkdtemp directory owned by this invocation, never user paths.
    if (
      dirname(root) !== resolve(tmpdir()) ||
      !root.startsWith(join(tmpdir(), 'call-to-past-codex-'))
    )
      throw new PocError('CLEANUP_PATH_INVALID');
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log(
      child
        ? '専用プロセス・認証・一時写真を終了／破棄しました。'
        : '一時作業領域を破棄しました（App Serverは起動していません）。',
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.log(failureMessage(error));
    process.exitCode = 1;
  });
}
