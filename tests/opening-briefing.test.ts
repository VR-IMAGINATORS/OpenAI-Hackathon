import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { OpeningBriefingDelivery } from '../apps/local-server/opening-briefing.js';
import { openingHandoff } from '../apps/local-server/story.js';
import type { TranscriptFragment } from '../packages/shared/conversation.js';
import type { VoiceActivity } from '../packages/shared/harness.js';

function setup(locale: 'ja' | 'en' = 'ja') {
  let now = 0;
  let sequence = 0;
  const delivery = new OpeningBriefingDelivery(locale, () => now);
  delivery.connect(1);
  const say = (speaker: 'user' | 'assistant', delta: string, startMs: number, endMs: number) =>
    delivery.transcript({
      generation: 1,
      speaker,
      delta,
      startMs,
      endMs,
      eventId: randomUUID(),
    } as TranscriptFragment);
  const activity = (patch: Partial<VoiceActivity> = {}) =>
    delivery.report({
      generation: 1,
      sequence: ++sequence,
      input: 'quiet',
      output: 'quiet',
      playbackReady: true,
      ...patch,
    });
  const begin = () => {
    say('user', locale === 'ja' ? '聞こえる' : 'I hear you', 100, 200);
    activity({ output: 'active' });
  };
  return {
    delivery,
    say,
    activity,
    begin,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

for (const locale of ['ja', 'en'] as const)
  test('fragmented sign-off requires a reply and fresh, playable silence: ' + locale, () => {
    const h = setup(locale);
    h.say('assistant', openingHandoff[locale], 0, 90);
    h.activity({ output: 'active' });
    h.activity();
    assert.equal(h.delivery.takeReady(), false, 'connection or greeting does not count as a reply');
    h.begin();
    h.say('assistant', locale === 'ja' ? '私はメイ。' : 'I’m Mei.', 300, 900);
    h.activity();
    h.advance(10000);
    assert.equal(h.delivery.takeReady(), false, 'a long mid-introduction pause is not completion');
    for (const [i, delta] of [...openingHandoff[locale]].entries())
      h.say('assistant', delta, 1000 + i * 10, 1010 + i * 10);
    assert.equal(
      h.delivery.takeReady(),
      false,
      'old quiet telemetry cannot release a new transcript',
    );
    h.activity({ output: 'active' });
    assert.equal(h.delivery.takeReady(), false);
    h.activity({ output: 'unknown' });
    assert.equal(h.delivery.takeReady(), false);
    h.activity({ playbackReady: false });
    assert.equal(h.delivery.takeReady(), false, 'blocked playback is not silence');
    h.activity({ input: 'active' });
    assert.equal(h.delivery.takeReady(), false);
    h.activity();
    h.advance(2001);
    assert.equal(h.delivery.takeReady(), false, 'stale telemetry does not prove playback stopped');
    h.activity();
    assert.equal(h.delivery.takeReady(), true);
    h.activity();
    assert.equal(h.delivery.takeReady(), false, 'deliver once');
  });

test('wait interruption and late pre-interruption speech cannot complete the introduction', () => {
  const h = setup();
  h.begin();
  h.say('assistant', '時間がないから、詳しくは', 300, 500);
  h.say('user', '待って', 500, 800);
  h.say('assistant', 'メッセージで送るわ。', 500, 700);
  h.activity();
  assert.equal(h.delivery.takeReady(), false);
  h.say('assistant', 'わかった、待つわ。', 900, 1100);
  h.activity();
  assert.equal(h.delivery.takeReady(), false);
  h.say('user', '続けて', 1200, 1400);
  h.activity({ output: 'active' });
  h.say('assistant', openingHandoff.ja, 1500, 2500);
  h.activity();
  assert.equal(h.delivery.takeReady(), true);
});

test('a reply after the completed sign-off does not lose the briefing', () => {
  const h = setup();
  h.begin();
  h.say('assistant', openingHandoff.ja, 300, 1500);
  h.say('user', 'わかった', 1600, 1800);
  h.activity();
  assert.equal(h.delivery.takeReady(), true);
});

test('out-of-order telemetry, wrong generation and missing audible output cannot release text', () => {
  const h = setup();
  h.say('user', '聞こえる', 0, 100);
  h.say('assistant', openingHandoff.ja, 200, 2000);
  h.activity();
  assert.equal(h.delivery.takeReady(), false, 'text alone does not prove audible output');
  h.activity({ output: 'active', sequence: 20 });
  h.activity({ sequence: 19 });
  h.activity({ sequence: 21, generation: 2 });
  assert.equal(h.delivery.takeReady(), false);
  h.activity({ sequence: 21 });
  assert.equal(h.delivery.takeReady(), true);
});

test('reconnection recovers an unfinished briefing once, without requiring speech to repeat', () => {
  const h = setup();
  h.begin();
  h.say('assistant', '私はメイ。', 300, 500);
  h.delivery.suspend();
  assert.equal(h.delivery.takeReady(), false);
  h.delivery.connect(2);
  assert.equal(h.delivery.takeReady(), true);
  h.delivery.connect(3);
  assert.equal(h.delivery.takeReady(), false);
});
