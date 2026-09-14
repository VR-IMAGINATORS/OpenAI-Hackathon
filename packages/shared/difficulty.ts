import { z } from 'zod';

export const difficultySchema = z.enum(['normal', 'hard', 'nightmare']);
export type Difficulty = z.infer<typeof difficultySchema>;

export const difficultyPresets = {
  normal: { totalTimeSeconds: 300, maxPhotoSends: 4, label: { ja: 'ノーマル', en: 'Normal' } },
  hard: { totalTimeSeconds: 240, maxPhotoSends: 3, label: { ja: 'ハード', en: 'Hard' } },
  nightmare: { totalTimeSeconds: 180, maxPhotoSends: 2, label: { ja: 'ヘル', en: 'HELL' } },
} as const satisfies Record<Difficulty, unknown>;
