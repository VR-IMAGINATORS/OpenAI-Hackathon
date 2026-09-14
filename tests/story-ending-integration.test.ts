import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GameRuntime } from '../apps/local-server/hosted-runtime.js';
import type { EndingPacket } from '../apps/local-server/ending.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { PhotoQueue } from '../apps/server/photo-queue.js';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { localizeScenario } from '../packages/shared/scenario.js';

// Exercise the shared runtime boundary between the independently implemented branches.
// Judgments are fake; these checks do not establish real AI or video quality.
for (const locale of ['ja', 'en'] as const) {
  for (const clearedCount of [0, 1, 2, 3]) {
    test(`all 18 story configurations retain ${locale} evidence and ${clearedCount} clears in the ending packet`, async () => {
      for (let candidate = 0; candidate < 18; candidate++) {
        let now = 1000;
        const snapshot = new ScenarioCatalog({
          scenarioPath: 'scenarios/story-catalog.json',
          coreConfigPath: 'config/game-core.json',
          randomIndex: () => candidate,
        }).current(locale);
        const config = loadAiConfig({ AI_MODE: 'mock' });
        const ai = new AiService(
          config,
          {
            async createLiveSession() {
              throw new Error('Live must not be called');
            },
            async hangup() {},
            async createResponse(body) {
              const input = JSON.parse((body as any).input[0].content[0].text);
              const { key, value } = input.completionFact;
              return {
                output: [
                  {
                    type: 'message',
                    content: [
                      {
                        type: 'output_text',
                        text: JSON.stringify({
                          success: true,
                          narrative: `Confirmed clear: ${input.obstacle.id}`,
                          situation: `Tool used on ${input.obstacle.id}`,
                          factChanges: [{ key, from: input.facts.values[key], to: value }],
                          inventoryChanges: [],
                          shortReason: 'Fake confirmed judgment',
                        }),
                      },
                    ],
                  },
                ],
              };
            },
          },
          () => now,
        );
        let packet: EndingPacket | undefined;
        const scenes: string[] = [];
        const runtime = new GameRuntime(
          randomUUID(),
          600_000,
          localizeScenario(snapshot.scenarioV2, locale),
          ai,
          config,
          new PhotoQueue(),
          () => now,
          snapshot,
          {
            transcript() {},
            async photos() {},
            scene(input) {
              scenes.push(input.text);
            },
            ended() {},
            ending(value) {
              packet = value;
            },
          },
        );
        try {
          runtime.heartbeat('connected');
          const game = runtime.game;
          game.inventory = [
            { id: randomUUID(), name: 'Tool', description: 'Ordinary tool', status: 'available' },
          ];
          for (let action = 0; action < clearedCount; action++) {
            await game.judgeAction(
              game.reserveAction(
                {
                  kind: 'execute',
                  evidenceSeq: [action + 1],
                  itemRefs: [{ inventoryId: game.inventory[0].id }],
                  usage: 'Use the tool',
                  reason: 'Explicit test instruction',
                },
                game.currentContextVersion,
                game.gameVersion,
                game.actionEpoch,
                game.controllerEpoch,
              ),
            );
          }
          if (clearedCount < 3) {
            now += snapshot.scenarioV2.rules.totalTimeSeconds * 1000 + 1;
            game.check();
          }
          assert.ok(packet);
          assert.equal(
            packet.outcome,
            clearedCount === 3 ? 'happy' : clearedCount === 2 ? 'normal' : 'bad',
          );
          assert.equal(packet.endReason, clearedCount === 3 ? 'escaped' : 'time_limit');
          assert.equal(packet.locale, locale);
          assert.deepEqual(packet.snapshot, snapshot);
          assert.deepEqual(
            packet.clearedIds,
            snapshot.scenarioV2.obstacles.slice(0, clearedCount).map((o) => o.id),
          );
          assert.deepEqual(
            packet.remainingObstacles.map((o) => o.id),
            snapshot.scenarioV2.obstacles.slice(clearedCount).map((o) => o.id),
          );
          assert.equal(packet.actions.length, clearedCount);
          assert.deepEqual(packet.facts, game.facts);
          assert.ok(scenes[0].includes(snapshot.scenarioV2.story!.openingClue[locale]));
          assert.ok(packet.evidence.records.some((record) => record.text === scenes[0]));
          assert.ok(Object.isFrozen(packet));
        } finally {
          runtime.dispose();
          await runtime.close();
        }
      }
    });
  }
}
