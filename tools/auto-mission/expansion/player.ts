import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { AIResponsesClient } from '../../../apps/local-server/game-ai.js';
import { parseResponseObject } from './generator.js';
import { strictOutputSchema } from '../provider.js';
import type { PlayerView } from './play-adapter.js';
export const playerPersonaSchema = z.enum(['investigation', 'broad', 'early']);
export type PlayerPersona = z.infer<typeof playerPersonaSchema>;
export const playerRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ask'), text: z.string().trim().min(1).max(2000) }).strict(),
  z
    .object({
      kind: z.literal('send_items'),
      catalogIds: z
        .array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/))
        .min(1)
        .max(2),
      usage: z.string().trim().min(1).max(1000).nullable(),
    })
    .strict(),
]);
export type PlayerRequest = z.infer<typeof playerRequestSchema>;
const playerEnvelope = z.object({ request: z.union(playerRequestSchema.options) }).strict();
export type PlayerPrompts = Readonly<Record<'base' | PlayerPersona, string>>;
export function loadPlayerPrompts(): PlayerPrompts {
  return Object.freeze(
    Object.fromEntries(
      (['base', 'investigation', 'broad', 'early'] as const).map((name) => {
        const value = readFileSync(
          new URL('./prompts/player-' + name + '.md', import.meta.url),
          'utf8',
        );
        if (!value.trim() || Buffer.byteLength(value) > 12 * 1024)
          throw new Error('PLAYER_PROMPT_INVALID');
        return [name, value];
      }),
    ) as Record<'base' | PlayerPersona, string>,
  );
}
export async function requestPlayerTurn(options: {
  client: AIResponsesClient;
  model: string;
  persona: PlayerPersona;
  locale: 'ja' | 'en';
  view: PlayerView;
  prompts: PlayerPrompts;
  signal?: AbortSignal;
}): Promise<PlayerRequest> {
  options.signal?.throwIfAborted();
  const response = await options.client.respond(
    {
      model: options.model,
      reasoning: { effort: 'low' },
      max_output_tokens: 500,
      store: false,
      instructions: [
        options.prompts.base,
        options.prompts[options.persona],
        'Use ' + options.locale + ' for the player request.',
      ].join('\n'),
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: JSON.stringify({ view: options.view }) }],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'expansion_player',
          strict: true,
          schema: strictOutputSchema(playerEnvelope),
        },
      },
    },
    options.signal,
  );
  return playerEnvelope.parse(parseResponseObject(response)).request;
}
/** Transport fixture only: deterministic actions are not evidence of actual model play. */
export function createMockPlayClient(): AIResponsesClient {
  return {
    respond: async (raw, signal) => {
      signal?.throwIfAborted();
      const body = raw as any;
      const data = JSON.parse(body.input[0].content[0].text);
      let value: unknown;
      switch (body.text.format.name) {
        case 'expansion_player':
          value = { request: { kind: 'ask', text: '今見えているものを教えて。' } };
          break;
        case 'core_intent':
          value = {
            decision: {
              kind: 'consult',
              evidenceSeq: data.conversation.eligibleEvidenceSeq,
              reason: 'mock observation request',
              answer: '見えている範囲を確かめている。',
            },
            inferences: [],
          };
          break;
        case 'knowledge_selection':
          value = { scope: 'overview', ids: [], ambienceSlotIds: [] };
          break;
        case 'investigation_reply':
          value = {
            answer:
              data.publicContext.initialOverview ||
              data.publicContext.situation ||
              '周囲を調べている。',
            inferences: [],
          };
          break;
        case 'harness_photo':
          value = {
            decision: 'clarify',
            usage: '',
            itemRefs: [],
            message: '届いた道具をどう使おう？',
            reason: 'mock ambiguous item',
          };
          break;
        case 'companion_reply':
          value = { reply: data.result.narrative };
          break;
        case 'game_result':
          value = {
            success: false,
            narrative: '試したが状況は変わらなかった。',
            situation: 'まだ突破していない。',
            inventoryChanges: [],
            factChanges: [],
            shortReason: 'mock unsuccessful action',
            creativity: {
              kind: 'ordinary',
              approach: 'Use the supplied tool on the current obstacle',
              equivalentAttemptId: null,
              effect: 'other',
            },
          };
          break;
        default:
          throw new Error('MOCK_ROLE_UNSUPPORTED');
      }
      return {
        model: body.model,
        status: 'completed',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
        ],
      };
    },
  };
}
