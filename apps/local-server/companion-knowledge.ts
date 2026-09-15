import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import type { GameFacts } from '../../packages/shared/conversation.js';
import type { PublicGameState } from '../../packages/shared/game.js';
import {
  inferenceSchema,
  type Inference,
  type KnowledgeState,
  type ScenarioKnowledgeEntry,
} from '../../packages/shared/harness.js';

/** Server-owned knowledge. Candidate selection never receives unrevealed body text. */
export class KnowledgeStore {
  private version = 0;
  private facts: GameFacts;
  private readonly reveals = new Map<string, 'initial' | 'progress' | 'request' | 'observation'>();
  private readonly inferences = new Map<string, Inference>();
  constructor(readonly source: ScenarioSnapshot) {
    this.facts = {
      obstacleId: source.scenarioV2.obstacles[0]!.id,
      values: Object.fromEntries(
        source.scenarioV2.core.facts.map((fact) => [fact.key, fact.initial]),
      ),
    };
    for (const entry of source.scenarioV2.knowledge)
      if (entry.kind === 'known') this.reveals.set(entry.id, 'initial');
    this.revealAutomatic();
  }
  private satisfies(entry: ScenarioKnowledgeEntry) {
    return entry.prerequisites.every(
      (condition) => this.facts.values[condition.factKey] === condition.value,
    );
  }
  private revealAutomatic() {
    for (const entry of this.source.scenarioV2.knowledge) {
      if (entry.revealMode === 'automatic' && this.satisfies(entry))
        this.reveals.set(entry.id, entry.kind === 'known' ? 'initial' : 'progress');
    }
  }
  advance(facts: GameFacts): void {
    if (JSON.stringify(facts) === JSON.stringify(this.facts)) return;
    this.facts = structuredClone(facts);
    this.version++;
    this.revealAutomatic();
  }
  eligibleRevealCandidates() {
    return {
      version: this.version,
      candidates: this.source.scenarioV2.knowledge
        .filter(
          (entry) =>
            entry.revealMode === 'on_request' &&
            !this.reveals.has(entry.id) &&
            this.satisfies(entry),
        )
        .map((entry) => ({
          id: entry.id,
          requestCue: entry.requestCue[this.source.locale],
          ...(entry.observationTargetId ? { observationTargetId: entry.observationTargetId } : {}),
        })),
    };
  }
  applyReveals(
    ids: string[],
    expectedVersion: number,
    reason: 'request' | 'observation' = 'request',
  ): boolean {
    if (expectedVersion !== this.version || ids.length > 100 || new Set(ids).size !== ids.length)
      return false;
    const allowed = new Set(this.eligibleRevealCandidates().candidates.map((entry) => entry.id));
    if (ids.some((id) => !allowed.has(id))) return false;
    for (const id of ids) this.reveals.set(id, reason);
    if (ids.length) this.version++;
    return true;
  }
  addInference(value: unknown, expectedVersion: number): boolean {
    const parsed = inferenceSchema.safeParse(value);
    if (expectedVersion !== this.version || !parsed.success) return false;
    const inference = parsed.data;
    if (inference.supportingKnownIds.some((id) => !this.reveals.has(id))) return false;
    if (!this.inferences.has(inference.id) && this.inferences.size >= 100) return false;
    this.version++;
    this.inferences.set(inference.id, { ...inference, updatedAtVersion: this.version });
    return true;
  }
  snapshot(): KnowledgeState {
    return {
      version: this.version,
      revealedIds: [...this.reveals.keys()],
      reveals: [...this.reveals].map(([id, reason]) => ({ id, reason })),
      inferences: structuredClone([...this.inferences.values()]),
    };
  }
  knownFacts() {
    return this.source.scenarioV2.knowledge
      .filter((entry) => this.reveals.has(entry.id))
      .map((entry) => ({
        id: entry.id,
        text: entry.localizedText[this.source.locale],
        currentlyApplicable: this.satisfies(entry),
      }));
  }
}

/** Explicit allowlist: no mechanism, solutions, narrative directions or judge prose. */
export function buildCompanionContext(
  snapshot: ScenarioSnapshot,
  store: KnowledgeStore,
  state: PublicGameState,
) {
  const locale = snapshot.locale;
  const story = snapshot.scenarioV2.story;
  const knownFacts = store.knownFacts();
  return {
    ...(story ? { aiName: story.aiName[locale], world: story.world[locale] } : {}),
    scene: snapshot.scenarioV2.title[locale],
    knownFacts,
    inferences: store.snapshot().inferences,
    currentGoal: state.obstacle.title,
    situation:
      knownFacts
        .filter((entry) => entry.currentlyApplicable)
        .map((entry) => entry.text)
        .join('\n') ||
      snapshot.scenarioV2.obstacles[state.obstacle.index]?.situationDisplay[locale] ||
      '',
    inventory: state.inventory.map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
    })),
  };
}
export type CompanionContext = ReturnType<typeof buildCompanionContext>;
