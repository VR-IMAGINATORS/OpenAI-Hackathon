import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  CoreLiveProbe,
  type ProbeContext,
  type ProbeDecision,
} from '../apps/local-server/core-live-probe.js';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const execute = (c: ProbeContext): ProbeDecision => ({
  kind: 'execute',
  evidenceSeq: c.eligibleEvidenceSeq,
  itemRefs: ['photo-1'],
  usage: 'cut the rope',
  reason: 'explicit instruction',
});
const transcript = (
  p: CoreLiveProbe,
  text = 'Cut the rope.',
  eventId = 'u1',
  startMs = 1,
  endMs = 100,
) => p.acceptTranscript({ eventId, generation: 1, speaker: 'user', delta: text, startMs, endMs });
const delegate = (p: CoreLiveProbe, id = 'd1') =>
  p.acceptDelegation({ id, generation: 1, offsetMs: 100 });
const judge = async () => ({ success: true, reason: 'rope cut' });

test('24 human Live fixture scripts cover 6 categories twice in each locale', () => {
  const fixtures = JSON.parse(
    readFileSync(new URL('./fixtures/core-conversations.json', import.meta.url), 'utf8'),
  );
  assert.equal(fixtures.length, 24);
  for (const locale of ['ja', 'en'])
    for (const category of ['execute', 'consult', 'delegate', 'pause', 'correction', 'late'])
      assert.equal(
        fixtures.filter((f: any) => f.locale === locale && f.category === category).length,
        2,
      );
});

test('delegation alone and transcript alone never execute', async () => {
  let calls = 0;
  const p = new CoreLiveProbe({
    locale: 'en',
    classify: async (c) => {
      calls++;
      return execute(c);
    },
    judge,
  });
  delegate(p);
  await p.settled();
  assert.equal(calls, 0);
  const q = new CoreLiveProbe({ locale: 'en', classify: async (c) => execute(c), judge });
  transcript(q);
  await q.settled();
  assert.equal(q.snapshot().actions.length, 0);
});

test('nonblocking receipt accepts correction during inference and rejects stale execute', async () => {
  const first = deferred<ProbeDecision>();
  let calls = 0;
  const p = new CoreLiveProbe({
    locale: 'en',
    classify: async (c) =>
      ++calls === 1
        ? first.promise
        : { kind: 'consult', evidenceSeq: c.eligibleEvidenceSeq, reason: 'corrected to question' },
    judge,
  });
  transcript(p);
  delegate(p);
  await Promise.resolve();
  assert.equal(transcript(p, 'Actually, could it work?', 'u2', 101, 200).accepted, true);
  first.resolve({
    kind: 'execute',
    evidenceSeq: [1],
    itemRefs: ['photo-1'],
    usage: 'cut',
    reason: 'stale',
  });
  await p.settled();
  assert.equal(calls, 2);
  assert.equal(p.snapshot().actions.length, 0);
});

test('duplicate events and different delegations cannot execute consumed evidence twice', async () => {
  const p = new CoreLiveProbe({ locale: 'en', classify: async (c) => execute(c), judge });
  transcript(p);
  delegate(p);
  assert.equal(delegate(p).duplicate, true);
  assert.equal(transcript(p).duplicate, true);
  delegate(p, 'd2');
  await p.settled();
  delegate(p, 'd3');
  await p.settled();
  assert.equal(p.snapshot().actions.filter((a) => a.status === 'committed').length, 1);
});

test('consultation is handled and cannot be reused by another delegation', async () => {
  let calls = 0;
  const p = new CoreLiveProbe({
    locale: 'ja',
    classify: async (c) => {
      calls++;
      return { kind: 'consult', evidenceSeq: c.eligibleEvidenceSeq, reason: 'question' };
    },
    judge,
  });
  transcript(p, '切れるかな？');
  delegate(p);
  await p.settled();
  delegate(p, 'd2');
  await p.settled();
  assert.equal(calls, 1);
  assert.equal(p.snapshot().actions.length, 0);
});

test('late transcript after delegation is evaluated, without a quiet-time trigger', async () => {
  const p = new CoreLiveProbe({ locale: 'en', classify: async (c) => execute(c), judge });
  delegate(p);
  await p.settled();
  transcript(p);
  await p.settled();
  assert.equal(p.snapshot().actions.length, 1);
});

