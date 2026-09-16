import assert from 'node:assert/strict';
import test from 'node:test';
import { liveSpeechText } from '../apps/local-server/live-speech.js';
import { factCommands, speechCommands } from '../apps/local-server/live.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { liveRequest } from '../packages/server/openai.js';

test('voice-only reading projection preserves facts and does not add undisclosed terms', () => {
  const facts = {
    targetId: 'gimmick-thermal-leak',
    text: '内扉の閂と引き輪。反時計回り。',
    success: false,
  };
  const original = JSON.stringify(facts);
  const spoken = JSON.parse(liveSpeechText(original));
  assert.deepEqual(spoken, { ...facts, text: 'うちとびらのかんぬきとひきわ。はんとけいまわり。' });
  assert.equal(JSON.stringify(facts), original);
  assert.equal(liveSpeechText('まだ見えません。'), 'まだ見えません。');
  assert.equal(liveSpeechText('No confirmed change.'), 'No confirmed change.');
});

test('expanded kana stays within notification byte bounds without losing text', () => {
  const source = '閂と内扉を確認。'.repeat(100);
  const expected = liveSpeechText(source);
  const facts = factCommands(source);
  assert.equal(facts.map((part) => part.content).join(''), expected);
  assert(facts.every((part) => Buffer.byteLength(part.content) <= 480));
  const speech = speechCommands(source, 'delegation', 'pronunciation');
  assert.equal(speech.filter((part) => part.type === 'session.commentary.append').length, 1);
  assert(speech.every((part) => Buffer.byteLength(part.content) <= 480));
  assert.equal(
    speech
      .slice(0, -1)
      .map((part) => JSON.parse(part.content).facts)
      .join(''),
    expected,
  );
});

test('voice selection defaults to gleam, allows explicit fallback, rejects unsupported values', () => {
  assert.equal(loadAiConfig({ AI_MODE: 'mock' }).liveVoice, 'gleam');
  assert.equal(loadAiConfig({ AI_MODE: 'mock', LIVE_VOICE: 'marin' }).liveVoice, 'marin');
  for (const value of ['', 'invented-voice'])
    assert.throws(() => loadAiConfig({ AI_MODE: 'mock', LIVE_VOICE: value }), /LIVE_VOICE/);
  const request = {
    session: {
      model: 'gpt-live-1',
      instructions: 'Speak Japanese.',
      audio: { output: { voice: 'gleam' } },
      delegation: { type: 'client' },
      store: false,
    },
    transport: { type: 'webrtc', sdp: 'offer' },
  };
  assert.equal(liveRequest.parse(request).session.audio?.output.voice, 'gleam');
  assert(
    !liveRequest.safeParse({
      ...request,
      session: { ...request.session, audio: { output: { voice: 'unknown' } } },
    }).success,
  );
});

test('speech projection removes legacy delivery instructions without changing world facts', () => {
  const source =
    '通信は一週間前につながる。落ち着いた敬体で短く話し、成功した工夫に具体的に応答する。';
  assert.equal(
    liveSpeechText(source),
    '通信は一週間前につながる。成功した工夫に具体的に応答する。',
  );
  assert.equal(
    liveSpeechText(
      'The door is closed. Speak briefly, calmly and politely; respond specifically to successful ideas.',
    ),
    'The door is closed. Respond specifically to successful ideas.',
  );
});
