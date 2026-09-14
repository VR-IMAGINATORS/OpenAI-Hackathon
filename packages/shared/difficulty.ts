import { z } from 'zod';

export const difficultySchema = z.enum(['normal', 'hard', 'nightmare']);
export type Difficulty = z.infer<typeof difficultySchema>;

export const difficultyPresets = {
  normal: { totalTimeSeconds: 300, maxActions: 4, label: { ja: 'ノーマル', en: 'Normal' } },
  hard: { totalTimeSeconds: 240, maxActions: 3, label: { ja: 'ハード', en: 'Hard' } },
  nightmare: { totalTimeSeconds: 180, maxActions: 3, label: { ja: 'ナイトメア', en: 'Nightmare' } },
} as const satisfies Record<Difficulty, unknown>;
