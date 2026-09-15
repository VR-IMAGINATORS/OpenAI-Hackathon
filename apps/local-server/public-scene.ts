import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import type { GameFacts } from '../../packages/shared/conversation.js';
import { KnowledgeStore } from './companion-knowledge.js';

/** A presentation allowlist; never includes mechanisms or all-state visual descriptions. */
export function buildPublicScene(snapshot: ScenarioSnapshot, facts?: GameFacts) {
  const scenario = snapshot.scenarioV2;
  const locale = snapshot.locale;
  const values =
    facts?.values ?? Object.fromEntries(scenario.core.facts.map((f) => [f.key, f.initial]));
  const profile = scenario.investigation;
  if (profile) {
    const initial = scenario.core.facts.every((f) => values[f.key] === f.initial);
    return {
      title: scenario.title[locale],
      overview: initial ? profile.initialOverview[locale] : '',
      visuals: profile.publicVisuals
        .filter((visual) =>
          visual.prerequisites.every((condition) => values[condition.factKey] === condition.value),
        )
        .map((visual) => ({ id: visual.id, description: visual.description[locale] })),
    };
  }
  const store = new KnowledgeStore(snapshot);
  if (facts) store.advance(facts);
  return {
    title: scenario.title[locale],
    overview:
      store
        .knownFacts()
        .filter((entry) => entry.currentlyApplicable)
        .map((entry) => entry.text)
        .join('\n') || scenario.obstacles[0]!.situationDisplay[locale],
    visuals: [] as { id: string; description: string }[],
  };
}
