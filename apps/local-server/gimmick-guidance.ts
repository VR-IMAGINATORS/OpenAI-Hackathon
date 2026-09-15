import type { ScenarioSnapshot } from '../server/scenario-catalog.js';

const fallbackHint = {
  ja: '動きをじゃましている物をどかせるものがあればなぁ…。動かせそうな部分を自由にできるかもしれないね。',
  en: 'If only we had something to move whatever is blocking it… That might let the stuck part move freely.',
};

export interface GimmickGuidance {
  obstacleId: string;
  explanation: string;
  hint: string;
  text: string;
}

function stripHintSuffix(text: string, label: string, hint: string): string {
  // Accept the old labelled form too when refreshing an existing presentation.
  const suffixes = [`\n\n${hint}`, `\n\n${label}${hint}`];
  let explanation = text.trim();
  let suffix: string | undefined;
  while ((suffix = suffixes.find((value) => explanation.endsWith(value))))
    explanation = explanation.slice(0, -suffix.length).trim();
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
    text: `${explanation}\n\n${hint}`,
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
