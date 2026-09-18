// Official, exact Linux amd64 package. Never substitute another CLI version.
import { createHash } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const target = resolve(process.argv[2] ?? '/opt/codex');
const url = 'https://registry.npmjs.org/@openai/codex/-/codex-0.154.0-alpha.6.2-linux-x64.tgz';
const expected =
  'xlnRDWXHIbkPQeFk1sh6GKApHunKVdAm8Wb6FliTW5/lzV0zUE2FIda/z9QDr7AfZb6eHC2KF0lf+z/LkzXhDg==';
const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
if (!response.ok) throw new Error('Codex package download failed');
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha512').update(bytes).digest('base64') !== expected)
  throw new Error('Codex package integrity mismatch');
await mkdir(target, { recursive: true });
const archive = join(target, 'codex.tgz');
await writeFile(archive, bytes);
try {
  execFileSync('tar', ['-xzf', archive, '-C', target, '--no-same-owner']);
} finally {
  await unlink(archive);
}
const binary = join(target, 'package/vendor/x86_64-unknown-linux-musl/bin/codex');
if (
  execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim() !== 'codex-cli 0.154.0-alpha.6.2'
)
  throw new Error('Codex package version mismatch');
console.log('Pinned Codex Linux package verified');
