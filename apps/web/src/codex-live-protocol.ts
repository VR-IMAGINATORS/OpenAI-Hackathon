import type { LiveCommand } from '../../../packages/shared/game.js';

/** Codex frameless-bidi wire format. Public API Live commands remain unchanged. */
export class CodexLiveProtocol {
  private origin = performance.now();
  private userSinceDelegation = false;
  private seen = new Set<string>();

  encode(commands: LiveCommand[]): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    for (const command of commands) {
      // Mid-game reminders are context, never an update to immutable instructions.
      result.push({
        type: command.delegation_id ? 'delegation.context.append' : 'session.context.append',
        ...(command.delegation_id ? { delegation_item_id: command.delegation_id } : {}),
        ...(command.type === 'session.commentary.append' ? { channel: 'commentary' } : {}),
        content: [{ type: 'input_text', text: command.content }],
      });
    }
    return result;
  }

  decode(event: Record<string, unknown>): Record<string, unknown>[] {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== 'object') return [];
    const key =
      typeof event.event_id === 'string'
        ? event.event_id
        : typeof item.id === 'string'
          ? `${event.type}:${item.id}`
          : undefined;
    if (key && this.seen.has(key)) return [];
    const remember = () => {
      if (key) {
        if (this.seen.size >= 10000) this.seen.delete(this.seen.values().next().value!);
        this.seen.add(key);
      }
    };
    // This transport supplies text items, not audio offsets. Use monotonic receipt
    // offsets consistently for both transcript and delegation ordering.
    const offset = Math.max(0, Math.round(performance.now() - this.origin));
    const transcript = (text: string, input: boolean, id: string) => ({
      type: input ? 'session.input_transcript.delta' : 'session.output_transcript.delta',
      event_id: id,
      delta: text,
      start_ms: offset,
      end_ms: offset,
    });
    if (event.type === 'input_transcript.added' || event.type === 'output_transcript.added') {
      if (typeof item.text !== 'string' || item.text.length > 4000) return [];
      remember();
      const input = event.type === 'input_transcript.added';
      if (input) this.userSinceDelegation = true;
      return [transcript(item.text, input, crypto.randomUUID())];
    }
    if (
      event.type !== 'delegation.created' ||
      item.type !== 'delegation' ||
      item.target !== 'client' ||
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 200
    )
      return [];
    remember();
    const result: Record<string, unknown>[] = [];
    const text = Array.isArray(item.content)
      ? item.content
          .filter((c) => c?.type === 'input_text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('')
      : '';
    if (!this.userSinceDelegation && text && text.length <= 4000)
      result.push(transcript(text, true, crypto.randomUUID()));
    this.userSinceDelegation = false;
    result.push({
      type: 'session.delegation.created',
      event_id: crypto.randomUUID(),
      offset_ms: offset,
      delegation: { id: item.id, type: 'delegation', target: 'client' },
    });
    return result;
  }
}
