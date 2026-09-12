import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const strings = z.array(text).max(30);
export const scenarioSchema = z.object({
  version: z.literal(1),
  id, title: text, premise: text, playerBriefing: text,
  rules: z.object({
    maxActions: z.number().int().min(1).max(20),
    maxPhotosPerAction: z.number().int().min(1).max(2),
    totalTimeSeconds: z.number().int().min(30).max(3600),
  }).strict(),
  setting: z.object({ location: text, characters: strings, constraints: strings }).strict(),
  obstacles: z.array(z.object({
    id, title: text, situation: text, goal: text, constraints: strings,
  }).strict()).min(1).max(10),
  events: z.array(z.object({
    id, title: text, mode: z.enum(['required', 'optional', 'disabled']),
    eligibleObstacleIds: z.array(id).min(1).max(10),
    triggerCondition: text,
    timeLimitSeconds: z.number().int().min(10).max(600),
    maxOccurrences: z.number().int().min(1).max(3),
    onTimeout: z.object({ description: text, additionalConstraint: text }).strict(),
  }).strict()).max(10),
  ending: z.object({ targetDurationSeconds: z.literal(15), generateOnFailure: z.literal(true) }).strict(),
}).strict().superRefine((scenario, ctx) => {
  for (const key of ['obstacles', 'events'] as const) {
    const ids = new Set<string>();
    scenario[key].forEach((entry, index) => {
      if (ids.has(entry.id)) ctx.addIssue({ code: 'custom', path: [key, index, 'id'], message: 'IDが重複しています' });
      ids.add(entry.id);
    });
  }
  if (scenario.obstacles.length > scenario.rules.maxActions) {
    ctx.addIssue({ code: 'custom', path: ['rules', 'maxActions'], message: '障害数以上の行動回数が必要です' });
  }
  const obstacles = new Set(scenario.obstacles.map(o => o.id));
  scenario.events.forEach((event, i) => event.eligibleObstacleIds.forEach((ref, j) => {
    if (!obstacles.has(ref)) ctx.addIssue({ code: 'custom', path: ['events', i, 'eligibleObstacleIds', j], message: '存在しない障害IDです' });
  }));
});
export type Scenario = z.infer<typeof scenarioSchema>;
export function parseScenario(value: unknown): Scenario { return scenarioSchema.parse(value); }
export function publicScenario(value: Scenario) {
  return { id: value.id, title: value.title, playerBriefing: value.playerBriefing,
    rules: value.rules, obstacleCount: value.obstacles.length };
}
export type PublicScenario = ReturnType<typeof publicScenario>;
