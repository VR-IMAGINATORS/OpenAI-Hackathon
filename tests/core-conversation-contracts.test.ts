import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  actionResultSchema,
  actionTicketSchema,
  chatMessageSchema,
  delegationRequestSchema,
  gameFactsSchema,
  intentDecisionSchema,
  liveCommandSchema,
  liveOutboxEntrySchema,
  sceneImageSlotSchema,
  transcriptFragmentSchema,
} from '../packages/shared/conversation.js';

const first = 'b55b0615-756d-4ff5-913c-92cf41594b93';
const second = '6e41d762-8811-49bb-8858-05d7b4c6fc26';
const execute = {
  kind: 'execute',
  evidenceSeq: [1, 2],
  itemRefs: [{ photoId: first }],
  usage: 'Cut the rope',
  reason: 'Direct request',
};

test('intent kinds reject fields belonging to other kinds', () => {
  for (const value of [
    { kind: 'wait', reason: 'Incomplete' },
    { kind: 'consult', evidenceSeq: [1], reason: 'Question' },
    execute,
    { ...execute, itemRefs: [{ inventoryId: first }] },
  ])
    assert.equal(intentDecisionSchema.safeParse(value).success, true);
  for (const value of [
    { kind: 'wait', reason: 'Incomplete', evidenceSeq: [1] },
    { kind: 'consult', evidenceSeq: [1], reason: 'Question', usage: 'Cut' },
    { ...execute, summary: 'Extra field' },
    { ...execute, kind: 'unknown' },
    { ...execute, usage: '' },
  ])
    assert.equal(intentDecisionSchema.safeParse(value).success, false);
});

test('intent evidence and item references require nonempty unique, correctly namespaced values', () => {
  for (const evidenceSeq of [[], [0], [-1], [1.1], [1, 1], ['1']]) {
    assert.equal(intentDecisionSchema.safeParse({ ...execute, evidenceSeq }).success, false);
  }
  for (const itemRefs of [
    [],
    ['photo-1'],
    [{}],
    [{ photoId: first, inventoryId: second }],
    [{ photoId: null }],
    [{ photoId: 'unknown' }],
    [{ photoId: first }, { photoId: first }],
  ])
    assert.equal(intentDecisionSchema.safeParse({ ...execute, itemRefs }).success, false);
});

test('transcript preserves original text but rejects invalid timing and assistant evidence', () => {
  const fragment = {
    serverSeq: 1,
    eventId: 'event-1',
    generation: 1,
    speaker: 'user',
    delta: '  切って…  ',
    startMs: 100,
    endMs: 200,
    receivedGameVersion: 0,
    executionEligible: true,
  };
  assert.equal(transcriptFragmentSchema.parse(fragment).delta, fragment.delta);
  assert.equal(transcriptFragmentSchema.safeParse({ ...fragment, endMs: 99 }).success, false);
  assert.equal(transcriptFragmentSchema.safeParse({ ...fragment, startMs: -1 }).success, false);
  assert.equal(
    transcriptFragmentSchema.safeParse({ ...fragment, speaker: 'assistant' }).success,
    false,
  );
  assert.equal(
    transcriptFragmentSchema.safeParse({
      ...fragment,
      speaker: 'assistant',
      executionEligible: false,
    }).success,
    true,
  );
  assert.equal(
    transcriptFragmentSchema.safeParse({ ...fragment, guessedMeaning: 'cut' }).success,
    false,
  );
});

test('delegation expiry and attempts have structural bounds', () => {
  const delegation = {
    id: 'delegation-1',
    generation: 1,
    offsetMs: 0,
    receivedAt: 100,
    deadline: 200,
    attempts: 0,
    lastEvaluatedContextVersion: null,
    status: 'pending',
  };
  assert.equal(delegationRequestSchema.safeParse(delegation).success, true);
  assert.equal(delegationRequestSchema.safeParse({ ...delegation, deadline: 99 }).success, false);
  assert.equal(delegationRequestSchema.safeParse({ ...delegation, attempts: 4 }).success, false);
  assert.equal(
    delegationRequestSchema.safeParse({ ...delegation, instruction: 'cut' }).success,
    false,
  );
});

