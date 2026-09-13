import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const strings = z.array(text).max(30);
export const scenarioSchema = z
  .object({
    version: z.literal(1),
    id,
    title: text,
    premise: text,
    playerBriefing: text,
    rules: z
      .object({
        maxActions: z.number().int().min(1).max(20),
        maxPhotosPerAction: z.number().int().min(1).max(2),
        totalTimeSeconds: z.number().int().min(30).max(3600),
      })
      .strict(),
    setting: z.object({ location: text, characters: strings, constraints: strings }).strict(),
    obstacles: z
      .array(
        z
          .object({
            id,
            title: text,
            situation: text,
            goal: text,
            constraints: strings,
          })
          .strict(),
      )
      .min(1)
      .max(10),
    events: z
      .array(
        z
          .object({
            id,
            title: text,
            mode: z.enum(['required', 'optional', 'disabled']),
            eligibleObstacleIds: z.array(id).min(1).max(10),
            triggerCondition: text,
            timeLimitSeconds: z.number().int().min(10).max(600),
            maxOccurrences: z.number().int().min(1).max(3),
            onTimeout: z.object({ description: text, additionalConstraint: text }).strict(),
          })
          .strict(),
      )
      .max(10),
    ending: z
      .object({ targetDurationSeconds: z.literal(15), generateOnFailure: z.literal(true) })
      .strict(),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    for (const key of ['obstacles', 'events'] as const) {
      const ids = new Set<string>();
      scenario[key].forEach((entry, index) => {
        if (ids.has(entry.id))
          ctx.addIssue({ code: 'custom', path: [key, index, 'id'], message: 'IDが重複しています' });
        ids.add(entry.id);
      });
    }
    if (scenario.obstacles.length > scenario.rules.maxActions) {
      ctx.addIssue({
        code: 'custom',
        path: ['rules', 'maxActions'],
        message: '障害数以上の行動回数が必要です',
      });
    }
    const obstacles = new Set(scenario.obstacles.map((o) => o.id));
    scenario.events.forEach((event, i) =>
      event.eligibleObstacleIds.forEach((ref, j) => {
        if (!obstacles.has(ref))
          ctx.addIssue({
            code: 'custom',
            path: ['events', i, 'eligibleObstacleIds', j],
            message: '存在しない障害IDです',
          });
      }),
    );
  });
export type Scenario = z.infer<typeof scenarioSchema>;
export function parseScenario(value: unknown): Scenario {
  return scenarioSchema.parse(value);
}
export function publicScenario(value: Scenario) {
  return {
    id: value.id,
    title: value.title,
    playerBriefing: value.playerBriefing,
    rules: value.rules,
    obstacleCount: value.obstacles.length,
  };
}
export type PublicScenario = ReturnType<typeof publicScenario>;

// V1 remains the compatibility contract for the existing runtime during migration.
const localizedText = z.object({ ja: text, en: text }).strict();
const transitionSchema = z.object({ from: id, to: id }).strict();
const factSchema = z
  .object({
    key: id,
    initial: id,
    values: z.array(id).min(1).max(10),
    allowedTransitions: z.array(transitionSchema).max(100),
    visualDescription: text,
  })
  .strict();
