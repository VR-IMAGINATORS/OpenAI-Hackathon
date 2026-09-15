import type { ScenarioSnapshot } from '../server/scenario-catalog.js';

const fallbackHint = {
  ja: 'まず、動かせそうな場所と、動きをじゃましている物を一つずつ確かめよう。',
  en: 'First, check what can move and what is blocking it, one part at a time.',
};

export interface GimmickGuidance {
  obstacleId: string;
  explanation: string;
  hint: string;
  text: string;
}

function stripHintSuffix(text: string, label: string, hint: string): string {
  const suffix = `\n\n${label}${hint}`;
  let explanation = text.trim();
  while (explanation.endsWith(suffix)) explanation = explanation.slice(0, -suffix.length).trim();
  return explanation;
}

/** Public, authored guidance for the current obstacle only. */
export function gimmickGuidance(
  snapshot: ScenarioSnapshot,
  obstacleIndex: number,
  currentExplanation?: string,
): GimmickGuidance | undefined {
  const obstacle = snapshot.scenarioV2.obstacles[obstacleIndex];
  if (!obstacle) return undefined;
  const locale = snapshot.locale;
  const hint = obstacle.hints?.[0]?.[locale] ?? fallbackHint[locale];
  const label = locale === 'ja' ? 'ヒント: ' : 'Hint: ';
  const explanation = currentExplanation
    ? stripHintSuffix(currentExplanation, label, hint) || obstacle.situationDisplay[locale]
    : obstacle.situationDisplay[locale];
  return {
    obstacleId: obstacle.id,
    explanation,
    hint,
    text: `${explanation}\n\n${label}${hint}`,
  };
}

export function withoutGimmickHint(
  snapshot: ScenarioSnapshot,
  obstacleIndex: number,
  text: string,
): string {
  const obstacle = snapshot.scenarioV2.obstacles[obstacleIndex];
  if (!obstacle) return text;
  const hint = obstacle.hints?.[0]?.[snapshot.locale] ?? fallbackHint[snapshot.locale];
  const label = snapshot.locale === 'ja' ? 'ヒント: ' : 'Hint: ';
  return stripHintSuffix(text, label, hint);
}
