import assert from 'node:assert/strict';
import test from 'node:test';
import { FinalVoicePlayback } from '../apps/local-server/final-voice-playback.js';
import type { VoiceActivity } from '../packages/shared/harness.js';

function setup() {
  let now = 1000;
  let sequence = 0;
  const playback = new FinalVoicePlayback(() => now);
  playback.start(1, 0);
  return {
    playback,
    at(value: number) {
      now = value;
    },
    report(output: VoiceActivity['output'], extra: Partial<VoiceActivity> = {}) {
      playback.report({
        generation: 1,
        sequence: ++sequence,
        input: 'unknown',
        output,
        playbackReady: true,
        inputStopped: true,
        ...extra,
      });
    },
  };
}

test('speech longer than 12 seconds drains after a continuous quiet gap, ignoring stopped input', () => {
  const h = setup();
  for (let at = 1000; at <= 21000; at += 1000) {
    h.at(at);
    h.report('active');
    assert.ok(h.playback.closingAt > at);
  }
  h.at(22000);
  h.report('quiet');
  h.at(23000);
  h.report('quiet');
  assert.ok(h.playback.closingAt > 23000);
  h.at(24000);
  h.report('quiet');
  assert.equal(h.playback.closingAt, 24000);
});

test('final commentary waits for command acknowledgment and actual output to start', () => {
  const h = setup();
  h.playback.expectSpeech(2);
  h.report('active'); // Previous utterance before the final command was sent.
  h.playback.acknowledge(1);
  for (let at = 2000; at <= 16000; at += 1000) {
    h.at(at);
    h.report('quiet');
    assert.ok(h.playback.closingAt > at);
  }
  h.playback.acknowledge(2);
  h.at(17000);
  h.report('quiet');
  assert.ok(h.playback.closingAt > 17000);
  h.at(18000);
  h.report('active');
  for (let at = 19000; at <= 21000; at += 1000) {
    h.at(at);
    h.report('quiet');
  }
  assert.equal(h.playback.closingAt, 21000);
});

test('a reconnect acknowledgment cannot cover unsent speech when termination starts', () => {
  const h = setup();
  h.playback.acknowledge(100);
  h.playback.start(1, 2, true);
  h.report('active');
  for (let at = 2000; at <= 5000; at += 1000) {
    h.at(at);
    h.report('quiet');
  }
  assert.ok(h.playback.closingAt > 5000);
  h.playback.acknowledge(2);
  h.at(6000);
  h.report('quiet');
  assert.ok(h.playback.closingAt > 6000);
  h.at(7000);
  h.report('active');
  for (let at = 8000; at <= 10000; at += 1000) {
    h.at(at);
    h.report('quiet');
  }
  assert.equal(h.playback.closingAt, 10000);
});

test('a new transcript or speech during a pause restarts the quiet wait', () => {
  const h = setup();
  h.report('quiet');
  h.at(2000);
  h.report('quiet');
  h.playback.transcript();
  h.at(3000);
  h.report('quiet');
  assert.ok(h.playback.closingAt > 3000);
  h.at(4000);
  h.report('active');
  h.at(5000);
  h.report('quiet');
  h.at(6000);
  h.report('quiet');
  assert.ok(h.playback.closingAt > 6000);
  h.at(7000);
  h.report('quiet');
  assert.equal(h.playback.closingAt, 7000);
});

for (const invalid of [
  { inputStopped: false },
  { playbackReady: false },
  { output: 'unknown' as const },
])
  test(`unconfirmed playback is not silence: ${JSON.stringify(invalid)}`, () => {
    const h = setup();
    h.report('quiet');
    h.at(2000);
    h.report('quiet', invalid);
    h.at(3000);
    h.report('quiet');
    h.at(4000);
    h.report('quiet');
    assert.ok(h.playback.closingAt > 4000);
  });

test('missing reports and stale generations/sequences cannot prove completion', () => {
  const h = setup();
  h.report('quiet');
  h.at(2000);
  h.report('quiet');
  h.at(4000);
  h.report('quiet'); // Report gap resets the continuous interval.
  h.at(5000);
  h.report('quiet', { generation: 2 });
  h.at(6000);
  h.report('quiet', { sequence: 1 });
  assert.ok(h.playback.closingAt > 6000);
  h.at(7000);
  h.report('quiet');
  assert.ok(h.playback.closingAt > 7000);
});

test('silence closes without needing a new utterance; abandoned playback has a separate timeout', () => {
  const h = setup();
  h.report('quiet');
  h.at(2000);
  h.report('quiet');
  h.at(3000);
  h.report('quiet');
  assert.equal(h.playback.closingAt, 3000);
  const abandoned = setup();
  abandoned.report('active');
  abandoned.at(12000);
  abandoned.report('unknown');
  assert.equal(abandoned.playback.closingAt, 61000);
});
