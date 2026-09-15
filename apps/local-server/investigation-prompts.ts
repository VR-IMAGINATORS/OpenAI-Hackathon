import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CompanionInitiative } from '../../packages/shared/core-config.js';
export type InvestigationPrompts = Readonly<
  Record<'selection' | 'response' | CompanionInitiative, string>
>;
/** Load once when a play's KnowledgeStore is created; forks retain the same frozen bundle. */
export function loadInvestigationPrompts(): InvestigationPrompts {
  const entries = ['selection', 'response', 'observations', 'hypotheses', 'suggestions'] as const;
  return Object.freeze(
    Object.fromEntries(
      entries.map((name) => {
        const text = readFileSync(resolve('config/prompts/investigation', name + '.md'), 'utf8');
        if (!text.trim() || Buffer.byteLength(text) > 12 * 1024)
          throw new Error('INVESTIGATION_PROMPT_INVALID');
        return [name, text];
      }),
    ) as Record<(typeof entries)[number], string>,
  );
}
