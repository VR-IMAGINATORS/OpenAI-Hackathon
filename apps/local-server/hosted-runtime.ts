import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import { createHash } from 'node:crypto';
import { GameSession, GameError } from './game.js';
import { createGameAI } from './game-ai.js';
import { decodePhotos } from './photo.js';
import { liveInstructions, openingCommand, factCommand, liveEventSchema } from './live.js';
import type { Scenario } from '../../packages/shared/scenario.js';
import type { LiveCommand } from '../../packages/shared/game.js';
import type { AiService } from '../../packages/server/ai-service.js';
import type { PhotoQueue } from '../server/photo-queue.js';

type Cached<T> = { digest: string; epoch: number; promise: Promise<T> };
export class GameRuntime {
  readonly game: GameSession;
  private epoch = 1;
  private openingIssued = false;
  private seen = new Set<string>();
  private transcriptTimer?: ReturnType<typeof setTimeout>;
  private liveRequests = new Map<
    string,
    Cached<{ sdp: string; generation: number; opening: LiveCommand | null }>
  >();
  private photoRequests = new Map<string, Cached<void>>();
  private liveCreating = false;
  private disposed = false;
  closingAt = Infinity;

  constructor(
    readonly id: string,
    readonly deadline: number,
    scenario: Scenario,
    private ai: AiService,
    private models: { liveModel: string; responseModel: string },
    private queue: PhotoQueue,
    private now = () => performance.now(),
    readonly coreSnapshot?: ScenarioSnapshot,
  ) {
    ai.register(id, deadline);
    this.game = new GameSession(
      scenario,
      createGameAI({ respond: (body) => ai.respond(id, body) }, () => models.responseModel),
      now,
      () => {
        clearTimeout(this.transcriptTimer);
        this.seen.clear();
        this.closingAt = Math.min(
          deadline,
          now() + (['won', 'lost'].includes(this.game.status) ? 12_000 : 0),
        );
      },
    );
  }
  private valid(epoch = this.epoch) {
    return (
      !this.disposed && !this.game.terminal && epoch === this.epoch && this.now() < this.deadline
    );
  }
  private check(epoch = this.epoch) {
    this.game.check();
    if (!this.valid(epoch)) throw new GameError(410, 'プレイまたは操作権が失効しました。');
  }
  async transferControl() {
    this.epoch++;
    this.game.changeController();
    clearTimeout(this.transcriptTimer);
    this.seen.clear();
    this.liveRequests.clear();
    this.game.heartbeat('disconnected');
    return this.ai.closeLive(this.id);
  }
  live(requestId: string, sdp: string) {
    this.check();
    const digest = createHash('sha256').update(sdp).digest('hex');
    const previous = this.liveRequests.get(requestId);
    if (previous) {
      if (previous.digest !== digest || previous.epoch !== this.epoch)
        throw new GameError(409, '接続要求が変更されています。');
      return previous.promise;
    }
    if (this.liveCreating) throw new GameError(409, '音声接続を処理中です。');
    if (this.liveRequests.size >= 3) throw new GameError(429, '音声接続の試行上限です。');
    this.liveCreating = true;
    const epoch = this.epoch;
    const promise = (async () => {
      try {
        if (!(await this.ai.closeLive(this.id)))
          throw new GameError(502, '前の音声の終了を確認できません。');
        this.check(epoch);
        const answer = await this.ai.createLive(this.id, {
          session: {
            model: this.models.liveModel,
            instructions: liveInstructions(this.game.state()),
            delegation: { type: 'client' },
            store: false,
          },
          transport: { type: 'webrtc', sdp },
        });
        if (!this.valid(epoch)) {
          await this.ai.closeLive(this.id);
          throw new GameError(410, '接続中にプレイが失効しました。');
        }
        this.game.generation++;
        this.seen.clear();
        this.game.heartbeat('connecting');
        const opening = this.openingIssued ? null : openingCommand(this.game.state());
        this.openingIssued = true;
        return { sdp: answer.transport.sdp, generation: this.game.generation, opening };
      } finally {
        this.liveCreating = false;
      }
    })();
    this.liveRequests.set(requestId, { digest, epoch, promise });
    return promise;
  }
  photos(requestId: string, images: string[], signal?: AbortSignal) {
    this.check();
    const digest = createHash('sha256').update(JSON.stringify(images)).digest('hex');
    const prior = this.photoRequests.get(requestId);
    if (prior) {
      if (prior.digest !== digest || prior.epoch !== this.epoch)
        throw new GameError(409, '写真の再送内容が変更されています。');
      return prior.promise;
    }
    if (this.photoRequests.size >= 100) throw new GameError(429, '写真送信の試行上限です。');
    const ticket = this.game.beginPhotos();
    const epoch = this.epoch;
    const promise = (async () => {
      try {
        const photos = await this.queue.run(
          () => decodePhotos(images, this.game.scenario.rules.maxPhotosPerAction),
          () => this.valid(epoch),
          signal,
        );
        this.check(epoch);
        await this.game.finishPhotos(photos, ticket);
        this.check(epoch);
      } catch (error) {
        if (epoch === this.epoch) this.game.cancelPhotos();
        if (error instanceof GameError) throw error;
        throw new GameError(
          422,
          '写真を読み取れませんでした。JPEG/PNG/WebP、1枚2MiB以内で撮り直してください。',
        );
      }
    })();
    this.photoRequests.set(requestId, { digest, epoch, promise });
    return promise;
  }
  async event(generation: number, raw: unknown): Promise<LiveCommand[]> {
    this.check();
    if (generation !== this.game.generation) throw new GameError(409, '古い音声接続です。');
    const event = liveEventSchema.parse(raw);
    if (this.seen.has(event.event_id)) return [];
    if (this.seen.size >= 10000) throw new GameError(429, '音声イベント上限です。');
    this.seen.add(event.event_id);
    const epoch = this.epoch;
    if (event.type === 'session.input_transcript.delta') {
      this.game.appendTranscript(event.delta);
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = setTimeout(() => {
        if (this.valid(epoch)) void this.game.recognize().catch(() => {});
      }, 800);
      this.transcriptTimer.unref();
    }
    if (event.type === 'session.delegation.created') {
      clearTimeout(this.transcriptTimer);
      await this.game.recognize();
      this.check(epoch);
      return [
        factCommand(
          this.game.proposal
            ? JSON.stringify(this.game.proposal)
            : '道具と使い方を確認中。実行はまだ確定していません。',
          event.delegation.id,
        ),
      ];
    }
    return [];
  }
  start(): LiveCommand[] {
    this.check();
    const wasBriefing = this.game.status === 'briefing';
    this.game.start();
    return wasBriefing
      ? [
          factCommand(
            '導入チュートリアルは終了。本編を開始し、制限時間が進んでいます。現在の障害について相談を続けてください。',
          ),
        ]
      : [];
  }
  async action(actionId: string, revision: number): Promise<LiveCommand[]> {
    const epoch = this.epoch;
    const result = await this.game.commit(actionId, revision);
    if (this.disposed || epoch !== this.epoch) throw new GameError(410, '操作権が失効しました。');
    return [
      factCommand(
        '確定した行動結果: ' + result.narrative + ' 現在の状況: ' + this.game.state().situation,
      ),
      {
        ...factCommand(
          '結果を短く伝えてください: ' +
            result.narrative +
            ' 現在の状況: ' +
            this.game.state().situation,
        ),
        type: 'session.commentary.append',
      },
    ];
  }
  expire() {
    this.game.end();
  }
  async close() {
    const confirmed = await this.ai.retire(this.id);
    if (confirmed) this.ai.forget(this.id);
    return confirmed;
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.transcriptTimer);
    this.game.end();
    this.seen.clear();
    this.liveRequests.clear();
    this.photoRequests.clear();
  }
}
