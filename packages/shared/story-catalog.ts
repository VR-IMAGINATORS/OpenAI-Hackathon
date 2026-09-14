import { z } from 'zod';
import { parseScenarioV2, scenarioSchema, type ScenarioV2 } from './scenario.js';
import { localizedStoryTextSchema as localized, storyPhasesSchema } from './story-schema.js';

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const localizedList = z.array(localized).min(1).max(10);
const referenceSchema = z
  .object({
    itemIds: z.array(id).min(1).max(2),
    requiredProperties: z.array(id).min(1).max(20),
    use: localized,
    photoCount: z.number().int().min(1).max(2),
    preconditions: z.array(localized).max(10),
    consumes: z.array(id).max(2),
    breaks: z.array(id).max(2),
    clears: z.literal(true),
    postconditions: localizedList,
  })
  .strict();
const stages = ['restraint', 'route', 'exit'] as const;
export const storyCatalogSchema = z
  .object({
    version: z.literal(3),
    id,
    title: localized,
    playerBriefing: localized,
    rules: scenarioSchema.shape.rules,
    story: z.object({ aiName: localized, world: localized, phases: storyPhasesSchema }).strict(),
    scenes: z
      .array(
        z
          .object({
            id: id.max(60),
            name: localized,
            description: localized,
            anchor: localized,
            mystery: localized,
            openingClue: localized,
            sequences: z.array(z.array(id).length(3)).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    gimmicks: z
      .array(
        z
          .object({
            id,
            stage: z.enum(stages),
            name: localized,
            objective: localized,
            observation: localized,
            mechanism: localized,
            hints: z.array(localized).length(3),
            acceptance: localizedList,
            rejection: localizedList,
            examples: localizedList,
            referenceSolutions: z.array(referenceSchema).min(1).max(10),
            states: z
              .object({ blocked: localized, partial: localized, cleared: localized })
              .strict(),
          })
          .strict(),
      )
      .min(3)
      .max(30),
    items: z
      .array(
        z
          .object({
            id,
            name: localized,
            properties: z.array(id).min(1).max(20),
            uses: localizedList,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const unique = (values: string[], path: (string | number)[]) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) issue([...path, index], 'Duplicate value');
        seen.add(value);
      });
    };
    for (const key of ['scenes', 'gimmicks', 'items'] as const)
      unique(
        catalog[key].map((entry) => entry.id),
        [key],
      );
    if (catalog.rules.maxActions < 3)
      issue(['rules', 'maxActions'], 'Too few actions for three obstacles');
    const gimmicks = new Map(catalog.gimmicks.map((gimmick) => [gimmick.id, gimmick]));
    const selected = new Set<string>();
    catalog.scenes.forEach((scene, sceneIndex) => {
      unique(
        scene.sequences.map((sequence) => sequence.join(':')),
        ['scenes', sceneIndex, 'sequences'],
      );
      scene.sequences.forEach((sequence, sequenceIndex) => {
        const path = ['scenes', sceneIndex, 'sequences', sequenceIndex];
        unique(sequence, path);
        sequence.forEach((ref, index) => {
          const gimmick = gimmicks.get(ref);
          if (!gimmick) issue([...path, index], 'Unknown gimmick');
          else if (gimmick.stage !== stages[index])
            issue([...path, index], 'Sequence must progress through restraint, route, exit');
          selected.add(ref);
        });
      });
    });
    const items = new Map(catalog.items.map((item) => [item.id, item]));
    catalog.items.forEach((item, index) => unique(item.properties, ['items', index, 'properties']));
    catalog.gimmicks.forEach((gimmick, index) => {
      if (!selected.has(gimmick.id)) issue(['gimmicks', index, 'id'], 'Unreferenced gimmick');
      gimmick.referenceSolutions.forEach((solution, solutionIndex) => {
        const path = ['gimmicks', index, 'referenceSolutions', solutionIndex];
        unique(solution.itemIds, [...path, 'itemIds']);
        unique(solution.requiredProperties, [...path, 'requiredProperties']);
        solution.itemIds.forEach((ref, itemIndex) => {
          if (!items.has(ref)) issue([...path, 'itemIds', itemIndex], 'Unknown item');
        });
        if (
          solution.photoCount !== solution.itemIds.length ||
          solution.photoCount > catalog.rules.maxPhotosPerAction
        )
          issue([...path, 'photoCount'], 'Reference photos must match items and game rules');
        const properties = new Set(
          solution.itemIds.flatMap((ref) => items.get(ref)?.properties ?? []),
        );
        solution.requiredProperties.forEach((property, propertyIndex) => {
          if (!properties.has(property))
            issue([...path, 'requiredProperties', propertyIndex], 'Reference item lacks property');
        });
        for (const key of ['consumes', 'breaks'] as const) {
          unique(solution[key], [...path, key]);
          solution[key].forEach((ref, itemIndex) => {
            if (!solution.itemIds.includes(ref))
              issue([...path, key, itemIndex], 'Unknown reference item state change');
          });
        }
      });
    });
  });

export type StoryCatalog = z.infer<typeof storyCatalogSchema>;

export function storyCandidateCount(catalog: StoryCatalog): number {
  return catalog.scenes.reduce((count, scene) => count + scene.sequences.length, 0);
}

/** Compile one candidate in scene order, then sequence order. No randomness or I/O here. */
export function compileStoryScenario(catalog: StoryCatalog, candidateIndex: number): ScenarioV2 {
  if (
    !Number.isInteger(candidateIndex) ||
    candidateIndex < 0 ||
    candidateIndex >= storyCandidateCount(catalog)
  )
    throw new RangeError('Invalid story candidate index');
  let sequenceIndex = candidateIndex;
  const scene = catalog.scenes.find((entry) => {
    if (sequenceIndex < entry.sequences.length) return true;
    sequenceIndex -= entry.sequences.length;
    return false;
  })!;
  const sequence = scene.sequences[sequenceIndex]!;
  const selected = sequence.map((ref) => catalog.gimmicks.find((entry) => entry.id === ref)!);
  const transitions = [
    { from: 'blocked', to: 'partial' },
    { from: 'blocked', to: 'cleared' },
    { from: 'partial', to: 'cleared' },
  ];
  return parseScenarioV2({
    version: 2,
    id: `${scene.id}-${sequenceIndex + 1}`,
    title: scene.name,
    premise: scene.description,
    playerBriefing: catalog.playerBriefing,
    rules: catalog.rules,
    setting: {
      location: scene.description.ja,
      characters: [
        scene.anchor.ja,
        `衣服の緊急端末で動作する専属サポートAI、${catalog.story.aiName.ja}。身体はなく、道具を介して作業する。`,
      ],
      constraints: [
        '写真の道具は対象と同じ手前側の見える作業範囲にだけ現れ、壁・扉・格子の向こうへ直接現れない。',
        '身体拘束は最初に選ばれた一か所だけ。足音や影は演出であり隠し期限や失敗条件ではない。',
        '最後の出口のすぐ外は障害のない退避路。第四の障害や新しい追跡戦を加えない。',
      ],
    },
    story: { ...catalog.story, mystery: scene.mystery, openingClue: scene.openingClue },
    obstacles: selected.map((gimmick) => ({
      id: gimmick.id,
      title: gimmick.objective,
      situation: gimmick.observation.ja,
      situationDisplay: gimmick.observation,
      goal: [...gimmick.acceptance.map((entry) => entry.ja), gimmick.states.cleared.ja].join('\n'),
      constraints: [...gimmick.rejection, ...gimmick.examples].map((entry) => entry.ja),
      factKeys: [gimmick.id],
      requiredVisualFacts: [{ key: gimmick.id, value: 'blocked' }],
      forbiddenVisualChanges: [
        { key: gimmick.id, from: 'blocked', to: 'cleared' },
        { key: gimmick.id, from: 'partial', to: 'cleared' },
      ],
      mechanism: gimmick.mechanism,
      hints: gimmick.hints,
      completionFact: { key: gimmick.id, value: 'cleared' },
    })),
    events: [],
    ending: { targetDurationSeconds: 15, generateOnFailure: true },
    core: {
      facts: selected.map((gimmick) => ({
        key: gimmick.id,
        initial: 'blocked',
        values: ['blocked', 'partial', 'cleared'],
        allowedTransitions: transitions,
        visualDescription: `blocked: ${gimmick.states.blocked.ja}\npartial: ${gimmick.states.partial.ja}\ncleared: ${gimmick.states.cleared.ja}`,
      })),
      characterAppearance: scene.anchor.ja,
      visualStyle:
        'ミステリー映画風。現在の舞台と観察できる障害を読み取れる構図。説明文字は使わず、未公開の障害と便利な道具を先出ししない。',
      judgmentPolicy:
        '日用品の観察できる物性と使い方を評価する。代表アイテム名に限定せず、同じ作用の代用品や筋の通る組み合わせを認める。見えない機能や非公開の寸法・重量閾値を加えない。実際に変化した場合だけpartialにし、具体的な進展をsituationへ残す。clearedは完了条件を全て満たした時だけ。足音や物音だけで失敗させず、履歴にない破損や拘束を加えない。',
      hintLevels: [
        '求められたら現在の障害の観察を伝える。',
        'さらに求められたら現在の障害に必要な物理作用を伝える。',
        '再度求められたら現在の障害の具体的な使い方を一つ示す。',
      ],
    },
  });
}

export function parseStoryCatalog(value: unknown): StoryCatalog {
  const catalog = storyCatalogSchema.parse(value);
  // Validate every candidate before selection, including composed V2 text limits.
  for (let index = 0; index < storyCandidateCount(catalog); index++)
    compileStoryScenario(catalog, index);
  return catalog;
}
