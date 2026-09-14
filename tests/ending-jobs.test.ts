import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  EndingJobs,
  type PreparedEnding,
  type EndingJobsOptions,
} from '../apps/server/ending-jobs.js';
import { ResultStore } from '../apps/server/result-store.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import type { EndingPacket } from '../apps/local-server/ending.js';
import { localizeScenario } from '../packages/shared/scenario.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { AiService } from '../packages/server/ai-service.js';
import { FalSubmitError, type FalTransport } from '../packages/server/fal.js';
import { syntheticEndingMp4 } from './helpers/ending-mp4.js';

const handle = {
  requestId: 'one',
  statusUrl: 'private-status',
  resultUrl: 'private-result',
  cancelUrl: 'private-cancel',
};
const prepared: PreparedEnding = {
  start: Buffer.from('start'),
  end: Buffer.from('end'),
  prompt: 'private prompt',
  story: {
    title: 'The mark',
    text: 'The earlier mark remains by the closed door.',
    evaluation: 'Two restraints removed.',
    tagId: null,
    tagCatalogVersion: 1,
  },
};
const snapshot = new ScenarioCatalog({
  scenarioPath: 'scenarios/mobile-playtest.json',
  coreConfigPath: 'config/game-core.json',
}).current('en');
function packet(playId: string): EndingPacket {
  return {
    playId,
    snapshot,
    scenario: localizeScenario(snapshot.scenarioV2, 'en'),
    locale: 'en',
    outcome: 'normal',
    endReason: 'time_limit',
    clearedIds: ['one', 'two'],
    remainingObstacles: [],
    facts: { obstacleId: 'three', values: {} },
    inventory: [],
    actions: [],
    evidence: { records: [], truncated: false },
    endedAt: 0,
    gameVersion: 2,
    finalMessageId: null,
    recentActionScenes: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
  assert(predicate(), 'background ending work did not reach expected state');
}
function setup(
  t: TestContext,
  options: {
    fal?: Partial<FalTransport>;
    mode?: 'mock' | 'live';
    enabled?: boolean;
    budget?: number;
    concurrent?: number;
    graceMs?: number;
    prepare?: EndingJobsOptions['prepare'];
    response?: () => unknown | Promise<unknown>;
  } = {},
) {
  let now = 0;
  const config = loadAiConfig({ AI_MODE: 'mock' });
  config.mode = options.mode ?? 'live';
  const ai = new AiService(
    config,
    {
      async createLiveSession() {
        throw Error('not used');
      },
      async createResponse() {
        const value = options.response
          ? await options.response()
          : {
              title: prepared.story.title,
              story: prepared.story.text,
              evaluation: prepared.story.evaluation,
              tag: null,
              usedEvidenceIds: [],
            };
        return { output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] };
      },
      async hangup() {},
    },
    () => now,
  );
  let submits = 0,
    prepares = 0,
    seals = 0;
  const failures: { stage: string; code: string }[] = [];
  const fal: FalTransport = {
    async submit() {
      submits++;
      return handle;
    },
    async status() {
      return 'COMPLETED';
    },
    async result() {
      return { videoUrl: 'https://private-provider.invalid/movie' };
    },
    async cancel() {
      return { stopConfirmed: true };
    },
    async downloadVideo() {
      return syntheticEndingMp4();
    },
    ...options.fal,
  };
  const results = new ResultStore({
    now: () => 1_000_000 + now,
    ttlMs: 600_000,
    maxEntryBytes: 32 * 1024 * 1024,
    maxEnded: 30,
    onEvict: (id) => jobs.cancelPlay(id),
  });
  const jobs = new EndingJobs(
    ai,
    {
      enabled: options.enabled ?? true,
      apiKey: 'fake',
      globalAttempts: options.budget ?? 20,
      timeoutMs: 60_000,
      concurrent: options.concurrent ?? 2,
    },
    results,
    {
      now: () => now,
      fal,
      graceMs: options.graceMs ?? 0,
      pollMs: 1,
      onFailure: (_id, stage, code) => failures.push({ stage, code }),
      prepare: async (...args) => {
        prepares++;
        return options.prepare ? options.prepare(...args) : prepared;
      },
    },
  );
  t.after(async () => {
    await jobs.drain();
    jobs.dispose();
    results.clear();
    await ai.shutdown();
  });
  function add(overrides: Partial<EndingPacket> = {}) {
    const id = randomUUID(),
      value = { ...packet(id), ...overrides };
    ai.register(id, 600_000);
    results.create({ playId: id, ownerDigest: 'owner', locale: 'en' });
    const seal = () => {
      seals++;
      return value;
    };
    jobs.enqueue(value, seal);
    results.end(id, { status: 'lost' });
    return { id, packet: value, seal, view: () => results.ending('owner', id) };
  }
  return {
    ai,
    jobs,
    results,
    add,
    setNow: (n: number) => {
      now = n;
    },
    counts: () => ({ submits, prepares, seals }),
    failures,
  };
}

