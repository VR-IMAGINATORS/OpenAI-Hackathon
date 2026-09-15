import { loadInvestigationPrompts, type InvestigationPrompts } from './investigation-prompts.js';
import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import type { GameFacts } from '../../packages/shared/conversation.js';
import type { PublicGameState } from '../../packages/shared/game.js';
import {
  inferenceSchema,
  type AmbienceValue,
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
  private readonly ambience = new Map<string, AmbienceValue>();
  constructor(
    readonly source: ScenarioSnapshot,
    readonly prompts: InvestigationPrompts = loadInvestigationPrompts(),
  ) {
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
  /** Declared source hints cannot be downgraded; other entries use explicit metadata. */
  metadata(entry: ScenarioKnowledgeEntry): {
    targetId: string;
    layer: 'overview' | 'detail' | 'hint' | 'background';
  } {
    const explicit = this.source.scenarioV2.investigation?.knowledgeMetadata.find(
      (meta) => meta.knowledgeId === entry.id,
    );
    const hintOwner = this.source.scenarioV2.obstacles.find((obstacle) =>
      obstacle.hints?.some(
        (hint, index) =>
          (hint.ja === entry.localizedText.ja && hint.en === entry.localizedText.en) ||
          entry.id === obstacle.id + '-hint-' + (index + 1) ||
          entry.id === obstacle.id + '-hint-' + (index + 1) + '-partial',
      ),
    );
    if (hintOwner) return { targetId: hintOwner.id, layer: 'hint' };
    if (explicit) return { targetId: explicit.targetId, layer: explicit.layer };
    return {
      targetId: entry.observationTargetId ?? this.facts.obstacleId,
      layer: entry.kind === 'known' ? 'overview' : 'detail',
    };
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
          ...this.metadata(entry),
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
  selectHint(obstacleId: string, requestedLevel: number) {
    const obstacle = this.source.scenarioV2.obstacles.find((entry) => entry.id === obstacleId);
    if (!obstacle) return undefined;
    const entries = this.source.scenarioV2.knowledge.filter((entry) => {
      const meta = this.metadata(entry);
      return meta.layer === 'hint' && meta.targetId === obstacleId && this.satisfies(entry);
    });
    const distinct = entries.filter(
      (entry, index) =>
        entries.findIndex(
          (other) =>
            other.localizedText.ja === entry.localizedText.ja &&
            other.localizedText.en === entry.localizedText.en,
        ) === index,
    );
    const levels = obstacle.hints?.length || distinct.length;
    if (!levels) return undefined;
    const index = Math.min(Math.max(0, requestedLevel), levels - 1);
    const authored = obstacle.hints?.[index];
    const entry =
      (authored
        ? entries.find(
            (entry) =>
              entry.localizedText.ja === authored.ja && entry.localizedText.en === authored.en,
          )
        : undefined) ?? distinct[index];
    return entry ? { id: entry.id, level: index + 1 } : undefined;
  }
  availableAmbienceSlots() {
    const reachable = new Set([
      this.facts.obstacleId,
      ...this.source.scenarioV2.knowledge
        .filter((entry) => this.satisfies(entry))
        .map((entry) => this.metadata(entry).targetId),
    ]);
    return (this.source.scenarioV2.investigation?.ambienceSlots ?? []).filter((slot) =>
      reachable.has(slot.targetId),
    );
  }
  addAmbience(
    slotId: string,
    valueIndex: number,
    expectedVersion: number,
    sourceRequestId: string,
  ): boolean {
    if (
      expectedVersion !== this.version ||
      !Number.isInteger(valueIndex) ||
      valueIndex < 0 ||
      !sourceRequestId ||
      sourceRequestId.length > 128
    )
      return false;
    const slot = this.availableAmbienceSlots().find((entry) => entry.id === slotId);
    const value = slot?.allowedValues[valueIndex]?.[this.source.locale];
    if (!slot || !value) return false;
    const existing = this.ambience.get(slotId);
    if (existing) return existing.value === value;
    if (this.ambience.size >= 30) return false;
    this.version++;
    this.ambience.set(slotId, { slotId, value, createdAtVersion: this.version, sourceRequestId });
    return true;
  }
  fork(): KnowledgeStore {
    const draft = new KnowledgeStore(this.source, this.prompts);
    draft.copyFrom(this);
    return draft;
  }
  commitFrom(draft: KnowledgeStore, expectedVersion: number): boolean {
    if (
      this.version !== expectedVersion ||
      draft.source !== this.source ||
      JSON.stringify(this.facts) !== JSON.stringify(draft.facts)
    )
      return false;
    this.copyFrom(draft);
    return true;
  }
  private copyFrom(other: KnowledgeStore) {
    this.version = other.version;
    this.facts = structuredClone(other.facts);
    this.reveals.clear();
    for (const [key, value] of other.reveals) this.reveals.set(key, value);
    this.inferences.clear();
    for (const [key, value] of other.inferences) this.inferences.set(key, structuredClone(value));
    this.ambience.clear();
    for (const [key, value] of other.ambience) this.ambience.set(key, structuredClone(value));
  }
  snapshot(): KnowledgeState {
    return {
      version: this.version,
      revealedIds: [...this.reveals.keys()],
      reveals: [...this.reveals].map(([id, reason]) => ({ id, reason })),
      inferences: structuredClone([...this.inferences.values()]),
      ambience: structuredClone([...this.ambience.values()]),
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
    initiative: snapshot.coreConfig.companionInitiative,
    initialOverview: snapshot.scenarioV2.investigation?.initialOverview[locale],
    ambience: store.snapshot().ambience.map((value) => {
      const slot = snapshot.scenarioV2.investigation!.ambienceSlots.find(
        (slot) => slot.id === value.slotId,
      )!;
      return { targetId: slot.targetId, attribute: slot.attribute, value: value.value };
    }),
    ambienceAllowance: store.availableAmbienceSlots().map((slot) => ({
      targetId: slot.targetId,
      attribute: slot.attribute,
      allowedValues: slot.allowedValues.map((value) => value[locale]),
    })),
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
type FullCompanionContext = ReturnType<typeof buildCompanionContext>;
type OptionalCompanionFields = 'initiative' | 'initialOverview' | 'ambience' | 'ambienceAllowance';
export type CompanionContext = Omit<FullCompanionContext, OptionalCompanionFields> &
  Partial<Pick<FullCompanionContext, OptionalCompanionFields>>;
