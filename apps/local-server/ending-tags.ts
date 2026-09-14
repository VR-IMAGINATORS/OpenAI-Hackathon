import { z } from 'zod';
import { endingTags, ENDING_TAG_CATALOG_VERSION } from '../../packages/shared/ending-tags.js';
import type { EndingStory } from '../../packages/shared/ending.js';
import type { EndingPacket } from './ending.js';

export const endingTagSchema = z
  .object({
    id: z.enum(endingTags.map((tag) => tag.id)),
    evidenceActionIds: z.array(z.string().min(1).max(200)).min(1).max(40),
    reason: z.string().min(1).max(400),
  })
  .strict()
  .nullable();

export const endingTagInstructions = `Choose one memorable primary tag from tagCatalog using ALL confirmed actions, not just the recent film actions. Return tag=null if no candidate has clear evidence, especially with no actions. Use only existing action IDs as evidence; images, unused uploads, scenario objects and player wishes are not proof of item use. A failed attempt can earn a tag, but never describe it as a success. Prefer strongly evidenced distinctive methods over broad object categories; on ties prefer contributions to progress, then catalog order. Treat criteria as required, especially all-item restrictions and repeated actions. Make story a playful, respectful 1-2 sentence result (about 40-80 Japanese characters, maximum 240 characters, or concise English), relating the selected tag to actual items, actions and the confirmed ending. Tease the approach, not the player's personality or ability. Do not append a new outcome. For no tag still summarize the confirmed ending.`;

export function validateEndingTag(
  tag: z.infer<typeof endingTagSchema>,
  packet: EndingPacket,
): void {
  if (!tag) return;
  const ids = new Set(tag.evidenceActionIds);
  const actions = packet.actions.filter((action) => ids.has(action.actionId));
  const used = packet.actions.filter((action) => action.items.length > 0);
  const itemIds = new Set(used.flatMap((action) => action.items.map((item) => item.id)));
  const invalid = () => {
    throw new Error('ENDING_INVALID_TAG_EVIDENCE');
  };
  if (ids.size !== tag.evidenceActionIds.length || actions.length !== ids.size) invalid();
  switch (tag.id) {
    case 'one_tool':
      if (itemIds.size !== 1 || used.length < 2 || actions.filter((a) => a.items.length).length < 2)
        invalid();
      break;
    case 'combination':
      if (!actions.some((a) => new Set(a.items.map((item) => item.id)).size >= 2)) invalid();
      break;
    case 'bare_hands':
      if (itemIds.size !== 0 || !actions.length) invalid();
      break;
    case 'verbal_override':
      if (!actions.some((a) => a.items.length === 0)) invalid();
      break;
    case 'brute_force':
      break;
    case 'tableware_only':
    case 'firearms_only':
      if (!used.length || !actions.some((a) => a.items.length)) invalid();
      break;
    case 'variety':
      if (new Set(actions.flatMap((a) => a.items.map((item) => item.id))).size < 3) invalid();
      break;
    case 'recycle':
      if (!actions.some((a) => a.items.some((item) => item.beforeStatus === 'damaged'))) invalid();
      break;
    case 'persistent_retry':
    case 'learning':
      if (
        !actions.some(
          (a) =>
            !a.success &&
            actions.some(
              (later) =>
                later.order > a.order &&
                later.obstacleId === a.obstacleId &&
                (tag.id !== 'learning' || later.cleared),
            ),
        )
      )
        invalid();
      break;
    default:
      if (!actions.some((a) => a.items.length)) invalid();
  }
}

export function publicEndingStory(design: {
  title: string;
  story: string;
  evaluation: string;
  tag: z.infer<typeof endingTagSchema>;
}): EndingStory {
  return {
    title: design.title,
    text: design.story,
    evaluation: design.evaluation,
    tagId: design.tag?.id ?? null,
    tagCatalogVersion: ENDING_TAG_CATALOG_VERSION,
  };
}
