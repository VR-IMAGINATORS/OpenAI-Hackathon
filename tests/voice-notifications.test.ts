import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceNotificationScheduler } from '../apps/local-server/voice-notifications.js';
import type { WarningPolicy, VoiceActivity } from '../packages/shared/harness.js';
import { LiveOutbox } from '../apps/local-server/live-outbox.js';
import { factCommand } from '../apps/local-server/live.js';
import { discardWarning } from '../apps/web/src/live-command-delivery.js';

const words = (text: string) => ({ ja: text, en: text });
const policy: WarningPolicy = {
  enabled: true,
  milestones: [
    {
      id: 'normal',
      kind: 'normal',
      thresholdSeconds: 60,
      message: words('normal'),
      transitionMessage: words('transition'),
    },
    {
      id: 'final',
      kind: 'final',
      thresholdSeconds: 15,
      maxWaitMs: 3000,
      message: words('final'),
      transitionMessage: words('urgent transition'),
    },
  ],
};
function fixture(combine = false) {
  let now = 0;
  const scheduler = new VoiceNotificationScheduler(
    policy,
    () => now,
    () => 100000 + now,
    combine ? (warning: string, result: string) => `${warning}\n${result}` : undefined,
  );
  scheduler.reset(1);
  const report = (
    sequence: number,
    input: VoiceActivity['input'] = 'quiet',
    output: VoiceActivity['output'] = 'quiet',
    playbackReady = true,
  ) => scheduler.report({ generation: 1, sequence, input, output, playbackReady });
  const warnings = (remaining: number) => scheduler.updateWarnings(remaining, 'ja', (text) => text);
  return {
    scheduler,
    report,
    warnings,
    time: (time: number) => {
      now = time;
    },
  };
}
test('ordinary warnings wait for both sides quiet and fresh playable audio', () => {
  const f = fixture();
  f.warnings(60000);
  assert.equal(f.scheduler.takeNext(), null);
  f.report(1, 'active');
  assert.equal(f.scheduler.takeNext(), null);
  f.report(2, 'quiet', 'unknown');
  assert.equal(f.scheduler.takeNext(), null);
  f.report(3, 'quiet', 'quiet', false);
  assert.equal(f.scheduler.takeNext(), null);
  f.report(4);
  f.time(2000);
  assert.equal(f.scheduler.takeNext(), null);
  assert.equal(f.report(3), false);
  assert.equal(
    f.scheduler.report({
      generation: 2,
      sequence: 5,
      input: 'quiet',
      output: 'quiet',
      playbackReady: true,
    }),
    false,
  );
  f.report(5);
  const notice = f.scheduler.takeNext();
  assert.equal(notice?.payload, 'normal');
  assert.equal(notice?.validUntil, 145000);
  f.warnings(55000);
  assert.equal(f.scheduler.takeNext(), null);
});
test('final supersedes ordinary warning, waits finitely, and preserves committed results', () => {
  const f = fixture();
  f.warnings(50000);
  f.time(35000);
  f.warnings(15000);
  f.scheduler.enqueue({ id: 'result', generation: 1, kind: 'result', payload: 'rope cut' });
  f.scheduler.enqueue({ id: 'correction', generation: 1, kind: 'correction', payload: 'stop' });
  assert.equal(f.scheduler.takeNext()?.payload, 'stop');
  f.time(37999);
  assert.equal(f.scheduler.takeNext(), null);
  f.time(38000);
  assert.equal(f.scheduler.takeNext()?.payload, 'urgent transition');
  assert.equal(f.scheduler.takeNext()?.payload, 'rope cut');
  assert.equal(f.scheduler.takeNext(), null);
});
test('final uses a quiet gap if available and pending/expired notices never survive termination', () => {
  const f = fixture();
  f.warnings(15000);
  f.report(1);
  assert.equal(f.scheduler.takeNext()?.payload, 'final');
  f.scheduler.reset(2);
  f.warnings(10000);
  assert.equal(f.scheduler.takeNext(), null); // already delivered in prior connection
  const g = fixture();
  g.warnings(15000);
  g.time(15000);
  assert.equal(g.scheduler.takeNext(), null);
  g.warnings(0);
  g.report(1);
  g.warnings(15000);
  assert.equal(g.scheduler.takeNext(), null);
});
test('ending takes priority and suppresses pending warnings; reconnect rejects prior activity', () => {
  const f = fixture();
  f.warnings(60000);
  f.scheduler.enqueue({ id: 'result', kind: 'result', generation: 1, payload: 'result' });
  f.scheduler.enqueue({ id: 'end', kind: 'ending', generation: 1, payload: 'end' });
  assert.equal(f.scheduler.takeNext()?.payload, 'end');
  assert.equal(f.scheduler.takeNext()?.payload, 'result');
  assert.equal(f.scheduler.takeNext(), null);
  f.scheduler.reset(2);
  assert.equal(f.report(1), false);
});
test('expired warning remains acknowledgeable without losing later result or leaking metadata upstream', () => {
  let now = 100000;
  const box = new LiveOutbox(1, 0, () => now);
  const warning = box.append(factCommand('warning'), null, {
    noticeKind: 'time-warning',
    validUntil: 101000,
  });
  const result = box.append(factCommand('result'));
  now = 100500;
  const batch = box.poll(1, 0, 0);
  assert.equal(batch.serverNow, now);
  assert.equal(discardWarning(warning, false, batch.serverNow, 200, 699), false);
  assert.equal(discardWarning(warning, false, batch.serverNow, 200, 700), true);
  assert.equal(discardWarning(warning, true, batch.serverNow, 200, 200), true);
  assert.equal(discardWarning(result, true, batch.serverNow, 200, 999999), false);
  assert.deepEqual(box.poll(1, 0, warning.seq).commands, [result]);
  assert.equal(box.poll(1, 0, result.seq).commands.length, 0);
  assert.throws(() =>
    box.append(
      {
        type: warning.type,
        event_id: warning.event_id,
        content: warning.content,
        delegation_id: warning.delegation_id,
      },
      null,
      { noticeKind: 'time-warning', validUntil: 999999 },
    ),
  );
});

