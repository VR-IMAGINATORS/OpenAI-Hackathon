import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  unlink,
  readdir,
  lstat,
  realpath,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonical, sha256, validateSource } from './source.js';
import { parseExpansionCandidate } from './schemas.js';
import { callUsageSchema, type CallUsage, pricingDigest } from './usage.js';
import {
  evaluationManifestSchema,
  generationDraftSchema,
  executionSchema,
  evaluationConditionsSchema,
  playCheckpointSchema,
  type EvaluationManifest,
  type EvaluationConditions,
  type PlayCheckpoint,
} from './store-schema.js';
export const PLAY_BYTES_LIMIT = 16 * 1024 * 1024;
export const RUN_BYTES_LIMIT = 128 * 1024 * 1024;
export const conditionsDigest = (value: EvaluationConditions) =>
  sha256(canonical(evaluationConditionsSchema.parse(value)));
export const artifactDigest = (value: unknown) => sha256(canonical(value));
async function readBounded(path: string, max: number): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    throw new Error('Invalid or oversized saved file');
  const raw = await readFile(path);
  if (raw.length > max) throw new Error('Saved file grew beyond limit');
  return JSON.parse(raw.toString('utf8'));
}
async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Symlink in run directory');
    if (stat.isDirectory()) bytes += await directoryBytes(path);
    else if (stat.isFile()) bytes += stat.size;
    else throw new Error('Non-file in run directory');
  }
  return bytes;
}
/** A single writer, immutable play checkpoints, then atomic manifest replacement. */
export class ExpansionStore {
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private constructor(
    readonly directory: string,
    private manifest: EvaluationManifest,
  ) {}
  get snapshot(): EvaluationManifest {
    return structuredClone(this.manifest);
  }
  /** Candidate-less generation has its own manifest; no plays or adoption are possible. */
  static async createDraft(root: string, base: EvaluationManifest, sourceValue: unknown) {
    const source = validateSource(sourceValue);
    const valid = evaluationManifestSchema.parse(base);
    if (
      valid.callIds.length ||
      valid.plays.length ||
      valid.conditions.sourceDigest !== source.sourceDigest
    )
      throw new Error('Invalid generation draft');
    await mkdir(root, { recursive: true });
    const directory = join(await realpath(root), valid.runId);
    await mkdir(directory);
    await mkdir(join(directory, 'calls'));
    await mkdir(join(directory, 'plays'));
    const writer = new ExpansionStore(directory, valid);
    const { plays: _plays, ...rest } = valid;
    let draft = generationDraftSchema.parse({
      ...rest,
      kind: 'mission-expansion-draft',
      conditions: { ...valid.conditions, candidateDigest: null },
      stage: 'expanding',
    });
    let finalized = false;
    const ensureDraft = async () => {
      if (finalized) throw new Error('Candidate already fixed');
      const current = generationDraftSchema.parse(
        await readBounded(join(directory, 'draft.json'), PLAY_BYTES_LIMIT),
      );
      if (artifactDigest(current) !== artifactDigest(draft)) throw new Error('Stale draft writer');
      try {
        await lstat(join(directory, 'manifest.json'));
        throw new Error('Candidate already fixed');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    };
    await writer.transaction(async () => {
      await writer.atomic('source.json', source, true);
      await writer.atomic('draft.json', draft, true);
    });
    return {
      directory,
      saveInput: async (input: unknown) =>
        writer.transaction(async () => {
          await ensureDraft();
          await writer.atomic('input.json', input, true);
        }),
      saveCall: async (value: CallUsage) =>
        writer.transaction(async () => {
          await ensureDraft();
          const call = callUsageSchema.parse(value);
          if (
            call.playId !== null ||
            call.revision !== valid.conditions.revision ||
            call.pricingRef !== pricingDigest(valid.pricingSnapshot)
          )
            throw new Error('Invalid draft call');
          if (draft.callIds.includes(call.callId)) {
            const old = callUsageSchema.parse(
              await readBounded(join(directory, 'calls', call.callId + '.json'), PLAY_BYTES_LIMIT),
            );
            if (
              old.requestDigest !== call.requestDigest ||
              old.reservedCostUsd !== call.reservedCostUsd ||
              old.reservedInputTokens !== call.reservedInputTokens ||
              old.reservedOutputTokens !== call.reservedOutputTokens ||
              (old.status !== 'running' && artifactDigest(old) !== artifactDigest(call))
            )
              throw new Error('Draft call reservation is immutable');
          }
          await writer.atomic('calls/' + call.callId + '.json', call);
          if (!draft.callIds.includes(call.callId))
            draft = { ...draft, callIds: [...draft.callIds, call.callId] };
          await writer.atomic('draft.json', draft);
        }),
      saveDiagnostic: async (value: unknown) =>
        writer.transaction(async () => {
          await ensureDraft();
          await writer.atomic('generation-diagnostic.json', value);
        }),
      fail: async (stage: 'incomplete' | 'rejected') =>
        writer.transaction(async () => {
          await ensureDraft();
          draft = { ...draft, stage };
          await writer.atomic('draft.json', draft);
        }),
      finalize: async (candidateValue: unknown) =>
        writer.transaction(async () => {
          await ensureDraft();
          if (!['frozen', 'expanding'].includes(draft.stage))
            throw new Error('Failed draft cannot finalize');
          for (const id of draft.callIds) {
            const call = callUsageSchema.parse(
              await readBounded(join(directory, 'calls', id + '.json'), PLAY_BYTES_LIMIT),
            );
            if (call.status !== 'completed') throw new Error('Unfinished generation call');
          }
          const candidate = parseExpansionCandidate(candidateValue);
          if (
            candidate.sourceDigest !== source.sourceDigest ||
            candidate.revision !== valid.conditions.revision
          )
            throw new Error('Candidate draft mismatch');
          const next = evaluationManifestSchema.parse({
            ...valid,
            conditions: { ...valid.conditions, candidateDigest: artifactDigest(candidate) },
            stage: 'static_check',
            callIds: draft.callIds,
          });
          await writer.atomic('candidate.json', candidate, true);
          await writer.atomic('manifest.json', next, true);
          writer.manifest = next;
          writer.initialized = true;
          finalized = true;
          return writer;
        }),
    };
  }
  static async readOnlyDraft(path: string) {
    const directory = await realpath(resolve(path, '..'));
    if ((await directoryBytes(directory)) > RUN_BYTES_LIMIT) throw new Error('Run exceeds 128 MiB');
    const draft = generationDraftSchema.parse(
      await readBounded(join(directory, 'draft.json'), PLAY_BYTES_LIMIT),
    );
    const source = validateSource(
      await readBounded(join(directory, 'source.json'), PLAY_BYTES_LIMIT),
    );
    if (source.sourceDigest !== draft.conditions.sourceDigest)
      throw new Error('Draft source mismatch');
    const calls = await Promise.all(
      draft.callIds.map(async (id) => {
        const call = callUsageSchema.parse(
          await readBounded(join(directory, 'calls', id + '.json'), PLAY_BYTES_LIMIT),
        );
        if (call.callId !== id || call.pricingRef !== pricingDigest(draft.pricingSnapshot))
          throw new Error('Draft call mismatch');
        return call;
      }),
    );
    let diagnostic: unknown = null;
    try {
      diagnostic = await readBounded(
        join(directory, 'generation-diagnostic.json'),
        PLAY_BYTES_LIMIT,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { directory, draft, source, candidate: null, calls, diagnostic };
  }
  /** A crashed generator can be diagnosed, but is never silently retried or priced as free. */
  static async recoverDraft(path: string) {
    const loaded = await ExpansionStore.readOnlyDraft(path);
    try {
      await lstat(join(loaded.directory, 'manifest.json'));
      throw new Error('Candidate already fixed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const { kind: _kind, stage: _stage, conditions, ...rest } = loaded.draft;
    const placeholder = evaluationManifestSchema.parse({
      ...rest,
      kind: 'mission-expansion',
      conditions: { ...conditions, candidateDigest: '0'.repeat(64) },
      stage: 'incomplete',
      plays: [],
    });
    const writer = new ExpansionStore(loaded.directory, placeholder);
    await writer.transaction(async () => {
      const current = generationDraftSchema.parse(
        await readBounded(join(loaded.directory, 'draft.json'), PLAY_BYTES_LIMIT),
      );
      if (artifactDigest(current) !== artifactDigest(loaded.draft))
        throw new Error('Stale draft writer');
      for (const call of loaded.calls)
        if (call.status === 'running')
          await writer.atomic('calls/' + call.callId + '.json', {
            ...call,
            status: 'incomplete',
            failure: 'INTERRUPTED_AT_RESUME',
          });
      await writer.atomic('draft.json', { ...current, stage: 'incomplete' });
    });
    return ExpansionStore.readOnlyDraft(path);
  }
  static async create(
    root: string,
    manifestValue: unknown,
    sourceValue: unknown,
    candidateValue: unknown,
  ): Promise<ExpansionStore> {
    const manifest = evaluationManifestSchema.parse(manifestValue),
      source = validateSource(sourceValue),
      candidate = parseExpansionCandidate(candidateValue);
    if (
      source.sourceDigest !== manifest.conditions.sourceDigest ||
      artifactDigest(candidate) !== manifest.conditions.candidateDigest ||
      candidate.sourceDigest !== source.sourceDigest ||
      candidate.revision !== manifest.conditions.revision
    )
      throw new Error('Initial artifact identity mismatch');
    if (manifest.plays.length || manifest.callIds.length)
      throw new Error('New run must have no checkpoints');
    await mkdir(root, { recursive: true });
    const directory = join(await realpath(root), manifest.runId);
    await mkdir(directory);
    await mkdir(join(directory, 'plays'));
    await mkdir(join(directory, 'calls'));
    const store = new ExpansionStore(directory, manifest);
    await store.transaction(async () => {
      await store.atomic('source.json', source, true);
      await store.atomic('candidate.json', candidate, true);
      await store.atomic('manifest.json', manifest, true);
    });
    store.initialized = true;
    return store;
  }
  static async resume(
    manifestPath: string,
    expected: EvaluationConditions,
  ): Promise<ExpansionStore> {
    if (!manifestPath.endsWith('manifest.json')) throw new Error('Expected manifest.json');
    const directory = await realpath(resolve(manifestPath, '..'));
    // Recover a lock only when its recorded writer process no longer exists.
    const lockPath = join(directory, '.writer.lock');
    try {
      const owner = (await readBounded(lockPath, 1024)) as { pid?: unknown };
      if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0)
        throw new Error('Unknown lock owner');
      try {
        process.kill(Number(owner.pid), 0);
        throw new Error('Run writer is active');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const manifest = evaluationManifestSchema.parse(
      await readBounded(join(directory, 'manifest.json'), PLAY_BYTES_LIMIT),
    );
    if (conditionsDigest(manifest.conditions) !== conditionsDigest(expected))
      throw new Error('Resume conditions mismatch');
    const source = validateSource(
      await readBounded(join(directory, 'source.json'), PLAY_BYTES_LIMIT),
    );
    const candidate = parseExpansionCandidate(
      await readBounded(join(directory, 'candidate.json'), PLAY_BYTES_LIMIT),
    );
    if (
      source.sourceDigest !== manifest.conditions.sourceDigest ||
      artifactDigest(candidate) !== manifest.conditions.candidateDigest
    )
      throw new Error('Stored artifact digest mismatch');
    if ((await directoryBytes(directory)) > RUN_BYTES_LIMIT) throw new Error('Run exceeds 128 MiB');
    const store = new ExpansionStore(directory, manifest);
    store.initialized = true;
    await store.recoverInterrupted();
    return store;
  }
  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const lock = await open(join(this.directory, '.writer.lock'), 'wx');
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid }));
        await lock.sync();
        if (this.initialized) {
          const saved = evaluationManifestSchema.parse(
            await readBounded(join(this.directory, 'manifest.json'), PLAY_BYTES_LIMIT),
          );
          if (artifactDigest(saved) !== artifactDigest(this.manifest))
            throw new Error('Stale run writer');
        }
        return await work();
      } finally {
        await lock.close();
        await unlink(join(this.directory, '.writer.lock'));
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private async atomic(
    name: string,
    value: unknown,
    exclusive = false,
    max = PLAY_BYTES_LIMIT,
    rawText = false,
  ): Promise<void> {
    const data = (rawText ? String(value) : JSON.stringify(value, null, 2)) + '\n';
    const size = Buffer.byteLength(data);
    if (size > max) throw new Error('File exceeds size limit');
    // Count temporary bytes as well; even failed/orphan checkpoints consume the run limit.
    if ((await directoryBytes(this.directory)) + size > RUN_BYTES_LIMIT)
      throw new Error('Run exceeds 128 MiB');
    const path = join(this.directory, name),
      parent = await realpath(resolve(path, '..'));
    if (
      parent !== this.directory &&
      parent !== join(this.directory, 'plays') &&
      parent !== join(this.directory, 'calls')
    )
      throw new Error('Invalid storage directory');
    try {
      const stat = await lstat(path);
      if (exclusive || !stat.isFile() || stat.isSymbolicLink())
        throw new Error('Invalid existing checkpoint');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = join(parent, '.checkpoint-' + randomUUID() + '.tmp');
    try {
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(data, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
  async setStage(stage: EvaluationManifest['stage']): Promise<void> {
    await this.transaction(async () => {
      const next = evaluationManifestSchema.parse({ ...this.manifest, stage });
      await this.atomic('manifest.json', next);
      this.manifest = next;
    });
  }
  async saveCall(value: CallUsage): Promise<void> {
    await this.transaction(async () => {
      const call = callUsageSchema.parse(value);
      if (
        call.revision !== this.manifest.conditions.revision ||
        call.pricingRef !== pricingDigest(this.manifest.pricingSnapshot)
      )
        throw new Error('Call condition mismatch');
      if (call.playId && !this.manifest.playMatrix.some((row) => row.playId === call.playId))
        throw new Error('Unknown call play');
      const next = structuredClone(this.manifest);
      if (next.callIds.includes(call.callId)) {
        const old = callUsageSchema.parse(
          await readBounded(join(this.directory, 'calls', call.callId + '.json'), PLAY_BYTES_LIMIT),
        );
        const identity = (c: CallUsage) => ({
          role: c.role,
          modelRequested: c.modelRequested,
          playId: c.playId,
          revision: c.revision,
          reservedInputTokens: c.reservedInputTokens,
          reservedOutputTokens: c.reservedOutputTokens,
          reservedCostUsd: c.reservedCostUsd,
          requestDigest: c.requestDigest,
          pricingRef: c.pricingRef,
          startedAt: c.startedAt,
        });
        if (
          artifactDigest(identity(old)) !== artifactDigest(identity(call)) ||
          (old.status !== 'running' && artifactDigest(old) !== artifactDigest(call))
        )
          throw new Error('Call reservation is immutable');
      } else next.callIds.push(call.callId);
      await this.atomic('calls/' + call.callId + '.json', call);
      await this.atomic('manifest.json', next);
      this.manifest = next;
    });
  }
  async readCalls(): Promise<CallUsage[]> {
    return Promise.all(
      this.manifest.callIds.map(async (id) => {
        const call = callUsageSchema.parse(
          await readBounded(join(this.directory, 'calls', id + '.json'), PLAY_BYTES_LIMIT),
        );
        if (
          call.callId !== id ||
          call.revision !== this.manifest.conditions.revision ||
          call.pricingRef !== pricingDigest(this.manifest.pricingSnapshot)
        )
          throw new Error('Saved call identity mismatch');
        return call;
      }),
    );
  }
  private async readPlayRef(ref: EvaluationManifest['plays'][number]): Promise<PlayCheckpoint> {
    const play = playCheckpointSchema.parse(
      await readBounded(join(this.directory, 'plays', ref.snapshotId + '.json'), PLAY_BYTES_LIMIT),
    );
    if (
      artifactDigest(play) !== ref.digest ||
      play.playId !== ref.playId ||
      play.attemptId !== ref.attemptId ||
      play.status !== ref.status ||
      play.conditionsDigest !== conditionsDigest(this.manifest.conditions)
    )
      throw new Error('Play checkpoint mismatch');
    return play;
  }
  async readPlays(): Promise<PlayCheckpoint[]> {
    return Promise.all(this.manifest.plays.map((ref) => this.readPlayRef(ref)));
  }
  async checkpointPlay(value: PlayCheckpoint): Promise<void> {
    await this.transaction(async () => {
      const play = playCheckpointSchema.parse(value),
        conditions = this.manifest.conditions;
      const row = this.manifest.playMatrix.find((row) => row.playId === play.playId);
      if (
        !row ||
        row.model !== play.model ||
        row.persona !== play.persona ||
        play.candidateDigest !== conditions.candidateDigest ||
        play.revision !== conditions.revision ||
        play.conditionsDigest !== conditionsDigest(conditions) ||
        play.callIds.some((id) => !this.manifest.callIds.includes(id))
      )
        throw new Error('Play condition mismatch');
      const previousRef = this.manifest.plays.find(
        (ref) => ref.playId === play.playId && ref.attemptId === play.attemptId,
      );
      if (previousRef) {
        const previous = await this.readPlayRef(previousRef);
        if (previous.status !== 'running' && artifactDigest(previous) !== artifactDigest(play))
          throw new Error('Terminal attempt is immutable');
        if (
          play.turns.length < previous.turns.length ||
          canonical(play.turns.slice(0, previous.turns.length)) !== canonical(previous.turns)
        )
          throw new Error('Completed turns are immutable');
      } else if (
        this.manifest.plays.some((ref) => ref.playId === play.playId && ref.status !== 'incomplete')
      )
        throw new Error('Retry requires a distinct incomplete attempt');
      const snapshotId = randomUUID();
      await this.atomic('plays/' + snapshotId + '.json', play, true);
      const next = structuredClone(this.manifest);
      next.plays = next.plays.filter(
        (ref) => ref.playId !== play.playId || ref.attemptId !== play.attemptId,
      );
      next.plays.push({
        playId: play.playId,
        attemptId: play.attemptId,
        snapshotId,
        digest: artifactDigest(play),
        status: play.status,
      });
      await this.atomic('manifest.json', next);
      this.manifest = next;
    });
  }
  private async recoverInterrupted(): Promise<void> {
    let interrupted = false;
    for (const call of await this.readCalls())
      if (call.status === 'running') {
        interrupted = true;
        await this.saveCall({ ...call, status: 'incomplete', failure: 'INTERRUPTED_AT_RESUME' });
      }
    for (const play of await this.readPlays())
      if (play.status === 'running') {
        interrupted = true;
        await this.checkpointPlay({
          ...play,
          status: 'incomplete',
          terminationReason: 'interrupted_at_resume',
        });
      }
    if (interrupted) await this.setStage('incomplete');
  }
  /** Hold the run writer lock across adoption revalidation, exclusive output writes, and stage commit. */
  async adoptExclusive<T>(expectedManifestDigest: string, work: () => Promise<T>): Promise<T> {
    return this.transaction(async () => {
      if (
        artifactDigest(this.manifest) !== expectedManifestDigest ||
        this.manifest.stage !== 'ready_for_adoption'
      )
        throw new Error('ADOPTION_SNAPSHOT_CHANGED');
      const result = await work();
      const next = evaluationManifestSchema.parse({ ...this.manifest, stage: 'adopted' });
      await this.atomic('manifest.json', next);
      this.manifest = next;
      return result;
    });
  }
  async saveInputSnapshot(value: unknown): Promise<void> {
    await this.transaction(() => this.atomic('input.json', value, true));
  }
  async beginExecution(command: string, maxCostUsd: number | null): Promise<string> {
    const id = randomUUID();
    await this.transaction(async () => {
      let records: z.infer<typeof executionSchema>[] = [];
      try {
        records = z
          .array(executionSchema)
          .max(100)
          .parse(await readBounded(join(this.directory, 'executions.json'), PLAY_BYTES_LIMIT));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const now = new Date().toISOString();
      records = records.map((r) =>
        r.status === 'running'
          ? {
              ...r,
              status: 'incomplete' as const,
              endedAt: now,
              lastCallIndex: this.manifest.callIds.length,
            }
          : r,
      );
      records.push(
        executionSchema.parse({
          id,
          command,
          maxCostUsd,
          firstCallIndex: this.manifest.callIds.length,
          lastCallIndex: null,
          startedAt: now,
          endedAt: null,
          status: 'running',
        }),
      );
      await this.atomic('executions.json', records);
    });
    return id;
  }
  async finishExecution(id: string, status: 'completed' | 'incomplete'): Promise<void> {
    await this.transaction(async () => {
      const records = z
        .array(executionSchema)
        .max(100)
        .parse(await readBounded(join(this.directory, 'executions.json'), PLAY_BYTES_LIMIT));
      const record = records.find((r) => r.id === id);
      if (!record || record.status !== 'running') throw new Error('Unknown execution');
      record.status = status;
      record.lastCallIndex = this.manifest.callIds.length;
      record.endedAt = new Date().toISOString();
      await this.atomic('executions.json', records);
    });
  }
  async saveEvaluation(value: unknown): Promise<void> {
    await this.transaction(async () => {
      try {
        const previous = await readBounded(
          join(this.directory, 'evaluation.json'),
          PLAY_BYTES_LIMIT,
        );
        await this.atomic('evaluation-history-' + randomUUID() + '.json', previous, true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await this.atomic('evaluation.json', value);
    });
  }
  async saveReport(html: string): Promise<void> {
    await this.transaction(() => this.atomic('report.html', html, false, PLAY_BYTES_LIMIT, true));
  }
  /** Render/inspection opens saved data without recovery, locks, APIs, or credentials. */
  static async readOnly(manifestPath: string) {
    const directory = await realpath(resolve(manifestPath, '..'));
    if ((await directoryBytes(directory)) > RUN_BYTES_LIMIT) throw new Error('Run exceeds 128 MiB');
    const manifest = evaluationManifestSchema.parse(
      await readBounded(join(directory, 'manifest.json'), PLAY_BYTES_LIMIT),
    );
    const source = validateSource(
      await readBounded(join(directory, 'source.json'), PLAY_BYTES_LIMIT),
    );
    const candidate = parseExpansionCandidate(
      await readBounded(join(directory, 'candidate.json'), PLAY_BYTES_LIMIT),
    );
    if (
      source.sourceDigest !== manifest.conditions.sourceDigest ||
      artifactDigest(candidate) !== manifest.conditions.candidateDigest
    )
      throw new Error('Stored artifact digest mismatch');
    const store = new ExpansionStore(directory, manifest);
    let evaluation: unknown = null;
    try {
      evaluation = await readBounded(join(directory, 'evaluation.json'), PLAY_BYTES_LIMIT);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let executions: z.infer<typeof executionSchema>[] = [];
    try {
      executions = z
        .array(executionSchema)
        .max(100)
        .parse(await readBounded(join(directory, 'executions.json'), PLAY_BYTES_LIMIT));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return {
      directory,
      manifest,
      executions,
      source,
      candidate,
      plays: await store.readPlays(),
      calls: await store.readCalls(),
      evaluation,
    };
  }
  async reusablePlays(): Promise<PlayCheckpoint[]> {
    return (await this.readPlays()).filter(
      (play) => play.status === 'cleared' || play.status === 'uncleared',
    );
  }
}
