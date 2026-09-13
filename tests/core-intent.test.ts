import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationLedger } from '../apps/local-server/conversation.js';
import { IntentCoordinator } from '../apps/local-server/intent-coordinator.js';
import type { IntentDecision } from '../packages/shared/conversation.js';

const photoId = '4d8fcff6-98db-4fcb-a451-349b92e62861';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function setup(
  classify?: (
    c: ReturnType<ConversationLedger['captureUnconsumedContext']>,
  ) => Promise<IntentDecision>,
  execute?: () => Promise<void>,
) {
  let time = 1000,
    calls = 0;
  const ledger = new ConversationLedger({ generation: 1, now: () => time });
  const coordinator = new IntentCoordinator({
    ledger,
    now: () => time,
    classify:
      classify ??
      (async (c) => ({
        kind: 'execute',
        evidenceSeq: c.eligibleEvidenceSeq,
        itemRefs: [{ photoId }],
        usage: 'cut',
        reason: 'directive',
      })),
    execute: async () => {
      calls++;
      await execute?.();
    },
  });
  let event = 0;
  const input = (
    delta = 'cut',
    startMs = 100,
    endMs = 200,
    speaker: 'user' | 'assistant' = 'user',
  ) => {
    const f = ledger.append({
      eventId: `e${++event}`,
      generation: 1,
      speaker,
      delta,
      startMs,
      endMs,
    });
    coordinator.onContextChanged();
    return f!;
  };
  const delegate = (id = 'd') => coordinator.acceptDelegation({ id, generation: 1, offsetMs: 200 });
  return {
    ledger,
    coordinator,
    input,
    delegate,
    calls: () => calls,
    setTime: (n: number) => (time = n),
  };
}

test('ledger preserves original speakers, rejects invalid times/generation and deduplicates', () => {
  const s = setup();
  const f = s.input('原文');
  const version = s.ledger.contextVersion;
  s.input('返事', 100, 200, 'assistant');
  assert.equal(s.ledger.contextVersion, version);
  assert.equal(
    s.ledger.append({
      eventId: f.eventId,
      generation: 1,
      speaker: 'user',
      delta: '原文',
      startMs: 100,
      endMs: 200,
    }),
    null,
  );
  assert.throws(() =>
    s.ledger.append({
      eventId: 'bad',
      generation: 1,
      speaker: 'user',
      delta: 'x',
      startMs: 5,
      endMs: 2,
    }),
  );
  assert.throws(() =>
    s.ledger.append({
      eventId: 'old',
      generation: 2,
      speaker: 'user',
      delta: 'x',
      startMs: 0,
      endMs: 1,
    }),
  );
  assert.deepEqual(
    s.ledger.captureUnconsumedContext().fragments.map((f) => f.delta),
    ['原文', '返事'],
  );
  assert.deepEqual(s.ledger.captureUnconsumedContext().eligibleEvidenceSeq, [1]);
});

test('consulted evidence cannot be reused by another delegation', async () => {
  const s = setup(async (c) => ({
    kind: 'consult',
    evidenceSeq: c.eligibleEvidenceSeq,
    reason: 'question',
  }));
  s.input();
  s.delegate();
  await s.coordinator.settled();
  s.delegate('other');
  await s.coordinator.settled();
  assert.equal(s.calls(), 0);
  assert.deepEqual(s.ledger.captureUnconsumedContext().eligibleEvidenceSeq, []);
});

test('correction while classification is running forces re-evaluation, never old execution', async () => {
  const first = deferred<IntentDecision>();
  let classifiers = 0;
  const s = setup(async (c) =>
    ++classifiers === 1
      ? first.promise
      : { kind: 'consult', evidenceSeq: c.eligibleEvidenceSeq, reason: 'cancelled' },
  );
  s.input();
  s.delegate();
  await Promise.resolve();
  s.input('do not cut', 201, 300);
  first.resolve({
    kind: 'execute',
    evidenceSeq: [1],
    itemRefs: [{ photoId }],
    usage: 'cut',
    reason: 'old',
  });
  await s.coordinator.settled();
  assert.equal(classifiers, 2);
  assert.equal(s.calls(), 0);
});

test('judging speech and delayed ambiguous speech never execute, failed action never replays', async () => {
  const judgment = deferred<void>();
  const s = setup(undefined, () => judgment.promise);
  s.input();
  s.delegate();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(s.calls(), 1);
  s.setTime(1200);
  assert.equal(s.input('again', 201, 300).executionEligible, false);
  s.delegate('during');
  s.setTime(2000);
  judgment.resolve();
  await s.coordinator.settled();
  assert.equal(s.input('late', 301, 500).executionEligible, false);
  s.delegate('late');
  await s.coordinator.settled();
  assert.equal(s.calls(), 1);
  assert.equal(s.coordinator.snapshot().find((d) => d.id === 'during')?.status, 'expired');
  s.input('new instruction', 2000, 2200);
  s.delegate('fresh');
  await s.coordinator.settled();
  assert.equal(s.calls(), 2);
});

