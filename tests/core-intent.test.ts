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
  canClassify?: () => boolean,
) {
  let time = 1000,
    calls = 0;
  const ledger = new ConversationLedger({ generation: 1, now: () => time });
  const coordinator = new IntentCoordinator({
    ledger,
    now: () => time,
    canClassify,
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

test('photo processing preserves fragmented instructions without spending classification attempts or the deadline', async () => {
  let ready = false;
  let classified = 0;
  const s = setup(
    async (context) => {
      classified++;
      assert.equal(context.fragments.map((f) => f.delta).join(''), 'ハサミで切って');
      return {
        kind: 'execute',
        evidenceSeq: context.eligibleEvidenceSeq,
        itemRefs: [{ photoId }],
        usage: 'cut',
        reason: 'complete direction after the photo',
      };
    },
    undefined,
    () => ready,
  );
  s.input('ハサミ');
  s.delegate();
  await s.coordinator.settled();
  for (const [index, fragment] of ['で', '切', 'って'].entries()) {
    s.setTime(2_000 + index * 10_000);
    s.input(fragment, 300 + index, 301 + index);
    s.coordinator.tick();
    await s.coordinator.settled();
  }
  s.setTime(35_000);
  s.coordinator.tick();
  await s.coordinator.settled();
  assert.equal(classified, 0);
  assert.equal(s.coordinator.snapshot()[0]?.attempts, 0);
  assert.equal(s.coordinator.snapshot()[0]?.status, 'pending');
  assert.equal(s.ledger.captureUnconsumedContext().eligibleEvidenceSeq.length, 4);
  ready = true;
  s.coordinator.onContextChanged();
  await s.coordinator.settled();
  assert.equal(classified, 1);
  assert.equal(s.calls(), 1);
  assert.equal(s.coordinator.snapshot()[0]?.deadline, 55_000);
  s.delegate('duplicate-direction');
  await s.coordinator.settled();
  assert.equal(s.calls(), 1);
});

test('a deferred delegation still expires after its available processing time', async () => {
  let ready = false;
  const s = setup(
    async () => ({ kind: 'wait', reason: 'unfinished' }),
    undefined,
    () => ready,
  );
  s.input('ハサミで');
  s.delegate();
  await s.coordinator.settled();
  s.setTime(31_000);
  ready = true;
  s.coordinator.tick();
  await s.coordinator.settled();
  assert.equal(s.coordinator.snapshot()[0]?.status, 'pending');
  s.setTime(51_000);
  s.coordinator.tick();
  await s.coordinator.settled();
  assert.equal(s.coordinator.snapshot()[0]?.status, 'expired');
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

function watchdog(
  classify?: (
    context: ReturnType<ConversationLedger['captureUnconsumedContext']>,
  ) => Promise<IntentDecision>,
) {
  let time = 0,
    executions = 0,
    classifications = 0;
  const expired: string[] = [],
    recovered: string[] = [],
    failed: number[] = [];
  const ledger = new ConversationLedger({ generation: 1, now: () => time });
  const coordinator = new IntentCoordinator({
    ledger,
    now: () => time,
    classify: async (context) => {
      classifications++;
      return classify
        ? classify(context)
        : {
            kind: 'execute',
            evidenceSeq: context.eligibleEvidenceSeq,
            itemRefs: [{ photoId }],
            usage: 'cut',
            reason: 'directive',
          };
    },
    execute: async () => {
      executions++;
    },
    onExpired: (d) => {
      expired.push(d.id);
    },
    onMissingDelegation: (d) => {
      recovered.push(d.kind);
    },
    onRecoveryExpired: (c) => {
      failed.push(c.contextVersion);
    },
  });
  let event = 0;
  const input = (delta = 'cut') => {
    ledger.append({
      eventId: `watch-${++event}`,
      generation: 1,
      speaker: 'user',
      delta,
      startMs: event * 100,
      endMs: event * 100 + 50,
    });
    coordinator.onContextChanged();
  };
  const tick = async (at: number) => {
    time = at;
    coordinator.tick();
    await coordinator.settled();
  };
  return {
    ledger,
    coordinator,
    input,
    tick,
    expired,
    recovered,
    failed,
    executions: () => executions,
    classifications: () => classifications,
    setTime: (at: number) => {
      time = at;
    },
  };
}

test('missed delegation is read-only, once per context, and expires without another event', async () => {
  const s = watchdog();
  s.input();
  await s.tick(2999);
  assert.equal(s.classifications(), 0);
  await s.tick(3000);
  assert.deepEqual(s.recovered, ['execute']);
  assert.equal(s.executions(), 0);
  assert.deepEqual(s.ledger.captureUnconsumedContext().eligibleEvidenceSeq, [1]);
  await s.tick(22000);
  assert.equal(s.classifications(), 1);
  await s.tick(23000);
  await s.tick(30000);
  assert.equal(s.failed.length, 1);
  s.coordinator.acceptDelegation({ id: 'real', generation: 1, offsetMs: 150 });
  await s.coordinator.settled();
  assert.equal(s.executions(), 0);
  s.input('repeat cut');
  await s.coordinator.settled();
  assert.equal(s.executions(), 1);
  await s.tick(60000);
  assert.equal(s.failed.length, 1);
});

test('read-only consultation and unfinished speech never execute or report a stalled action', async () => {
  for (const kind of ['consult', 'wait'] as const) {
    const s = watchdog(async (c) =>
      kind === 'wait'
        ? { kind, reason: 'unfinished' }
        : { kind, reason: 'question', evidenceSeq: c.eligibleEvidenceSeq },
    );
    s.input();
    await s.tick(3000);
    await s.tick(40000);
    assert.deepEqual(s.recovered, [kind]);
    assert.equal(s.executions(), 0);
    assert.deepEqual(s.failed, []);
    assert.deepEqual(s.ledger.captureUnconsumedContext().eligibleEvidenceSeq, [1]);
  }
});

test('heartbeat expires a real delegation once even without any new Live event', async () => {
  const s = watchdog(async () => ({ kind: 'wait', reason: 'unfinished' }));
  s.input();
  s.coordinator.acceptDelegation({ id: 'real', generation: 1, offsetMs: 150 });
  await s.coordinator.settled();
  await s.tick(20000);
  await s.tick(21000);
  assert.deepEqual(s.expired, ['real']);
  assert.equal(s.executions(), 0);
});

test('new context recovery is rate limited and cancels the previous recovery notice', async () => {
  const s = watchdog();
  s.input();
  await s.tick(3000);
  s.setTime(4000);
  s.input('do not cut');
  await s.tick(7000);
  assert.equal(s.classifications(), 1);
  await s.tick(13000);
  assert.equal(s.classifications(), 2);
  s.coordinator.reset();
  await s.tick(40000);
  assert.deepEqual(s.failed, []);
  assert.equal(s.classifications(), 2);
});

test('real delegation arriving during recovery shares the worker and invalidates late recovery', async () => {
  const pending = deferred<IntentDecision>();
  let count = 0;
  const s = watchdog(async (c) =>
    ++count === 1
      ? pending.promise
      : { kind: 'consult', evidenceSeq: c.eligibleEvidenceSeq, reason: 'question' },
  );
  s.input();
  s.setTime(3000);
  s.coordinator.tick();
  await Promise.resolve();
  s.coordinator.acceptDelegation({ id: 'real', generation: 1, offsetMs: 150 });
  assert.equal(s.classifications(), 1);
  pending.resolve({
    kind: 'execute',
    evidenceSeq: [1],
    itemRefs: [{ photoId }],
    usage: 'cut',
    reason: 'old',
  });
  await s.coordinator.settled();
  assert.equal(s.classifications(), 2);
  assert.deepEqual(s.recovered, []);
  assert.equal(s.executions(), 0);
});

test('recovery discards late classification after correction, control transfer, reset or stop', async () => {
  for (const change of ['correction', 'controller', 'generation', 'reset', 'stop']) {
    const pending = deferred<IntentDecision>();
    const s = watchdog(() => pending.promise);
    s.input();
    s.setTime(3000);
    s.coordinator.tick();
    await Promise.resolve();
    if (change === 'correction') s.input('do not cut');
    if (change === 'controller') s.ledger.updateState({ controllerEpoch: 1 });
    if (change === 'generation') s.ledger.updateState({ generation: 2 });
    if (change === 'reset') s.coordinator.reset();
    if (change === 'stop') s.coordinator.stop();
    pending.resolve({
      kind: 'execute',
      evidenceSeq: [1],
      itemRefs: [{ photoId }],
      usage: 'cut',
      reason: 'old',
    });
    await s.coordinator.settled();
    assert.deepEqual(s.recovered, []);
    assert.equal(s.executions(), 0);
  }
});

test('heartbeat can expire an in-flight real classification and discard its late execute result', async () => {
  const pending = deferred<IntentDecision>();
  const s = watchdog(() => pending.promise);
  s.input();
  s.coordinator.acceptDelegation({ id: 'real', generation: 1, offsetMs: 150 });
  await Promise.resolve();
  s.setTime(20000);
  s.coordinator.tick();
  assert.deepEqual(s.expired, ['real']);
  s.coordinator.reset();
  pending.resolve({
    kind: 'execute',
    evidenceSeq: [1],
    itemRefs: [{ photoId }],
    usage: 'cut',
    reason: 'late',
  });
  await s.coordinator.settled();
  assert.equal(s.executions(), 0);
  assert.deepEqual(s.recovered, []);
});

test('expired evidence cannot trigger recovery until fresh user evidence, and expiry notices coalesce', async () => {
  const s = watchdog(async (c) => ({ kind: 'wait', reason: 'incomplete' }));
  s.input();
  s.coordinator.acceptDelegation({ id: 'first', generation: 1, offsetMs: 150 });
  s.coordinator.acceptDelegation({ id: 'second', generation: 1, offsetMs: 150 });
  await s.coordinator.settled();
  assert.equal(s.classifications(), 2);
  await s.tick(20000);
  assert.deepEqual(s.expired, ['first']);
  assert.deepEqual(s.recovered, []);
  s.ledger.append({
    eventId: 'assistant-update',
    generation: 1,
    speaker: 'assistant',
    delta: 'Please repeat',
    startMs: 300,
    endMs: 400,
  });
  s.ledger.contextChanged();
  s.coordinator.onContextChanged();
  await s.tick(30000);
  assert.equal(s.classifications(), 2);
  assert.deepEqual(s.recovered, []);
  s.setTime(31000);
  s.input('cut again');
  await s.tick(34000);
  assert.equal(s.classifications(), 3);
  assert.deepEqual(s.recovered, ['wait']);
  assert.equal(s.executions(), 0);
});

test('expired real request quarantines its evidence from a later delegation but preserves a new correction', async () => {
  const pending = deferred<IntentDecision>();
  let classified = 0;
  const s = watchdog(async (c) =>
    ++classified === 1
      ? pending.promise
      : {
          kind: 'execute',
          evidenceSeq: c.eligibleEvidenceSeq,
          itemRefs: [{ photoId }],
          usage: 'cut',
          reason: 'fresh',
        },
  );
  s.input();
  s.coordinator.acceptDelegation({ id: 'old', generation: 1, offsetMs: 150 });
  await Promise.resolve();
  s.setTime(20000);
  s.coordinator.tick();
  assert.deepEqual(s.ledger.captureUnconsumedContext().eligibleEvidenceSeq, []);
  s.coordinator.acceptDelegation({ id: 'late', generation: 1, offsetMs: 150 });
  pending.resolve({
    kind: 'execute',
    evidenceSeq: [1],
    itemRefs: [{ photoId }],
    usage: 'cut',
    reason: 'old',
  });
  await s.coordinator.settled();
  assert.equal(s.executions(), 0);
  s.input('fresh cut');
  await s.coordinator.settled();
  assert.equal(s.executions(), 1);
});

test('timing out a stale classification does not consume later user evidence', async () => {
  const pending = deferred<IntentDecision>();
  const s = watchdog(() => pending.promise);
  s.input();
  s.coordinator.acceptDelegation({ id: 'old', generation: 1, offsetMs: 150 });
  await Promise.resolve();
  s.setTime(19000);
  s.input('correction');
  s.setTime(20000);
  s.coordinator.tick();
  assert.deepEqual(s.ledger.captureUnconsumedContext().eligibleEvidenceSeq, [2]);
  s.coordinator.reset();
  pending.resolve({ kind: 'wait', reason: 'old' });
  await s.coordinator.settled();
  assert.equal(s.executions(), 0);
});

test('late rejection after reset never reports a new-session error for classification, recovery or execution', async () => {
  for (const mode of ['classification', 'recovery', 'execution']) {
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    let time = 0,
      errors = 0,
      executions = 0;
    const ledger = new ConversationLedger({ generation: 1, now: () => time });
    const coordinator = new IntentCoordinator({
      ledger,
      now: () => time,
      classify: async (c) =>
        mode === 'execution'
          ? {
              kind: 'execute',
              evidenceSeq: c.eligibleEvidenceSeq,
              itemRefs: [{ photoId }],
              usage: 'cut',
              reason: 'directive',
            }
          : pending,
      execute: async () => {
        executions++;
        await pending;
      },
      onError: () => {
        errors++;
      },
    });
    ledger.append({
      eventId: 'input',
      generation: 1,
      speaker: 'user',
      delta: 'cut',
      startMs: 1,
      endMs: 2,
    });
    coordinator.onContextChanged();
    if (mode === 'recovery') {
      time = 3000;
      coordinator.tick();
    } else coordinator.acceptDelegation({ id: 'real', generation: 1, offsetMs: 2 });
    await Promise.resolve();
    await Promise.resolve();
    coordinator.reset();
    reject(new Error('old request failed'));
    await coordinator.settled();
    assert.equal(errors, 0, mode);
    assert.equal(executions, mode === 'execution' ? 1 : 0, mode);
  }
});
