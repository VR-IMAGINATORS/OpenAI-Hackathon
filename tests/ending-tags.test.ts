import test from 'node:test';
import assert from 'node:assert/strict';
import { endingTags, endingTagLabel } from '../packages/shared/ending-tags.js';
import {
  endingTagSchema,
  validateEndingTag,
  publicEndingStory,
} from '../apps/local-server/ending-tags.js';
import type { EndingPacket, CommittedEndingAction } from '../apps/local-server/ending.js';

const action = (order: number, items = ['knife'], success = false): CommittedEndingAction => ({
  actionId: `a${order}`,
  order,
  obstacleId: 'lock',
  usage: 'Use a tool',
  items: items.map((id) => ({ id, name: id, beforeStatus: 'available', afterStatus: 'available' })),
  beforeVersion: order - 1,
  afterVersion: order,
  beforeFacts: { obstacleId: 'lock', values: {} },
  afterFacts: { obstacleId: 'lock', values: {} },
  success,
  narrative: 'Confirmed result',
  cleared: success,
});
const packet = (actions: CommittedEndingAction[]) => ({ actions }) as EndingPacket;
const tag = (id: string, ids: string[]) =>
  endingTagSchema.parse({ id, evidenceActionIds: ids, reason: 'Supported by these actions.' });

test('catalog has 40 unique fixed IDs with localized labels and criteria', () => {
  assert.equal(endingTags.length, 40);
  assert.equal(new Set(endingTags.map((t) => t.id)).size, 40);
  for (const t of endingTags) {
    assert(t.ja && t.en && t.criteria);
    assert.equal(endingTagLabel(t.id, 'ja'), t.ja);
    assert.equal(endingTagLabel(t.id, 'en'), t.en);
  }
  assert.equal(endingTagLabel('invented', 'ja'), null);
  assert.equal(endingTagLabel(null, 'ja'), null);
});

test('no actions cannot earn a tag; failed item use can; public story contains no private evidence', () => {
  validateEndingTag(null, packet([]));
  assert.throws(() => validateEndingTag(tag('tableware_only', ['a1']), packet([])));
  const chosen = tag('tableware_only', ['a1']);
  validateEndingTag(chosen, packet([action(1)]));
  const story = publicEndingStory({
    title: 'Title',
    story: 'Attempt failed.',
    evaluation: 'Contribution.',
    tag: chosen,
  });
  assert.equal(story.tagId, 'tableware_only');
  assert.equal(story.tagCatalogVersion, 1);
  assert(!JSON.stringify(story).includes('evidenceActionIds'));
  assert(!JSON.stringify(story).includes('reason'));
});

test('one-tool, combination and empty-handed tags enforce actual item use', () => {
  const one = tag('one_tool', ['a1', 'a2']);
  validateEndingTag(one, packet([action(1), action(2)]));
  assert.throws(() => validateEndingTag(tag('one_tool', ['a1']), packet([action(1)])));
  assert.throws(() => validateEndingTag(one, packet([action(1), action(2, ['fork'])])));
  const combo = tag('combination', ['a1']);
  assert.throws(() => validateEndingTag(combo, packet([action(1)])));
  validateEndingTag(combo, packet([action(1, ['knife', 'fork'])]));
  validateEndingTag(tag('bare_hands', ['a1']), packet([action(1, [])]));
  assert.throws(() => validateEndingTag(tag('bare_hands', ['a1']), packet([action(1)])));
  assert.throws(() => validateEndingTag(tag('verbal_override', ['a1']), packet([action(1)])));
});

test('learning requires failure followed by clearance of the same obstacle; recycling requires preexisting damage', () => {
  const learning = tag('learning', ['a1', 'a2']);
  validateEndingTag(learning, packet([action(1), action(2, ['knife'], true)]));
  assert.throws(() => validateEndingTag(learning, packet([action(1), action(2)])));
  assert.throws(() =>
    validateEndingTag(
      learning,
      packet([action(1), { ...action(2, ['knife'], true), obstacleId: 'other' }]),
    ),
  );
  const recycling = tag('recycle', ['a1']);
  const damaged = action(1);
  damaged.items[0].afterStatus = 'damaged';
  assert.throws(() => validateEndingTag(recycling, packet([damaged])));
  damaged.items[0].beforeStatus = 'damaged';
  validateEndingTag(recycling, packet([damaged]));
});