test('ending survives Live retirement, seals once, stores validated movie and repeated reads do not submit', async (t) => {
  const gate = deferred<PreparedEnding>();
  const f = setup(t, { prepare: () => gate.promise });
  const p = f.add();
  await until(() => f.counts().prepares === 1);
  await f.ai.retire(p.id);
  gate.resolve(prepared);
  await until(() => p.view().status === 'ready');
  f.jobs.enqueue(p.packet, p.seal);
  for (let i = 0; i < 5; i++) assert.equal(p.view().outcome, 'normal');
  assert.deepEqual(f.counts(), { submits: 1, prepares: 1, seals: 1 });
  assert.match(p.view().videoPath!, /^\/api\/play\/ending\/video\?playId=/);
  assert.doesNotMatch(JSON.stringify(p.view()), /private-provider|private prompt|private-status/);
  assert.deepEqual(f.results.endingVideo('owner', p.id), syntheticEndingMp4());
  assert.deepEqual(p.view().story, prepared.story);
});

test('rejected submission reports the failed stage and safe status code without altering the outcome', async (t) => {
  const f = setup(t, {
    fal: {
      async submit() {
        throw new FalSubmitError('rejected', undefined, 401);
      },
    },
  });
  const p = f.add();
  await until(() => p.view().status === 'failed');
  assert.equal(p.view().errorCode, 'ENDING_VIDEO_SUBMIT_HTTP_401');
  assert.equal(p.view().outcome, 'normal');
  assert.deepEqual(f.failures, [{ stage: 'video_submit', code: 'ENDING_VIDEO_SUBMIT_HTTP_401' }]);
  assert.equal(f.jobs.snapshot().unconfirmed, 0);
});
test('mock and interrupted endings never run paid preparation or fal', async (t) => {
  for (const settings of [{ mode: 'mock' as const }, {}]) {
    const f = setup(t, settings);
    const p = f.add(
      Object.keys(settings).length ? {} : { outcome: null, endReason: 'interrupted' },
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(p.view().status, Object.keys(settings).length ? 'disabled' : 'not_applicable');
    assert.deepEqual(f.counts(), { submits: 0, prepares: 0, seals: 0 });
  }
});

test('video disabled still generates and retains text once without image preparation or fal', async (t) => {
  let responses = 0;
  const f = setup(t, {
    enabled: false,
    response: () => {
      responses++;
      return {
        title: 'Ending',
        story: 'The door remains closed.',
        evaluation: 'No action.',
        tag: null,
        usedEvidenceIds: [],
      };
    },
  });
  const p = f.add();
  await until(() => p.view().storyStatus === 'ready');
  assert.equal(p.view().status, 'disabled');
  assert.equal(p.view().story!.text, 'The door remains closed.');
  f.jobs.enqueue(p.packet, p.seal);
  assert.equal(responses, 1);
  assert.deepEqual(f.counts(), { submits: 0, prepares: 0, seals: 1 });
  assert.equal(f.jobs.snapshot().reserved, 0);
});

test('text is readable during preparation and survives an image failure', async (t) => {
  const gate = deferred<void>();
  const f = setup(t, {
    prepare: async (_id, _packet, _signal, publishedStory) => {
      assert.deepEqual(publishedStory, prepared.story);
      await gate.promise;
      throw new Error('ENDING_FRAME_REJECTED');
    },
  });
  const p = f.add();
  await until(() => p.view().storyStatus === 'ready');
  assert.equal(p.view().status, 'preparing');
  assert.equal(p.view().story!.tagId, null);
  assert.equal(f.counts().submits, 0);
  gate.resolve();
  await until(() => p.view().status === 'failed');
  assert.equal(p.view().storyStatus, 'ready');
  assert.equal(p.view().story!.text, prepared.story.text);
  assert.equal(p.view().clearedCount, 2);
});

test('text-only jobs do not wait for an occupied video slot or reserve video budget', async (t) => {
  const gate = deferred<PreparedEnding>();
  const f = setup(t, { budget: 1, concurrent: 1, prepare: () => gate.promise });
  const first = f.add();
  await until(() => f.counts().prepares === 1);
  const second = f.add();
  await until(() => second.view().storyStatus === 'ready');
  assert.equal(first.view().status, 'preparing');
  assert.equal(second.view().errorCode, 'ENDING_BUDGET_EXHAUSTED');
  assert.equal(f.jobs.snapshot().reserved, 1);
  gate.resolve(prepared);
  await until(() => first.view().status === 'ready');
});

test('video-enabled plays publish text while another video occupies the only slot', async (t) => {
  const gate = deferred<PreparedEnding>();
  const f = setup(t, { budget: 3, concurrent: 1, prepare: () => gate.promise });
  const first = f.add();
  await until(() => f.counts().prepares === 1);
  const second = f.add();
  await until(() => second.view().storyStatus === 'ready');
  assert.equal(first.view().status, 'preparing');
  assert.equal(second.view().status, 'queued');
  assert.equal(f.counts().prepares, 1, 'second video has not started');
  assert.equal(second.view().story!.text, prepared.story.text);
  f.jobs.cancelPlay(second.id, 'ENDING_TIMEOUT');
  assert.equal(second.view().storyStatus, 'ready');
  assert.equal(second.view().status, 'expired');
  gate.resolve(prepared);
  await until(() => first.view().status === 'ready');
  assert.equal(f.counts().prepares, 1);
});

test('text-only failure and cancellation finish polling without changing disabled video status', async (t) => {
  const failed = setup(t, {
    enabled: false,
    response: () => {
      throw Error('network');
    },
  });
  const p = failed.add();
  await until(() => p.view().storyStatus === 'failed');
  assert.equal(p.view().status, 'disabled');
  assert.equal(p.view().story, null);
  const gate = deferred<unknown>();
  const cancelled = setup(t, { enabled: false, response: () => gate.promise });
  const q = cancelled.add();
  await until(() => q.view().storyStatus === 'generating');
  cancelled.jobs.cancelPlay(q.id);
  gate.resolve({});
  await until(() => cancelled.jobs.snapshot().remaining === 0);
  assert.equal(q.view().storyStatus, 'failed');
  assert.equal(q.view().status, 'disabled');
  assert.equal(cancelled.jobs.snapshot().reserved, 0);
});
test('finite queue reserves budget before preparation and refunds only unsubmitted work', async (t) => {
  const gate = deferred<PreparedEnding>();
  const f = setup(t, { concurrent: 1, prepare: () => gate.promise });
  f.add();
  await until(() => f.counts().prepares === 1);
  const waiting = Array.from({ length: 10 }, () => f.add());
  const rejected = f.add();
  assert.equal(rejected.view().errorCode, 'ENDING_QUEUE_FULL');
  assert.equal(f.jobs.snapshot().queued, 10);
  f.jobs.cancelPlay(waiting[0].id);
  assert.equal(f.jobs.snapshot().reserved, 10);
  gate.resolve(prepared);
  await until(() => f.jobs.snapshot().remaining === 0);
  assert.equal(f.counts().submits, 10);
  const limited = setup(t, { budget: 1 });
  const first = limited.add(),
    second = limited.add();
  assert.equal(second.view().errorCode, 'ENDING_BUDGET_EXHAUSTED');
  await until(() => first.view().status === 'ready');
  await until(() => second.view().storyStatus === 'ready');
  assert.equal(second.view().status, 'failed');
  assert.equal(second.view().errorCode, 'ENDING_BUDGET_EXHAUSTED');
  assert.equal(limited.counts().submits, 1);
});
test('ambiguous submission is never resent and retains capacity after result eviction and drain', async (t) => {
  let submits = 0;
  const f = setup(t, {
    concurrent: 1,
    fal: {
      async submit() {
        submits++;
        throw new FalSubmitError('unknown');
      },
    },
  });
  const p = f.add();
  await until(() => p.view().status === 'failed');
  assert.equal(f.jobs.snapshot().unconfirmed, 1);
  f.jobs.enqueue(p.packet, p.seal);
  f.results.evict(p.id);
  const waiting = f.add();
  assert.equal(waiting.view().status, 'queued');
  await f.jobs.drain();
  assert.equal(submits, 1);
  assert.equal(f.jobs.snapshot().remaining, 1);
});
test('cancellation 202 retains upstream work until status confirms completion', async (t) => {
  let cancels = 0;
  const f = setup(t, {
    fal: {
      async status() {
        return 'IN_PROGRESS';
      },
      async cancel() {
        cancels++;
        return { stopConfirmed: false };
      },
    },
  });
  const p = f.add();
  await until(() => f.counts().submits === 1);
  await f.jobs.drain();
  await until(() => cancels === 1);
  assert.equal(f.jobs.snapshot().unconfirmed, 1);
  assert.equal(p.view().outcome, 'normal');
  assert.equal(p.view().status, 'failed');
});
test('local deadline and late preparation do not submit; result eviction also aborts work', async (t) => {
  const gate = deferred<PreparedEnding>();
  const f = setup(t, { prepare: () => gate.promise });
  const p = f.add();
  await until(() => f.counts().prepares === 1);
  f.setNow(60_000);
  f.jobs.tick();
  gate.resolve(prepared);
  await until(() => f.jobs.snapshot().remaining === 0);
  assert.equal(p.view().status, 'expired');
  assert.equal(f.counts().submits, 0);
  const otherGate = deferred<PreparedEnding>();
  const other = setup(t, { prepare: () => otherGate.promise });
  const q = other.add();
  await until(() => other.counts().prepares === 1);
  other.results.evict(q.id);
  otherGate.resolve(prepared);
  await until(() => other.jobs.snapshot().remaining === 0);
  assert.equal(other.counts().submits, 0);
});
test('invalid MP4 is not published, factual outcome survives, and completed provider releases capacity', async (t) => {
  const f = setup(t, {
    fal: {
      async downloadVideo() {
        return Buffer.from('not an MP4');
      },
    },
  });
  const p = f.add();
  await until(() => p.view().status === 'failed');
  assert.equal(p.view().outcome, 'normal');
  assert.equal(p.view().clearedCount, 2);
  assert.equal(p.view().videoPath, null);
  assert.throws(() => f.results.endingVideo('owner', p.id));
  assert.equal(f.jobs.snapshot().remaining, 0);
});
