import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LiveOutbox, LiveOutboxError } from '../apps/local-server/live-outbox.js';
import { factCommand, speechCommands } from '../apps/local-server/live.js';

const error = (code: string) => (value: unknown) =>
  value instanceof LiveOutboxError && value.code === code;

test('outbox preserves correlated commands across lost polls and zero replay', () => {
  const box = new LiveOutbox(2, 3, () => 0);
  const messageId = randomUUID();
  const first = box.append(
    { ...factCommand('わかった、それでやってみる！', 'd1'), type: 'session.commentary.append' },
    messageId,
  );
  const second = box.append(factCommand('ロープが切れた。'));
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(first.messageId, messageId);
  const batch = box.poll(2, 3, 0);
  assert.deepEqual(box.poll(2, 3, 0), batch);
  assert.deepEqual(box.poll(2, 3, 1).commands, [second]);
  assert.deepEqual(box.poll(2, 3, 2).commands, []);
  assert.deepEqual(box.poll(2, 3, 0), { ...batch, acknowledgedThrough: 2 });
  assert.throws(() => box.poll(2, 3, 1), error('LIVE_ACK_REGRESSION'));
  assert.throws(() => box.poll(2, 3, 3), error('LIVE_ACK_INVALID'));
  assert.throws(() => box.poll(2, 3, NaN), error('LIVE_ACK_INVALID'));
});

test('duplicate notifications retain their sequence and reject altered content', () => {
  const box = new LiveOutbox(1, 0, () => 0);
  const command = factCommand('確定した結果');
  const first = box.append(command);
  assert.deepEqual(box.append(command), first);
  assert.equal(box.latestSeq, 1);
  assert.throws(
    () => box.append({ ...command, content: '違う結果' }),
    error('LIVE_COMMAND_CONFLICT'),
  );
  first.content = 'outside mutation';
  box.poll(1, 0, 0).commands[0].content = 'outside poll mutation';
  assert.equal(box.poll(1, 0, 0).commands[0].content, command.content);
});

test('a complete multipart notification retains its event IDs and one trigger across enqueue retries', () => {
  const box = new LiveOutbox(1, 0, () => 0);
  const facts = '確定した公開結果。'.repeat(70);
  const commands = speechCommands(facts, 'delegation', 'result-id');
  commands.forEach((c) => box.append(c));
  const before = box.poll(1, 0, 0);
  speechCommands(facts, 'delegation', 'result-id').forEach((c) => box.append(c));
  assert.deepEqual(box.poll(1, 0, 0), before);
  assert.equal(before.commands.filter((c) => c.type === 'session.commentary.append').length, 1);
  assert.equal(box.poll(1, 0, box.latestSeq).commands.length, 0);
});

test('connection reset discards old delivery and keeps the same connection idempotent', () => {
  const box = new LiveOutbox(1, 1, () => 0);
  box.append(factCommand('旧接続'));
  box.reset(1, 1);
  assert.equal(box.latestSeq, 1);
  box.reset(2, 1);
  assert.throws(() => box.poll(1, 1, 0), error('LIVE_CONNECTION_STALE'));
  assert.equal(box.append(factCommand('新接続')).seq, 1);
  box.reset(2, 2);
  assert.throws(() => box.poll(2, 1, 0), error('LIVE_CONNECTION_STALE'));
  assert.deepEqual(box.poll(2, 2, 0).commands, []);
  assert.throws(() => box.reset(1, 2), error('LIVE_CONNECTION_STALE'));
});

test('full history fails explicitly without losing reserved notifications', () => {
  const box = new LiveOutbox(1, 0, () => 0);
  for (let i = 0; i < 128; i++) box.append(factCommand('x'));
  const before = box.poll(1, 0, 128);
  assert.throws(() => box.append(factCommand('overflow')), error('LIVE_OUTBOX_FULL'));
  assert.deepEqual(box.poll(1, 0, 128), before);
  assert.equal(box.poll(1, 0, 0).commands.length, 128);
});

test('UTF-8 history bound applies before command count and content cannot exceed provider safety ceiling', () => {
  const box = new LiveOutbox(1, 0, () => 0);
  let count = 0;
  while (true) {
    try {
      box.append(factCommand('写'.repeat(160)));
      count++;
    } catch (err) {
      assert.ok(error('LIVE_OUTBOX_FULL')(err));
      break;
    }
  }
  assert.ok(count < 128);
  assert.equal(box.poll(1, 0, 0).commands.length, count);
  const empty = new LiveOutbox(1, 0, () => 0);
  assert.throws(
    () => empty.append({ ...factCommand(''), content: '写'.repeat(161) }),
    error('LIVE_COMMAND_INVALID'),
  );
  assert.equal(empty.latestSeq, 0);
  assert.equal(Buffer.byteLength(empty.append(factCommand('写'.repeat(161))).content), 480);
});
