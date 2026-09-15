import type { CompanionContext } from './companion-knowledge.js';

export interface PublicActionResult {
  success: boolean;
  narrative: string;
  situation?: string;
}
/** Only committed, publicly projected results may enter this boundary. No dialogue model. */
export function companionResultFacts(
  publicContext: CompanionContext,
  resultPublic: PublicActionResult,
): string {
  return JSON.stringify({
    type: 'action_result',
    success: resultPublic.success,
    result: resultPublic.narrative,
    situation: publicContext.situation || resultPublic.situation,
    inventory: publicContext.inventory.map(({ name, status }) => ({ name, status })),
  });
}
