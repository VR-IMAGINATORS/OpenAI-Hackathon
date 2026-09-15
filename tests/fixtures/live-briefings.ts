import assert from 'node:assert/strict';
import type { LiveCommand } from '../../packages/shared/game.js';

/** Reassemble only complete notifications; raw warning context is not a spoken briefing. */
export function liveBriefings(
  commands: LiveCommand[],
): { notificationId: string; facts: string }[] {
  const parts = new Map<string, Map<number, string>>();
  const totals = new Map<string, number>();
  const complete = new Set<string>();
  const result: { notificationId: string; facts: string }[] = [];
  for (const command of commands) {
    let value;
    try {
      value = JSON.parse(command.content);
    } catch {
      continue;
    }
    if (!value.notificationId) continue;
    const id = value.notificationId;
    if (value.part) {
      const buffer = parts.get(id) ?? new Map();
      buffer.set(value.part, value.facts);
      parts.set(id, buffer);
      totals.set(id, value.parts);
    }
    if (value.complete && command.type === 'session.commentary.append' && !complete.has(id)) {
      const buffer = parts.get(id);
      if (value.facts === undefined) assert.equal(buffer?.size, totals.get(id));
      const facts =
        value.facts ??
        Array.from({ length: totals.get(id)! }, (_, i) => buffer!.get(i + 1)).join('');
      result.push({ notificationId: id, facts });
      complete.add(id);
    }
  }
  return result;
}
