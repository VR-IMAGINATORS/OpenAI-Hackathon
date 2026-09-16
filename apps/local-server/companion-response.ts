import type { CompanionContext } from './companion-knowledge.js';

export interface PublicActionResult {
  success: boolean;
  narrative: string;
  situation?: string;
}
export interface PublicActionAttempt {
  actionId: string;
  target: string;
  usage: string;
  items: string[];
}
/** Only committed, publicly projected results may enter this boundary. No dialogue model. */
export function companionResultFacts(
  publicContext: CompanionContext,
  resultPublic: PublicActionResult,
  attempt?: PublicActionAttempt,
): string {
  return JSON.stringify({
    type: 'action_result',
    success: resultPublic.success,
    result: resultPublic.narrative,
    ...(attempt
      ? {
          attempt: {
            actionId: attempt.actionId,
            target: attempt.target,
            usage: attempt.usage,
            items: attempt.items,
          },
        }
      : {}),
    situation: publicContext.situation || resultPublic.situation,
    inventory: publicContext.inventory.map(({ name, status }) => ({ name, status })),
    initiative: publicContext.initiative,
    currentObstacleGuide: publicContext.currentObstacleGuide,
    ambience: publicContext.ambience?.map(({ targetId, attribute, value }) => ({
      targetId,
      attribute,
      value,
    })),
  });
}
