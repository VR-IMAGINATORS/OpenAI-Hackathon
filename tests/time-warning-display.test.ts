import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GameRuntime } from '../apps/local-server/hosted-runtime.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { ResultStore } from '../apps/server/result-store.js';
import { PhotoQueue } from '../apps/server/photo-queue.js';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { localizeScenario } from '../packages/shared/scenario.js';

for (const kind of ['normal', 'final'] as const) {
  test(`${kind} warning displays only the actual Live transcript, even when paraphrased`, async (t) => {
    const now = () => 1000;
    const id = randomUUID();
    const config = loadAiConfig({ AI_MODE: 'mock' });
    const snapshot = new ScenarioCatalog({
      scenarioPath: 'scenarios/mobile-playtest.json',
      coreConfigPath: 'config/game-core.json',
    }).current('ja');
    const ai = new AiService(
      config,
      {
        async createLiveSession() {
          return {
            session: { id: 'live_warning_display' },
            transport: { type: 'webrtc', sdp: 'answer' },
          };
        },
        async hangup() {},
        async createResponse() {
          throw new Error('A warning must not invoke game reasoning');
        },
      },
      now,
    );
    const results = new ResultStore();
    results.create({ playId: id, ownerDigest: 'owner', locale: 'ja' });
    const runtime = new GameRuntime(
      id,
      600000,
      localizeScenario(snapshot.scenarioV2, 'ja'),
      ai,
      config,
      new PhotoQueue(),
      now,
      snapshot,
      {
        // Match the production presentation routes: notices and transcripts
        // become separate chat entries, so warnings must use just one route.
        notice(text) {
          results.appendMessage(id, { side: 'assistant', kind: 'system', text });
        },
        transcript(fragment, messageId) {
          results.appendTranscript(id, fragment, messageId);
        },
        async photos() {},
        scene() {},
        ended() {},
      },
    );
    t.after(async () => {
      runtime.dispose();
      await runtime.close();
    });
    const { generation } = await runtime.live(randomUUID(), 'offer');
    runtime.heartbeat('connected');
    runtime.game.clock.remainingMs = kind === 'normal' ? 59999 : 15000;
    runtime.reportVoiceActivity({
      generation,
      sequence: 1,
      input: 'quiet',
      output: 'quiet',
      playbackReady: true,
    });
    runtime.tick();
    const commands = runtime.pollCommands(generation, 0).commands;
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.noticeKind, 'time-warning');
    assert.equal(
      commands[0]!.type,
      kind === 'normal' ? 'session.thinking.append' : 'session.commentary.append',
    );
    const spoken =
      kind === 'normal' ? 'そろそろ時間が少なくなってきたね。' : 'まずい、時間がない！';
    const event = {
      type: 'session.output_transcript.delta',
      event_id: randomUUID(),
      delta: spoken,
      start_ms: 10,
      end_ms: 100,
    };
    await runtime.event(generation, event);
    await runtime.event(generation, event);
    runtime.tick();
    assert.deepEqual(runtime.pollCommands(generation, 0).commands, commands);
    assert.deepEqual(
      results.feed('owner', id).upserts.map((m) => m.text),
      [spoken],
    );
  });
}