test('ready final and committed result are one non-expiring delivery after the bounded wait', () => {
  const f = fixture(true);
  f.warnings(15000);
  f.scheduler.enqueue({ id: 'result', generation: 1, kind: 'result', payload: 'rope cut' });
  f.time(2999);
  assert.equal(f.scheduler.takeNext(), null);
  f.time(3000);
  const combined = f.scheduler.takeNext();
  assert.deepEqual(combined, {
    id: 'result',
    generation: 1,
    kind: 'result',
    payload: 'urgent transition\nrope cut',
    includesTimeWarning: true,
  });
  assert.equal(combined?.validUntil, undefined);
  assert.equal(f.scheduler.takeNext(), null);
  f.warnings(11000);
  assert.equal(f.scheduler.takeNext(), null);
});

test('a quiet gap combines the calm warning, while ending always precedes any combination', () => {
  const f = fixture(true);
  f.warnings(15000);
  f.scheduler.enqueue({ id: 'result', generation: 1, kind: 'result', payload: 'result' });
  f.report(1);
  assert.equal(f.scheduler.takeNext()?.payload, 'final\nresult');
  assert.equal(f.scheduler.takeNext(), null);
  const g = fixture(true);
  g.warnings(15000);
  g.scheduler.enqueue({ id: 'result', generation: 1, kind: 'result', payload: 'result' });
  g.scheduler.enqueue({ id: 'end', generation: 1, kind: 'ending', payload: 'end' });
  assert.equal(g.scheduler.takeNext()?.payload, 'end');
  const result = g.scheduler.takeNext();
  assert.equal(result?.payload, 'result');
  assert.equal(result?.includesTimeWarning, undefined);
});

test('an expired final never enters a combined result and cannot leave the result waiting', () => {
  const f = fixture(true);
  f.warnings(15000);
  f.scheduler.enqueue({ id: 'result', generation: 1, kind: 'result', payload: 'result' });
  f.time(15000);
  const result = f.scheduler.takeNext();
  assert.equal(result?.payload, 'result');
  assert.equal(result?.includesTimeWarning, undefined);
  assert.equal(result?.validUntil, undefined);
  assert.equal(f.scheduler.takeNext(), null);
});

test('fractional monotonic game time produces integer wire expiry', () => {
  const f = fixture();
  f.time(0.25);
  f.warnings(59999.75);
  f.report(1);
  assert.equal(Number.isSafeInteger(f.scheduler.takeNext()?.validUntil), true);
});

test('an ordinary warning stays separate silent context after a ready result at a quiet gap', () => {
  const f = fixture(true);
  f.warnings(60000);
  f.report(1);
  f.scheduler.enqueue({ id: 'result', generation: 1, kind: 'result', payload: 'result' });
  const result = f.scheduler.takeNext();
  assert.equal(result?.payload, 'result');
  assert.equal(result?.validUntil, undefined);
  assert.equal(result?.includesTimeWarning, undefined);
  const warning = f.scheduler.takeNext();
  assert.equal(warning?.kind, 'normal-warning');
  assert.equal(warning?.payload, 'normal');
  assert.ok(Number.isSafeInteger(warning?.validUntil));
  assert.equal(f.scheduler.takeNext(), null);
});
