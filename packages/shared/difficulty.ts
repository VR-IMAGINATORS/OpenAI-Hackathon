import { z } from 'zod';

export const difficultySchema = z.enum(['normal', 'hard', 'nightmare']);
export type Difficulty = z.infer<typeof difficultySchema>;

export const difficultyPresets = {
  normal: {
    totalTimeSeconds: 300,
    initialCredits: 1000,
    label: { ja: 'スタンダードProプラン', en: 'Standard Pro Plan' },
  },
  hard: {
    totalTimeSeconds: 240,
    initialCredits: 700,
    label: { ja: 'ハードPlusプラン', en: 'Hard Plus Plan' },
  },
  nightmare: {
    totalTimeSeconds: 180,
    initialCredits: 400,
    label: { ja: 'ヘル無料プラン', en: 'HELL Free Plan' },
  },
} as const satisfies Record<Difficulty, unknown>;
