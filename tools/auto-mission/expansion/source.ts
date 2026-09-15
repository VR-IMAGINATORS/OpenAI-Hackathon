import { createHash } from 'node:crypto';
import { parseStoryCatalog, compileStoryScenario } from '../../../packages/shared/story-catalog.js';
import type { ScenarioV2 } from '../../../packages/shared/scenario.js';
import { sourceSnapshotSchema, assertSize, type SourceSnapshot } from './schemas.js';
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, val]) => JSON.stringify(key) + ':' + canonical(val))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function invariantDigest(scenario: ScenarioV2, original: ScenarioV2 = scenario): string {
  const fixed = structuredClone(scenario);
  // Only these presentation fields are editable. All judgment inputs stay fixed.
  fixed.premise = original.premise;
  fixed.playerBriefing = original.playerBriefing;
  delete fixed.investigation;
  fixed.obstacles = fixed.obstacles.map((entry, i) => ({
    ...entry,
    title: original.obstacles[i]?.title ?? entry.title,
    situationDisplay: original.obstacles[i]?.situationDisplay ?? entry.situationDisplay,
  }));
  fixed.knowledge = fixed.knowledge
    .filter((entry) => original.knowledge.some((old) => old.id === entry.id))
    .map((entry) => ({
      ...entry,
      localizedText: original.knowledge.find((old) => old.id === entry.id)!.localizedText,
    }));
  fixed.observationTargets = fixed.observationTargets
    .filter((entry) => original.observationTargets.some((old) => old.id === entry.id))
    .map((entry) => ({
      ...entry,
      description: original.observationTargets.find((old) => old.id === entry.id)!.description,
    }));
  return sha256(canonical(fixed));
}
/** Pure snapshot: never writes to or rereads the original file. */
export function freezeSource(rawCatalogText: string, candidateIndex = 0): SourceSnapshot {
  assertSize(rawCatalogText, 'Source catalog');
  const catalog = parseStoryCatalog(JSON.parse(rawCatalogText));
  const compiledOriginal = compileStoryScenario(catalog, candidateIndex);
  let sequenceIndex = candidateIndex;
  const scene = catalog.scenes.find((entry) => {
    if (sequenceIndex < entry.sequences.length) return true;
    sequenceIndex -= entry.sequences.length;
    return false;
  })!;
  const { scenes: _scenes, gimmicks: _gimmicks, ...shared } = catalog;
  return sourceSnapshotSchema.parse({
    schemaVersion: 1,
    sourceDigest: sha256(rawCatalogText),
    rawCatalogText,
    compiledOriginal,
    originalInvariantDigest: invariantDigest(compiledOriginal),
    selection: {
      candidateIndex,
      sceneId: scene.id,
      sequenceIndex,
      obstacleIds: compiledOriginal.obstacles.map((entry) => entry.id),
    },
    originalSections: {
      shared,
      scene,
      gimmicks: scene.sequences[sequenceIndex]!.map(
        (id) => catalog.gimmicks.find((entry) => entry.id === id)!,
      ),
    },
  });
}
/** Reloaded snapshots must match their frozen bytes, including original solution records. */
export function validateSource(value: unknown): SourceSnapshot {
  const source = sourceSnapshotSchema.parse(value);
  const expected = freezeSource(source.rawCatalogText, source.selection.candidateIndex);
  if (canonical(source) !== canonical(expected))
    throw new Error('Source snapshot digest or content mismatch');
  return source;
}
export function validatePreservation(sourceValue: unknown, scenario: ScenarioV2): void {
  const source = validateSource(sourceValue);
  if (invariantDigest(scenario, source.compiledOriginal) !== source.originalInvariantDigest)
    throw new Error('Original invariant changed');
}