test('unfinished utterance waits; later delta causes reevaluation with same delegation', async () => {
  const p = new CoreLiveProbe({
    locale: 'en',
    classify: async (c) =>
      c.fragments.length === 1 ? { kind: 'wait', reason: 'unfinished' } : execute(c),
    judge,
  });
  transcript(p, 'Use these to');
  delegate(p);
  await p.settled();
  assert.equal(p.snapshot().actions.length, 0);
  transcript(p, 'cut the rope.', 'u2', 101, 200);
  await p.settled();
  assert.equal(p.snapshot().actions.length, 1);
});

test('invented evidence, assistant evidence and unavailable photos never reserve', async () => {
  for (const bad of [0, 99, 2]) {
    const p = new CoreLiveProbe({
      locale: 'en',
      classify: async () => ({
        kind: 'execute',
        evidenceSeq: [bad],
        itemRefs: ['photo-1'],
        usage: 'cut',
        reason: 'invalid',
      }),
      judge,
    });
    transcript(p);
    p.acceptTranscript({
      eventId: 'a',
      generation: 1,
      speaker: 'assistant',
      delta: 'I will cut it.',
      startMs: 100,
      endMs: 200,
    });
    delegate(p);
    await p.settled();
    assert.equal(p.snapshot().actions.length, 0);
  }
  const p = new CoreLiveProbe({
    locale: 'en',
    classify: async (c) => ({
      ...execute(c),
      kind: 'execute',
      evidenceSeq: [1],
      itemRefs: ['magic-tool'],
      usage: 'magic',
      reason: 'invalid',
    }),
    judge,
  });
  transcript(p);
  delegate(p);
  await p.settled();
  assert.equal(p.snapshot().actions.length, 0);
});

test('judging input and known late judging audio never queue another action', async () => {
  const pending = deferred<{ success: boolean; reason: string }>();
  const p = new CoreLiveProbe({
    locale: 'en',
    classify: async (c) => execute(c),
    judge: () => pending.promise,
  });
  transcript(p);
  delegate(p);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(p.snapshot().judging, true);
  transcript(p, 'Now open it.', 'u2', 110, 200);
  delegate(p, 'd2');
  pending.resolve({ success: true, reason: 'done' });
  await p.settled();
  transcript(p, 'Open it!', 'u3', 150, 210);
  delegate(p, 'd3');
  await p.settled();
  assert.equal(p.snapshot().fragments[1].executionEligible, false);
  assert.equal(p.snapshot().fragments[2].executionEligible, false);
  assert.equal(p.snapshot().actions.length, 1);
});

test('technical failure spends no action and same evidence cannot retry', async () => {
  const p = new CoreLiveProbe({
    locale: 'en',
    classify: async (c) => execute(c),
    judge: async () => {
      throw new Error('transport');
    },
  });
  transcript(p);
  delegate(p);
  await p.settled();
  delegate(p, 'd2');
  await p.settled();
  assert.equal(p.snapshot().gameVersion, 0);
  assert.deepEqual(
    p.snapshot().actions.map((a) => a.status),
    ['failed'],
  );
});

test('deadline expiration and stopping during classifier prevent commit', async () => {
  let now = 0;
  const pending = deferred<ProbeDecision>();
  const p = new CoreLiveProbe({
    locale: 'en',
    now: () => now,
    classify: () => pending.promise,
    judge,
  });
  transcript(p);
  delegate(p);
  await Promise.resolve();
  now = 20_000;
  pending.resolve({
    kind: 'execute',
    evidenceSeq: [1],
    itemRefs: ['photo-1'],
    usage: 'cut',
    reason: 'late',
  });
  await p.settled();
  assert.equal(p.snapshot().actions.length, 0);
  const q = new CoreLiveProbe({
    locale: 'en',
    classify: async (c) => {
      q.stop();
      return execute(c);
    },
    judge,
  });
  transcript(q);
  delegate(q);
  await q.settled();
  assert.equal(q.snapshot().actions.length, 0);
});

test('assistant acknowledgement does not invalidate pending classification', async () => {
  const pending = deferred<ProbeDecision>();
  const p = new CoreLiveProbe({ locale: 'en', classify: () => pending.promise, judge });
  transcript(p);
  delegate(p);
  await Promise.resolve();
  p.acceptTranscript({
    eventId: 'a',
    generation: 1,
    speaker: 'assistant',
    delta: 'Okay',
    startMs: 101,
    endMs: 200,
  });
  pending.resolve({
    kind: 'execute',
    evidenceSeq: [1],
    itemRefs: ['photo-1'],
    usage: 'cut',
    reason: 'instruction',
  });
  await p.settled();
  assert.equal(p.snapshot().actions.length, 1);
});

