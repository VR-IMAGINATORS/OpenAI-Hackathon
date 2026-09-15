import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScenario } from '../packages/shared/scenario.js';
import { createGameAI } from '../apps/local-server/game-ai.js';
import { gameResponseRequest } from '../packages/server/openai.js';
import { parseTunnelUrl, publicOrigin } from '../tools/tunnel.js';
const scenario = parseScenario(JSON.parse(readFileSync('scenarios/default.json', 'utf8')));
test('game Responses payload matches bounded provider schema and rejects malformed output', async () => {
  let count = 0;
  const ai = createGameAI(
    {
      async respond(body) {
        gameResponseRequest.parse(body);
        count++;
        return {
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text:
                    count === 1
                      ? JSON.stringify({ items: [], usage: '', summary: '相談中' })
                      : '{}',
                },
              ],
            },
          ],
        };
      },
    },
    () => 'vision-model',
  );
  const context = {
    scenario,
    obstacleIndex: 0,
    situation: '部屋',
    inventory: [],
    photos: [],
    transcript: '何をしたらよい？',
  };
  assert.equal((await ai.recognize(context)).summary, '相談中');
  await assert.rejects(ai.recognize(context));
});

test('tunnel URLs require exact HTTPS origins and strict provider suffix', () => {
  assert.equal(
    parseTunnelUrl('| https://little-green-bird.trycloudflare.com |'),
    'https://little-green-bird.trycloudflare.com',
  );
  for (const value of [
    'https://good.trycloudflare.com.evil.test',
    'https://good.trycloudflare.com/path',
    'https://good.trycloudflare.com?key=x',
  ])
    assert.equal(parseTunnelUrl(value), undefined);
  for (const value of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com/#x',
  ])
    assert.throws(() => publicOrigin(value));
  assert.equal(publicOrigin('https://example.com/'), 'https://example.com');
});
