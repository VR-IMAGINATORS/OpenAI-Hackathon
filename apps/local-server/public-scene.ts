import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import type { GameFacts } from '../../packages/shared/conversation.js';
import { KnowledgeStore } from './companion-knowledge.js';

function currentObstacleScene(
  snapshot: ScenarioSnapshot,
  values: Record<string, string>,
  obstacleId = snapshot.scenarioV2.obstacles[0]!.id,
) {
  const scenario = snapshot.scenarioV2;
  const locale = snapshot.locale;
  const obstacle =
    scenario.obstacles.find((entry) => entry.id === obstacleId) ?? scenario.obstacles[0]!;
  const facts = new Map(scenario.core.facts.map((fact) => [fact.key, fact]));
  const completion = obstacle.completionFact;
  const state =
    completion && values[completion.key] === completion.value
      ? 'cleared'
      : obstacle.factKeys.some((key) => values[key] !== facts.get(key)?.initial)
        ? 'partial'
        : 'blocked';
  const matches = scenario.knowledge.filter((entry) => {
    const target =
      entry.observationTargetId ??
      scenario.investigation?.knowledgeMetadata.find((meta) => meta.knowledgeId === entry.id)
        ?.targetId;
    return (
      target === obstacle.id &&
      entry.kind === 'observable' &&
      entry.revealMode === 'automatic' &&
      entry.prerequisites.every((condition) => values[condition.factKey] === condition.value)
    );
  });
  return {
    id: obstacle.id,
    title: obstacle.title[locale],
    state,
    description:
      matches.map((entry) => entry.localizedText[locale]).join('\n') ||
      obstacle.situationDisplay[locale],
  };
}

/** A presentation allowlist; never includes mechanisms or all-state visual descriptions. */
export function buildPublicScene(snapshot: ScenarioSnapshot, facts?: GameFacts) {
  const scenario = snapshot.scenarioV2;
  const locale = snapshot.locale;
  const values =
    facts?.values ?? Object.fromEntries(scenario.core.facts.map((f) => [f.key, f.initial]));
  const currentObstacle = currentObstacleScene(snapshot, values, facts?.obstacleId);
  const profile = scenario.investigation;
  if (profile) {
    const initial = scenario.core.facts.every((f) => values[f.key] === f.initial);
    const terminal = scenario.obstacles.every((obstacle) => {
      const completion = obstacle.completionFact;
      return completion !== undefined && values[completion.key] === completion.value;
    });
    const currentFactKeys = new Set(
      scenario.obstacles.find((obstacle) => obstacle.id === currentObstacle.id)?.factKeys ?? [],
    );
    const terminalFacts = scenario.obstacles.flatMap((obstacle) =>
      obstacle.completionFact ? [obstacle.completionFact] : [],
    );
    return {
      title: scenario.title[locale],
      overview: initial ? profile.initialOverview[locale] : '',
      currentObstacle,
      visuals: profile.publicVisuals
        .filter(
          (visual) =>
            visual.prerequisites.every(
              (condition) => values[condition.factKey] === condition.value,
            ) &&
            (visual.prerequisites.length === 0 ||
              (terminal
                ? terminalFacts.every((completion) =>
                    visual.prerequisites.some(
                      (condition) =>
                        condition.factKey === completion.key &&
                        condition.value === completion.value,
                    ),
                  )
                : visual.prerequisites.every((condition) =>
                    currentFactKeys.has(condition.factKey),
                  ))),
        )
        .map((visual) => ({ id: visual.id, description: visual.description[locale] })),
    };
  }
  const store = new KnowledgeStore(snapshot);
  if (facts) store.advance(facts);
  return {
    title: scenario.title[locale],
    overview: facts
      ? ''
      : store
          .knownFacts()
          .filter((entry) => entry.currentlyApplicable)
          .map((entry) => entry.text)
          .join('\n') || scenario.obstacles[0]!.situationDisplay[locale],
    currentObstacle,
    visuals: [] as { id: string; description: string }[],
  };
}
