import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { PocError } from './rpc.js';

export function selectBinary(
  candidates: string[],
  expectedVersion: string,
  probe: (binary: string) => string | null,
): string {
  let incompatible = false;
  for (const candidate of [...new Set(candidates)]) {
    const version = probe(candidate);
    if (version === expectedVersion) return candidate;
    if (version !== null) incompatible = true;
  }
  throw new PocError(incompatible ? 'CODEX_VERSION_MISMATCH' : 'CODEX_BINARY_UNAVAILABLE');
}

/** Inspect executable locations only; never read the desktop app's credentials/config. */
export async function resolveBinary(env: NodeJS.ProcessEnv, explicit?: string): Promise<string[]> {
  if (explicit) {
    if (!isAbsolute(explicit)) throw new PocError('BINARY_MUST_BE_ABSOLUTE');
    return [explicit]; // An explicit selection must never silently fall back.
  }
  if (process.platform !== 'win32') return ['codex'];
  const candidates = ['codex.exe'];
  const localAppData = Object.entries(env).find(([k]) => k.toLowerCase() === 'localappdata')?.[1];
  if (localAppData) {
    const root = join(localAppData, 'OpenAI', 'Codex', 'bin');
    candidates.push(join(root, 'codex.exe'));
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries.filter((e) => e.isDirectory()).slice(0, 50)) {
        candidates.push(join(root, entry.name, 'codex.exe'));
      }
    } catch {
      /* Desktop installation is optional. */
    }
  }
  return candidates;
}

export function probeVersion(binary: string, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync(binary, ['--version'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 16_384,
  });
  return result.error || result.status !== 0 ? null : result.stdout.trim();
}

export function failureMessage(error: unknown): string {
  const code = error instanceof PocError ? error.code : 'LOCAL_ERROR';
  const hints: Record<string, string> = {
    CODEX_BINARY_UNAVAILABLE:
      'Codex実行ファイルを見つけられないか、起動できません。CODEX_POC_BINにcodex.exeの絶対パスを指定してください。',
    CODEX_VERSION_MISMATCH:
      '対応版は codex-cli 0.154.0-alpha.6.2 です。指定版を確認してください。未検証の版では続行しません。',
    BINARY_MUST_BE_ABSOLUTE: 'CODEX_POC_BINには実行ファイルの絶対パスを指定してください。',
    EVENT_TIMEOUT: 'ログインまたは判断の待機期限を超えました。再実行してください。',
    LOCAL_ERROR: 'ローカルの一時領域・画像・ファイル権限を確認してください。',
  };
  return `PoC停止: ${code}\n${hints[code] ?? '実行手順のエラー一覧を確認してください。'}`;
}
