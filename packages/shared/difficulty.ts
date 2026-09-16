import { z } from 'zod';

export const difficultySchema = z.enum(['normal', 'hard', 'nightmare']);
export type Difficulty = z.infer<typeof difficultySchema>;

export const difficultyPresets = {
  normal: {
    totalTimeSeconds: 300,
    initialCredits: 1000,
    label: { ja: 'スタンダード', en: 'Standard' },
    planLabel: { ja: 'Proプラン', en: 'Pro Plan' },
  },
  hard: {
    totalTimeSeconds: 240,
    initialCredits: 750,
    label: { ja: 'ハード', en: 'Hard' },
    planLabel: { ja: 'Plusプラン', en: 'Plus Plan' },
  },
  nightmare: {
    totalTimeSeconds: 180,
    initialCredits: 500,
    label: { ja: 'ヘル', en: 'HELL' },
    planLabel: { ja: '無料プラン', en: 'Free Plan' },
  },
} as const satisfies Record<Difficulty, unknown>;
