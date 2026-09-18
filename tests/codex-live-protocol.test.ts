import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexLiveProtocol } from '../apps/web/src/codex-live-protocol.js';
import { liveEventSchema } from '../apps/local-server/live.js';
import type { LiveCommand } from '../packages/shared/game.js';

const command = (
  type: LiveCommand['type'],
  content: string,
  delegation_id: string | null = null,
): LiveCommand => ({ type, content, delegation_id, event_id: 'game-event' });

test('Codex sends mid-game reminders as context without updating immutable instructions', () => {
  const adapter = new CodexLiveProtocol();
  assert.deepEqual(
    adapter.encode([
      command('session.instructions.append', 'first'),
      command('session.instructions.append', 'second'),
    ]),
    [
      { type: 'session.context.append', content: [{ type: 'input_text', text: 'first' }] },
      { type: 'session.context.append', content: [{ type: 'input_text', text: 'second' }] },
    ],
  );
  assert.deepEqual(
    adapter.encode([
      command('session.thinking.append', 'facts'),
      command('session.commentary.append', 'result', 'delegation-1'),
    ]),
    [
      { type: 'session.context.append', content: [{ type: 'input_text', text: 'facts' }] },
      {
        type: 'delegation.context.append',
        delegation_item_id: 'delegation-1',
        channel: 'commentary',
        content: [{ type: 'input_text', text: 'result' }],
      },
    ],
  );
});

test('Codex transcripts and delegation normalize to game schema without repeating transcript', () => {
  const adapter = new CodexLiveProtocol();
  const input = {
    type: 'input_transcript.added',
    event_id: 'e1',
    item: { id: 'i1', text: 'Use scissors' },
  };
  const normalized = adapter.decode(input);
  assert.equal(normalized.length, 1);
  assert.equal(liveEventSchema.parse(normalized[0]).type, 'session.input_transcript.delta');
  assert.deepEqual(adapter.decode(input), []);
  const delegation = {
    type: 'delegation.created',
    item: {
      id: 'd1',
      type: 'delegation',
      target: 'client',
      content: [{ type: 'input_text', text: 'Use scissors' }],
    },
  };
  const events = adapter.decode(delegation);
  assert.equal(events.length, 1);
  assert.equal(liveEventSchema.parse(events[0]).type, 'session.delegation.created');
  assert.deepEqual(adapter.decode(delegation), []);
  const response = adapter.encode([command('session.commentary.append', 'Done', 'd1')]);
  assert.equal(response[0].delegation_item_id, 'd1');
  const fresh = new CodexLiveProtocol().decode(delegation);
  assert.equal(fresh.length, 2);
  fresh.forEach((e) => liveEventSchema.parse(e));
});