test('reserved ticket binds its evidence to the execute intent', () => {
  const ticket = {
    id: first,
    playId: second,
    generation: 1,
    actionEpoch: 0,
    controllerEpoch: 0,
    gameVersion: 0,
    contextVersion: 2,
    evidenceSeq: [1, 2],
    intent: execute,
    status: 'pending',
  };
  assert.equal(actionTicketSchema.safeParse(ticket).success, true);
  assert.equal(actionTicketSchema.safeParse({ ...ticket, evidenceSeq: [1] }).success, false);
  assert.equal(
    actionTicketSchema.safeParse({ ...ticket, intent: { kind: 'wait', reason: 'Wait' } }).success,
    false,
  );
});

test('facts and committed result reject malformed keys, duplicate mutations and version jumps', () => {
  assert.equal(
    gameFactsSchema.safeParse({ obstacleId: 'rope', values: { 'rope-state': 'intact' } }).success,
    true,
  );
  assert.equal(
    gameFactsSchema.safeParse({ obstacleId: 'rope', values: { 'invalid key': 'intact' } }).success,
    false,
  );
  const change = { key: 'rope-state', from: 'intact', to: 'cut' };
  const result = {
    actionId: first,
    beforeVersion: 0,
    afterVersion: 1,
    success: true,
    factChanges: [change],
    inventoryChanges: [{ id: second, status: 'available', description: 'Scissors' }],
    narrative: 'It worked',
    shortReason: 'Physical cut',
  };
  assert.equal(actionResultSchema.safeParse(result).success, true);
  assert.equal(actionResultSchema.safeParse({ ...result, afterVersion: 0 }).success, false);
  assert.equal(actionResultSchema.safeParse({ ...result, afterVersion: 2 }).success, false);
  assert.equal(
    actionResultSchema.safeParse({ ...result, factChanges: [change, change] }).success,
    false,
  );
  assert.equal(
    actionResultSchema.safeParse({
      ...result,
      inventoryChanges: [...result.inventoryChanges, ...result.inventoryChanges],
    }).success,
    false,
  );
});

test('HTTP messages and commands retain their exact required field sets', () => {
  const slot = {
    status: 'queued',
    assetId: null,
    errorCode: null,
    deadline: '2026-09-13T10:00:00Z',
  };
  const message = {
    id: first,
    createdOrder: 0,
    updatedVersion: 0,
    side: 'assistant',
    kind: 'result',
    text: '<p>ordinary text</p>',
    assetIds: [],
    imageSlot: slot,
    relatedCommandSeq: 1,
    liveGeneration: 1,
  };
  const command = {
    seq: 1,
    event_id: 'command-1',
    type: 'session.commentary.append',
    delegation_id: null,
    content: 'It worked',
    messageId: first,
  };
  const openapi = JSON.parse(readFileSync('specs/game-core/contracts/openapi.json', 'utf8'));
  for (const [name, schema, value] of [
    ['Slot', sceneImageSlotSchema, slot],
    ['Message', chatMessageSchema, message],
    ['Command', liveCommandSchema, command],
  ] as const) {
    assert.equal(schema.safeParse(value).success, true);
    assert.deepEqual(
      Object.entries(schema.shape)
        .filter(([, field]) => !field.isOptional())
        .map(([key]) => key)
        .sort(),
      [...openapi.components.schemas[name].required].sort(),
    );
    assert.equal(schema.safeParse({ ...value, unexpected: true }).success, false);
    for (const key of Object.keys(value)) {
      const missing: Record<string, unknown> = { ...value };
      delete missing[key];
      assert.equal(schema.safeParse(missing).success, false, `${name}.${key} must be required`);
    }
  }
  assert.equal(
    chatMessageSchema.safeParse({ ...message, assetIds: [first, second, first] }).success,
    false,
  );
  assert.equal(sceneImageSlotSchema.safeParse({ ...slot, deadline: 'tomorrow' }).success, false);
  assert.equal(sceneImageSlotSchema.safeParse({ ...slot, progressPercent: 32 }).success, false);
  assert.equal(liveCommandSchema.safeParse({ ...command, generation: 1 }).success, false);
  assert.equal(
    liveOutboxEntrySchema.safeParse({
      seq: 1,
      eventId: 'command-1',
      generation: 1,
      controllerEpoch: 0,
      delegationId: null,
      commandType: command.type,
      content: 'It worked',
      messageId: first,
    }).success,
    true,
  );
});
