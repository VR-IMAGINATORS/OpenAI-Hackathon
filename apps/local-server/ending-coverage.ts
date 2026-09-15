import { z } from 'zod';
import type { EndingPacket } from './ending.js';
import type { EndingDesign } from './ending-ai.js';

export const itemCoverageSchema = z
  .object({
    itemId: z.string().min(1).max(200),
    actionId: z.string().min(1).max(200).nullable(),
    shot: z.number().int().min(1).max(12).nullable(),
    depiction: z.enum(['use', 'trace', 'presence', 'omitted']),
    reason: z.string().trim().min(1).max(200),
  })
  .strict();

/** Include early and consumed tools even if they no longer appear in the final inventory. */
export function endingItems(packet: EndingPacket) {
  const items = new Map<string, { id: string; name: string; status: string }>();
  for (const action of packet.actions) {
    for (const item of action.items)
      items.set(item.id, { id: item.id, name: item.name, status: item.afterStatus });
  }
  for (const item of packet.inventory)
    items.set(item.id, { id: item.id, name: item.name, status: item.status });
  return [...items.values()];
}

/** Validate the director's accounting, not whether a generated video actually depicts it. */
export function validateEndingCoverage(design: EndingDesign, packet: EndingPacket) {
  const items = endingItems(packet);
  const seen = new Set<string>();
  const uses: { order: number; shot: number }[] = [];
  const traces: { order: number; shot: number }[] = [];
  const shots = new Set(
    [...design.videoPrompt.matchAll(/\[Shot (\d+)\]/g)].map((m) => Number(m[1])),
  );
  const invalid = () => {
    throw new Error('ENDING_INVALID_ITEM_COVERAGE');
  };
  for (const row of design.itemCoverage) {
    const item = items.find((entry) => entry.id === row.itemId);
    const action = packet.actions.find((entry) => entry.actionId === row.actionId);
    if (!item || seen.has(row.itemId)) return invalid();
    seen.add(row.itemId);
    if (row.actionId !== null && !action?.items.some((entry) => entry.id === row.itemId))
      return invalid();
    if (row.depiction === 'omitted') {
      if (row.shot !== null) return invalid();
      continue;
    }
    if (row.shot === null || !shots.has(row.shot)) return invalid();
    if (row.depiction === 'use') {
      if (design.mode !== 'actions' || !action || !design.usedActionIds.includes(action.actionId))
        return invalid();
      uses.push({ order: action.order, shot: row.shot });
    } else if (row.depiction === 'trace') {
      if (!action) return invalid();
      traces.push({ order: action.order, shot: row.shot });
    } else if (
      row.actionId !== null ||
      item.status === 'consumed' ||
      packet.actions.some((entry) => entry.items.some((used) => used.id === row.itemId))
    ) {
      // A used tool needs its actual use or an explained trace, not a silent prop downgrade.
      return invalid();
    }
  }
  if (seen.size !== items.length) return invalid();
  uses.sort((a, b) => a.order - b.order);
  if (uses.some((use, i) => i > 0 && use.shot < uses[i - 1].shot)) return invalid();
  if (traces.some((trace) => uses.some((use) => trace.order >= use.order && trace.shot < use.shot)))
    return invalid();
}