test('classifier cannot cite assistant, invented or consumed evidence', async () => {
  const s = setup(async () => ({
    kind: 'execute',
    evidenceSeq: [2],
    itemRefs: [{ photoId }],
    usage: 'cut',
    reason: 'invalid',
  }));
  s.input();
  s.input('cut', 100, 200, 'assistant');
  s.delegate();
  await s.coordinator.settled();
  assert.equal(s.calls(), 0);
});

test('delegation limits and deadline prevent late classification from reserving', async () => {
  const d = deferred<IntentDecision>();
  const s = setup(() => d.promise);
  s.input();
  s.delegate();
  await Promise.resolve();
  s.delegate('2');
  s.delegate('3');
  s.delegate('4');
  assert.throws(() => s.delegate('5'), /DELEGATION_LIMIT/);
  s.setTime(21000);
  d.resolve({
    kind: 'execute',
    evidenceSeq: [1],
    itemRefs: [{ photoId }],
    usage: 'cut',
    reason: 'late',
  });
  await s.coordinator.settled();
  assert.equal(s.calls(), 0);
});

test('reset/control changes and stop invalidate in-flight classification', async () => {
  const d = deferred<IntentDecision>();
  const s = setup(() => d.promise);
  s.input();
  s.delegate();
  await Promise.resolve();
  s.ledger.updateState({ controllerEpoch: 1 });
  s.coordinator.reset();
  d.resolve({
    kind: 'execute',
    evidenceSeq: [1],
    itemRefs: [{ photoId }],
    usage: 'cut',
    reason: 'old owner',
  });
  await s.coordinator.settled();
  assert.equal(s.calls(), 0);
  s.coordinator.stop();
  s.ledger.stop();
  assert.deepEqual(s.ledger.captureUnconsumedContext().fragments, []);
});

test('one worker and at most three classifications per delegation', async () => {
  let classified = 0;
  const s = setup(async () => {
    classified++;
    return { kind: 'wait', reason: 'incomplete' };
  });
  s.input();
  s.delegate();
  await s.coordinator.settled();
  for (let i = 0; i < 5; i++) {
    s.input('more', 300 + i, 301 + i);
    await s.coordinator.settled();
  }
  assert.equal(classified, 3);
  assert.equal(s.calls(), 0);
});

test('UTF-8 ledger limit is enforced and generation reset removes old evidence', () => {
  const s = setup();
  for (let i = 0; i < 16; i++) s.input('a'.repeat(4000));
  assert.throws(() => s.input('a'.repeat(4000)), /CONVERSATION_LIMIT/);
  s.ledger.updateState({ generation: 2 });
  assert.deepEqual(s.ledger.captureUnconsumedContext().fragments, []);
});

test('failed execution consumes its evidence and duplicates never retry it', async () => {
  const s = setup(undefined, async () => {
    throw new Error('upstream unavailable');
  });
  s.input();
  s.delegate();
  await s.coordinator.settled();
  assert.equal(s.calls(), 1);
  assert.deepEqual(s.delegate(), { accepted: false, duplicate: true });
  s.delegate('second');
  await s.coordinator.settled();
  assert.equal(s.calls(), 1);
  assert.deepEqual(s.ledger.captureUnconsumedContext().eligibleEvidenceSeq, []);
});

test('photo context changes invalidate a classification and reservation retains the context version', async () => {
  const pending = deferred<IntentDecision>();
  let count = 0;
  const ledger = new ConversationLedger({ generation: 1 });
  let reserved = false;
  const coordinator = new IntentCoordinator({
    ledger,
    classify: async (c) =>
      ++count === 1
        ? pending.promise
        : {
            kind: 'execute',
            evidenceSeq: c.eligibleEvidenceSeq,
            itemRefs: [{ photoId }],
            usage: 'cut',
            reason: 'current',
          },
    execute: async (_intent, context) => {
      assert.equal(context.contextVersion, ledger.contextVersion);
      reserved = true;
    },
  });
  ledger.append({
    eventId: 'x',
    generation: 1,
    speaker: 'user',
    delta: 'cut',
    startMs: 100,
    endMs: 200,
  });
  coordinator.acceptDelegation({ id: 'd', generation: 1, offsetMs: 200 });
  await Promise.resolve();
  ledger.contextChanged();
  coordinator.onContextChanged();
  pending.resolve({
    kind: 'execute',
    evidenceSeq: [1],
    itemRefs: [{ photoId }],
    usage: 'cut',
    reason: 'old',
  });
  await coordinator.settled();
  assert.equal(count, 2);
  assert.equal(reserved, true);
});