test('classification budget is at most three calls per delegation', async () => {
  let calls = 0;
  const p = new CoreLiveProbe({
    locale: 'en',
    classify: async () => {
      calls++;
      return { kind: 'wait', reason: 'incomplete' };
    },
    judge,
  });
  transcript(p, 'Use');
  delegate(p);
  await p.settled();
  for (let i = 2; i <= 6; i++) {
    transcript(p, '…', `u${i}`, i * 101, i * 101 + 50);
    await p.settled();
  }
  assert.equal(calls, 3);
  assert.equal(p.snapshot().actions.length, 0);
});

test('unreferenced old-state fragments cannot become a second action', async () => {
  const p = new CoreLiveProbe({
    locale: 'en',
    classify: async (c) => ({
      kind: 'execute',
      evidenceSeq: [c.eligibleEvidenceSeq[0]],
      itemRefs: ['photo-1'],
      usage: 'cut',
      reason: 'instruction',
    }),
    judge,
  });
  transcript(p, 'Cut', 'u1', 1, 100);
  transcript(p, 'the rope', 'u2', 101, 200);
  delegate(p);
  await p.settled();
  delegate(p, 'd2');
  await p.settled();
  assert.equal(p.snapshot().actions.length, 1);
});

test('pending delegation and transcript byte limits reject before storage', async () => {
  const p = new CoreLiveProbe({
    locale: 'en',
    classify: async () => ({ kind: 'wait', reason: 'wait' }),
    judge,
  });
  for (let i = 0; i < 4; i++) delegate(p, `d${i}`);
  assert.throws(() => delegate(p, 'overflow'), /PROBE_LIMIT/);
  assert.throws(() => transcript(p, 'x'.repeat(65537)), /PROBE_LIMIT/);
  assert.equal(p.snapshot().fragments.length, 0);
});

test('stop during judging invalidates result without spending an action', async () => {
  const pending = deferred<{ success: boolean; reason: string }>();
  const p = new CoreLiveProbe({
    locale: 'en',
    classify: async (c) => execute(c),
    judge: () => pending.promise,
  });
  transcript(p);
  delegate(p);
  await Promise.resolve();
  await Promise.resolve();
  p.stop();
  pending.resolve({ success: true, reason: 'too late' });
  await p.settled();
  assert.equal(p.snapshot().gameVersion, 0);
  assert.equal(p.snapshot().actions[0].status, 'failed');
});

test('whitespace deltas are preserved exactly but are not instruction evidence alone', async () => {
  let calls = 0;
  const p = new CoreLiveProbe({
    locale: 'en',
    classify: async (c) => {
      calls++;
      return execute(c);
    },
    judge,
  });
  transcript(p, '  \n', 'space', 1, 2);
  delegate(p);
  await p.settled();
  assert.equal(p.snapshot().fragments[0].delta, '  \n');
  assert.equal(calls, 0);
  transcript(p, 'Cut the rope.', 'words', 3, 100);
  await p.settled();
  assert.equal(p.snapshot().actions.length, 1);
});

test('expired delegation cannot run on a transcript arriving after its deadline', async () => {
  let now = 0;
  let calls = 0;
  const p = new CoreLiveProbe({
    locale: 'en',
    now: () => now,
    classify: async (c) => {
      calls++;
      return execute(c);
    },
    judge,
  });
  delegate(p);
  await p.settled();
  now = 20_001;
  transcript(p);
  await p.settled();
  assert.equal(calls, 0);
  assert.equal(p.snapshot().delegations[0].status, 'expired');
  assert.throws(
    () => p.acceptDelegation({ id: 'bad', generation: 2, offsetMs: 0 }),
    /PROBE_INACTIVE/,
  );
  assert.throws(
    () =>
      p.acceptTranscript({
        eventId: 'bad',
        generation: 2,
        speaker: 'user',
        delta: 'cut',
        startMs: 1,
        endMs: 2,
      }),
    /PROBE_INACTIVE/,
  );
  p.stop();
  assert.throws(() => transcript(p, 'Cut', 'after', 101, 200), /PROBE_INACTIVE/);
});
