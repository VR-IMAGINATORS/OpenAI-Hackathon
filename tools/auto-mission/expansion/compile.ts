import { parseScenarioV2, type ScenarioV2 } from '../../../packages/shared/scenario.js';
import { assertSize, parseExpansionCandidate } from './schemas.js';
import { validateSource, validatePreservation } from './source.js';
export function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  let value = root;
  for (const part of pointer
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part))
      throw new Error('Unknown JSON pointer: ' + pointer);
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export function compileExpandedScenario(sourceValue: unknown, candidateValue: unknown): ScenarioV2 {
  const source = validateSource(sourceValue);
  const candidate = parseExpansionCandidate(candidateValue);
  if (
    candidate.sourceDigest !== source.sourceDigest ||
    candidate.originalInvariantDigest !== source.originalInvariantDigest
  )
    throw new Error('Candidate source digest mismatch');
  const result = structuredClone(source.compiledOriginal);
  const paths = new Set<string>();
  for (const override of candidate.displayOverrides) {
    if (
      !new RegExp(
        '^(?:/(?:premise|playerBriefing)|/obstacles/(?:0|[1-9][0-9]*)/(?:title|situationDisplay)|/knowledge/(?:0|[1-9][0-9]*)/localizedText|/observationTargets/(?:0|[1-9][0-9]*)/description)$',
      ).test(override.path)
    )
      throw new Error('Forbidden display override: ' + override.path);
    if (paths.has(override.path)) throw new Error('Duplicate display override');
    paths.add(override.path);
    resolvePointer(result, override.path);
    const split = override.path.lastIndexOf('/');
    const parent = resolvePointer(result, override.path.slice(0, split)) as Record<string, unknown>;
    parent[override.path.slice(split + 1)] = override.value;
  }
  for (const entry of candidate.knowledgeAdditions) {
    const meta = candidate.knowledgeMetadata.find((meta) => meta.knowledgeId === entry.id);
    if (!meta || entry.observationTargetId !== meta.targetId)
      throw new Error('Added knowledge requires matching target and layer metadata');
  }
  result.knowledge.push(...candidate.knowledgeAdditions);
  result.observationTargets.push(...candidate.observationTargets);
  result.investigation = {
    initialOverview: candidate.openingOverview,
    knowledgeMetadata: candidate.knowledgeMetadata,
    ambienceSlots: candidate.ambienceSlots,
    publicVisuals: candidate.publicVisuals,
    sourceRef: {
      sourceDigest: source.sourceDigest,
      candidateId: candidate.candidateId,
      revision: candidate.revision,
    },
  };
  // References address the raw catalog and the complete candidate, never guessed paths.
  const rawSource: unknown = JSON.parse(source.rawCatalogText);
  for (const change of candidate.changeMap) {
    resolvePointer(rawSource, change.sourcePointer);
    resolvePointer(candidate, change.expandedPointer);
  }
  assertSize(result, 'Compiled scenario');
  const parsed = parseScenarioV2(result);
  validatePreservation(source, parsed);
  return parsed;
}
