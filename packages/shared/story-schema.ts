import { z } from 'zod';

export const storyTextSchema = z.string().trim().min(1).max(2000);
export const localizedStoryTextSchema = z
  .object({ ja: storyTextSchema, en: storyTextSchema })
  .strict();
export const storyPhasesSchema = z
  .object({
    opening: localizedStoryTextSchema,
    middle: localizedStoryTextSchema,
    final: localizedStoryTextSchema,
  })
  .strict();

/** Server prompt context. Only explicitly presented story text belongs in public history. */
export const storyContextSchema = z
  .object({
    aiName: localizedStoryTextSchema,
    world: localizedStoryTextSchema,
    mystery: localizedStoryTextSchema,
    openingClue: localizedStoryTextSchema,
    phases: storyPhasesSchema,
  })
  .strict();

export type StoryContext = z.infer<typeof storyContextSchema>;
