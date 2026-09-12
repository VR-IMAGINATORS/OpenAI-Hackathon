import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { parseScenario } from '../packages/shared/scenario.js';
import { GameSession } from '../apps/local-server/game.js';
import { GameClock } from '../apps/local-server/clock.js';
import { decodePhotos } from '../apps/local-server/photo.js';
import type { GameAI } from '../apps/local-server/game-ai.js';
import type { Judgment } from '../packages/shared/game.js';
const scenario = parseScenario(JSON.parse(readFileSync('scenarios/default.json', 'utf8')));
const result: Judgment = {
  success: true,
  narrative: '道が開けた',
  situation: '開いた',
  inventoryChanges: [],
};
function fixture(judge: GameAI['judge'] = async () => result) {
  let now = 0;
  let calls = 0;
  const ai: GameAI = {
    recognize: async (context) => ({
      items: context.photos.map((p) => ({ photoId: p.id, inventoryId: null, name: 'ひも' })),
      usage: '引っ張る',
      summary: 'ひもで引っ張る',
    }),
    judge: async (...args) => {
      calls++;
      return judge(...args);
    },
  };
  const game = new GameSession(scenario, ai, () => now);
  game.heartbeat('connected');
  game.start();
  return {
    game,
    advance: (ms: number) => {
      now += ms;
    },
    calls: () => calls,
  };
}
async function prepare(game: GameSession) {
  const ticket = game.beginPhotos();
  await game.finishPhotos([{ id: randomUUID(), jpeg: Buffer.from('fake') }], ticket);
  return game.proposal!.revision;
}
test('clock counts pause overlap once and preserves 60 second total budget', () => {
  let now = 0;
  const clock = new GameClock(300, () => now);
  clock.start();
  now = 1000;
  clock.pause('ai');
  clock.pause('recovery');
  now = 11000;
  clock.resume('ai');
  now = 21000;
  clock.resume('recovery');
  assert.equal(clock.remainingMs, 299000);
  assert.equal(clock.waitingRemainingMs, 40000);
  now = 22000;
  clock.tick();
  assert.equal(clock.remainingMs, 298000);
});
test('actions are idempotent and cannot change payload or run concurrently', async () => {
  let resolve!: (v: Judgment) => void;
  const f = fixture(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const revision = await prepare(f.game),
    id = randomUUID();
  const pending = f.game.commit(id, revision);
  await assert.rejects(f.game.commit(randomUUID(), revision), { status: 409 });
  resolve(result);
  await pending;
  await f.game.commit(id, revision);
  assert.equal(f.calls(), 1);
  assert.equal(f.game.actionsUsed, 1);
  await assert.rejects(f.game.commit(id, revision + 1), { status: 409 });
});
test('AI failure consumes no action and same ID does not retry upstream', async () => {
  const f = fixture(async () => {
    throw new Error('upstream');
  });
  const revision = await prepare(f.game),
    id = randomUUID();
  await assert.rejects(f.game.commit(id, revision), { status: 502 });
  await assert.rejects(f.game.commit(id, revision), { status: 502 });
  assert.equal(f.game.actionsUsed, 0);
  assert.equal(f.calls(), 1);
});
for (const end of ['reset', 'expired', 'ended'] as const)
  test('late judgment is discarded after ' + end, async () => {
    let resolve!: (v: Judgment) => void;
    const f = fixture(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const revision = await prepare(f.game),
      id = randomUUID();
    const pending = f.game.commit(id, revision);
    if (end === 'expired') {
      f.advance(60001);
      f.game.check();
    } else f.game.end();
    resolve(result);
    await assert.rejects(pending, { status: 410 });
    assert.equal(f.game.actionsUsed, 0);
    assert.equal(f.game.photos.length, 0);
    await assert.rejects(f.game.commit(id, revision), { status: 410 });
  });
test('time expiry prevents any paid judgment', async () => {
  const f = fixture();
  const revision = await prepare(f.game);
  f.advance(300001);
  await assert.rejects(f.game.commit(randomUUID(), revision), { status: 410 });
  assert.equal(f.calls(), 0);
  assert.equal(f.game.status, 'lost');
});
test('WebRTC disconnect pauses while HTTPS heartbeats continue and exhausts budget', () => {
  const f = fixture();
  f.advance(1000);
  f.game.heartbeat('disconnected');
  for (let n = 0; n < 7; n++) {
    f.advance(10000);
    f.game.heartbeat('disconnected');
  }
  assert.equal(f.game.status, 'expired');
  assert.equal(f.game.clock.remainingMs, 299000);
});
test('unknown inventory result cannot partially mutate inventory or consume action', async () => {
  const f = fixture(async () => ({
    ...result,
    inventoryChanges: [{ id: randomUUID(), status: 'consumed', description: 'lost' }],
  }));
  const revision = await prepare(f.game);
  await assert.rejects(f.game.commit(randomUUID(), revision), { status: 502 });
  assert.equal(f.game.actionsUsed, 0);
  assert.equal(f.game.inventory.length, 0);
});
test('photo decoder strips metadata and rejects non-image/large/count overflow', async () => {
  const jpeg = await sharp({ create: { width: 10, height: 20, channels: 3, background: 'red' } })
    .jpeg()
    .withMetadata()
    .toBuffer();
  const photos = await decodePhotos([jpeg.toString('base64')], 2);
  const meta = await sharp(photos[0].jpeg).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.format, 'jpeg');
  await assert.rejects(decodePhotos([Buffer.from('not image').toString('base64')], 2));
  await assert.rejects(decodePhotos(['a'.repeat(2796205)], 2));
  await assert.rejects(decodePhotos(['', '', ''], 2));
});

test('newly photographed objects can be consumed without creating arbitrary inventory', async () => {
  const f = fixture(async (context, proposal) => {
    const id = proposal.items[0].inventoryId!;
    assert.ok(context.inventory.some((item) => item.id === id));
    return { ...result, inventoryChanges: [{ id, status: 'consumed', description: '使い切った' }] };
  });
  await f.game.commit(randomUUID(), await prepare(f.game));
  assert.equal(f.game.inventory.length, 1);
  assert.equal(f.game.inventory[0].status, 'consumed');
});
test('stale recognition is discarded and latest revision wins', async () => {
  let resolve!: (v: any) => void;
  let count = 0;
  const f = fixture();
  const ai: GameAI = {
    recognize: async () => {
      count++;
      if (count === 1)
        return new Promise((r) => {
          resolve = r;
        });
      return { items: [], usage: 'new', summary: 'latest' };
    },
    judge: async () => result,
  };
  const game = new GameSession(scenario, ai);
  game.heartbeat('connected');
  game.start();
  game.appendTranscript('old');
  const first = game.recognize();
  game.appendTranscript('new');
  await game.recognize();
  resolve({ items: [], usage: 'old', summary: 'stale' });
  await first;
  assert.equal(game.proposal!.summary, 'latest');
  await game.recognize();
  assert.equal(count, 2);
});

test('scenario obstacle count controls winning and failed actions preserve progress', async () => {
  let success = false;
  const f = fixture(async () => ({ ...result, success }));
  await f.game.commit(randomUUID(), await prepare(f.game));
  assert.equal(f.game.obstacleIndex, 0);
  assert.equal(f.game.actionsUsed, 1);
  success = true;
  for (let i = 0; i < scenario.obstacles.length; i++)
    await f.game.commit(randomUUID(), await prepare(f.game));
  assert.equal(f.game.status, 'won');
  assert.equal(f.game.photos.length, 0);
  assert.equal(f.game.transcript, '');
});
