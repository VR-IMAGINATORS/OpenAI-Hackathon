import { mkdir, realpath, writeFile, unlink } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { ExpansionStore, artifactDigest, conditionsDigest } from './store.js';
import { compileExpandedScenario } from './compile.js';
import { validateEvaluationForAdoption } from './evaluate.js';

type Saved = Awaited<ReturnType<typeof ExpansionStore.readOnly>>;
function validate(data: Saved, revision: number) {
  const { manifest, candidate, source } = data;
  if (manifest.mode !== 'live' || manifest.stage !== 'ready_for_adoption')
    throw new Error('LIVE_EVALUATION_REQUIRED');
  if (candidate.revision !== revision || manifest.conditions.revision !== revision)
    throw new Error('ADOPTION_REVISION_MISMATCH');
  const latest = new Map<string, (typeof data.plays)[number]>();
  for (const play of data.plays) latest.set(play.playId, play);
  const plays = [...latest.values()];
  const models = new Set(manifest.playMatrix.map((row) => row.model)),
    personas = new Set(manifest.playMatrix.map((row) => row.persona));
  if (
    manifest.playMatrix.length !== 9 ||
    models.size !== 3 ||
    personas.size !== 3 ||
    new Set(manifest.playMatrix.map((row) => row.model + ':' + row.persona)).size !== 9 ||
    plays.length !== 9 ||
    plays.some((play) => !['cleared', 'uncleared'].includes(play.status))
  )
    throw new Error('NINE_COMPLETED_PLAYS_REQUIRED');
  if (
    manifest.conditions.candidateDigest !== artifactDigest(candidate) ||
    manifest.conditions.sourceDigest !== source.sourceDigest
  )
    throw new Error('ADOPTION_DIGEST_MISMATCH');
  const evaluation = validateEvaluationForAdoption(data.evaluation, {
    source,
    candidate,
    candidateDigest: artifactDigest(candidate),
    conditionsDigest: conditionsDigest(manifest.conditions),
    plays,
    expectedPlayIds: manifest.playMatrix.map((row) => row.playId),
  });
  return { compiled: compileExpandedScenario(source, candidate), evaluation };
}
/** Explicit local adoption; never edits the source or deployment configuration. */
export async function adoptExpansion(
  input: string,
  revision: number,
  outputRoot = 'scenarios/expanded',
): Promise<void> {
  if (basename(input) !== 'manifest.json' || !Number.isSafeInteger(revision) || revision < 1)
    throw new Error('ADOPTION_INPUT_INVALID');
  const initial = await ExpansionStore.readOnly(input);
  validate(initial, revision);
  const store = await ExpansionStore.resume(input, initial.manifest.conditions);
  await store.adoptExclusive(artifactDigest(initial.manifest), async () => {
    const data = await ExpansionStore.readOnly(input),
      { compiled, evaluation } = validate(data, revision);
    const root = resolve(outputRoot);
    await mkdir(root, { recursive: true });
    const actual = await realpath(root);
    if (
      (process.platform === 'win32' ? actual.toLowerCase() : actual) !==
      (process.platform === 'win32' ? root.toLowerCase() : root)
    )
      throw new Error('ADOPTION_OUTPUT_SYMLINK');
    const name = data.candidate.candidateId + '-r' + revision;
    const output = join(root, name + '.json'),
      recordPath = join(root, name + '.adoption.json');
    await writeFile(output, JSON.stringify(compiled, null, 2) + '\n', { flag: 'wx' });
    const record = {
      candidateDigest: artifactDigest(data.candidate),
      sourceDigest: data.source.sourceDigest,
      evaluationRunId: data.manifest.runId,
      evaluationDigest: artifactDigest(evaluation),
      adoptedAt: new Date().toISOString(),
      outputPath: output,
    };
    try {
      await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    } catch (error) {
      await unlink(output);
      throw error;
    }
  });
}