const visualFactSchema = z.object({ key: id, value: id }).strict();
const visualChangeSchema = z.object({ key: id, from: id, to: id }).strict();
export const scenarioV2Schema = z
  .object({
    version: z.literal(2),
    id,
    title: localizedText,
    premise: localizedText,
    playerBriefing: localizedText,
    rules: scenarioSchema.shape.rules,
    setting: scenarioSchema.shape.setting,
    obstacles: z
      .array(
        z
          .object({
            id,
            title: localizedText,
            situation: text,
            situationDisplay: localizedText,
            goal: text,
            constraints: strings,
            factKeys: z.array(id).min(1).max(30),
            requiredVisualFacts: z.array(visualFactSchema).max(30),
            forbiddenVisualChanges: z.array(visualChangeSchema).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    events: scenarioSchema.shape.events,
    ending: scenarioSchema.shape.ending,
    core: z
      .object({
        facts: z.array(factSchema).min(1).max(30),
        characterAppearance: text,
        visualStyle: text,
        judgmentPolicy: text,
        hintLevels: z.array(text).min(1).max(10),
      })
      .strict(),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const unique = (values: string[], path: (string | number)[]) => {
      const seen = new Set<string>();
      values.forEach((value, i) => {
        if (seen.has(value)) issue([...path, i], 'Duplicate value');
        seen.add(value);
      });
    };
    unique(
      scenario.obstacles.map((o) => o.id),
      ['obstacles'],
    );
    unique(
      scenario.events.map((e) => e.id),
      ['events'],
    );
    unique(
      scenario.core.facts.map((f) => f.key),
      ['core', 'facts'],
    );
    if (scenario.obstacles.length > scenario.rules.maxActions)
      issue(['rules', 'maxActions'], 'Too few actions for obstacles');
    const obstacleIds = new Set(scenario.obstacles.map((o) => o.id));
    scenario.events.forEach((event, i) => {
      unique(event.eligibleObstacleIds, ['events', i, 'eligibleObstacleIds']);
      event.eligibleObstacleIds.forEach((ref, j) => {
        if (!obstacleIds.has(ref))
          issue(['events', i, 'eligibleObstacleIds', j], 'Unknown obstacle');
      });
    });
    const facts = new Map(scenario.core.facts.map((f) => [f.key, f]));
    scenario.core.facts.forEach((fact, i) => {
      const path = ['core', 'facts', i];
      unique(fact.values, [...path, 'values']);
      if (!fact.values.includes(fact.initial))
        issue([...path, 'initial'], 'Undeclared initial value');
      unique(
        fact.allowedTransitions.map((t) => `${t.from}:${t.to}`),
        [...path, 'allowedTransitions'],
      );
      fact.allowedTransitions.forEach((t, j) => {
        if (!fact.values.includes(t.from) || !fact.values.includes(t.to) || t.from === t.to) {
          issue([...path, 'allowedTransitions', j], 'Invalid transition');
        }
      });
    });
    scenario.obstacles.forEach((obstacle, i) => {
      const path = ['obstacles', i];
      unique(obstacle.factKeys, [...path, 'factKeys']);
      obstacle.factKeys.forEach((key, j) => {
        if (!facts.has(key)) issue([...path, 'factKeys', j], 'Undeclared fact key');
      });
      unique(
        obstacle.requiredVisualFacts.map((f) => f.key),
        [...path, 'requiredVisualFacts'],
      );
      obstacle.requiredVisualFacts.forEach((ref, j) => {
        if (
          !obstacle.factKeys.includes(ref.key) ||
          !facts.get(ref.key)?.values.includes(ref.value)
        ) {
          issue([...path, 'requiredVisualFacts', j], 'Undeclared visual fact');
        }
      });
      unique(
        obstacle.forbiddenVisualChanges.map((f) => `${f.key}:${f.from}:${f.to}`),
        [...path, 'forbiddenVisualChanges'],
      );
      obstacle.forbiddenVisualChanges.forEach((ref, j) => {
        const fact = facts.get(ref.key);
        if (
          !obstacle.factKeys.includes(ref.key) ||
          !fact?.values.includes(ref.from) ||
          !fact.values.includes(ref.to) ||
          ref.from === ref.to
        ) {
          issue([...path, 'forbiddenVisualChanges', j], 'Undeclared visual change');
        }
      });
    });
  });
export type ScenarioV2 = z.infer<typeof scenarioV2Schema>;
export function parseScenarioV2(value: unknown): ScenarioV2 {
  return scenarioV2Schema.parse(value);
}
/** Compatibility projection only; core facts and policy stay in the V2 snapshot. */
export function localizeScenario(value: ScenarioV2, locale: 'ja' | 'en'): Scenario {
  return parseScenario({
    version: 1,
    id: value.id,
    title: value.title[locale],
    premise: value.premise[locale],
    playerBriefing: value.playerBriefing[locale],
    rules: value.rules,
    setting: value.setting,
    obstacles: value.obstacles.map((o) => ({
      id: o.id,
      title: o.title[locale],
      situation: o.situationDisplay[locale],
      goal: o.goal,
      constraints: o.constraints,
    })),
    events: value.events,
    ending: value.ending,
  });
}
export function publicScenarioV2(value: ScenarioV2) {
  return {
    id: value.id,
    title: value.title,
    playerBriefing: value.playerBriefing,
    rules: value.rules,
    obstacleCount: value.obstacles.length,
  };
}
export type PublicScenarioV2 = ReturnType<typeof publicScenarioV2>;
