import test from 'node:test';
import assert from 'node:assert/strict';
import { GameCredits } from '../apps/local-server/credits.js';

test('reservations prevent overspending; retry and cancellation preserve the available balance', () => {
  const credits = new GameCredits(120);
  assert.ok(credits.reserve('photo', 'photo', 100));
  assert.ok(credits.reserve('photo', 'photo', 100));
  assert.equal(credits.remaining, 20);
  assert.equal(credits.reserve('other-photo', 'photo', 100), false);
  assert.ok(credits.reserve('voice', 'conversation', 20));
  assert.equal(credits.remaining, 0);
  credits.cancel('photo');
  assert.equal(credits.remaining, 100);
  credits.settle('voice');
  credits.settle('voice');
  assert.equal(credits.remaining, 100);
  assert.equal(credits.lastCharge?.sequence, 1);
  credits.cancelPending();
  assert.equal(credits.remaining, 100);
  assert.equal(credits.pending, false);
});
