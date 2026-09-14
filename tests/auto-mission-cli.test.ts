import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const loader = pathToFileURL(require.resolve('tsx')).href;
const entry = fileURLToPath(new URL('../tools/auto-mission.ts', import.meta.url));
const config = fileURLToPath(new URL('../config/auto-mission/default.json', import.meta.url));
function cli(cwd: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', loader, entry, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, OPENAI_API_KEY: '' },
  });
}
async function removeTemporary(root: string) {
  const absolute = path.resolve(root);
  assert.ok(
    absolute.startsWith(path.resolve(tmpdir()) + path.sep) &&
      path.basename(absolute).startsWith('mission-cli-'),
  );
  await rm(absolute, { recursive: true, force: true });
}
test('mission CLI mock generation, reevaluation and offline rendering save independent results without credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mission-cli-'));
  try {
    const generated = cli(root, ['generate', '--config', config, '--mock']);
    assert.equal(generated.status, 0, generated.stderr + generated.stdout);
    const output = path.join(root, 'runs', 'auto-mission');
    const original = (await readdir(output))[0];
    const input = path.join(output, original, 'run.json');
    const before = await readFile(input, 'utf8');
    assert.equal(JSON.parse(before).mode, 'mock');
    assert.ok(
      (await readFile(path.join(output, original, 'report.html'), 'utf8')).includes('MOCK'),
    );
    const evaluated = cli(root, ['evaluate', '--input', input, '--mock']);
    assert.equal(evaluated.status, 0, evaluated.stderr + evaluated.stdout);
    assert.equal((await readdir(output)).length, 2);
    assert.equal(await readFile(input, 'utf8'), before);
    const rendered = cli(root, ['render', '--input', input]);
    assert.equal(rendered.status, 0, rendered.stderr + rendered.stdout);
    assert.equal((await readdir(output)).length, 3);
    assert.equal(await readFile(input, 'utf8'), before);
  } finally {
    await removeTemporary(root);
  }
});
test('mission CLI invalid arguments exit 2 and rejected mechanical plan exits 1', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mission-cli-'));
  try {
    for (const args of [
      ['generate', '--config', config],
      ['generate', '--mock', '--live'],
      ['render', '--input', 'unused.json', '--mock'],
      ['generate', '--unknown'],
    ]) {
      const result = cli(root, args);
      assert.equal(result.status, 2, result.stderr);
    }
    const edited = JSON.parse(await readFile(config, 'utf8'));
    edited.difficulty.maxActions = 1;
    const restricted = path.join(root, 'restricted.json');
    await writeFile(restricted, JSON.stringify(edited));
    const rejected = cli(root, ['generate', '--config', restricted, '--mock']);
    assert.equal(rejected.status, 1, rejected.stderr + rejected.stdout);
    const output = path.join(root, 'runs', 'auto-mission');
    const id = (await readdir(output))[0];
    const record = JSON.parse(await readFile(path.join(output, id, 'run.json'), 'utf8'));
    assert.equal(record.status, 'failed');
    assert.equal(record.failureCode, 'STORY_REJECTED');
    assert.equal(record.revisions.length, 3);
  } finally {
    await removeTemporary(root);
  }
});
