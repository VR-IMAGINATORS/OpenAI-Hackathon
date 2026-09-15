import { randomUUID } from 'node:crypto';
import type { ScenarioV2 } from '../../../packages/shared/scenario.js';
import { localizeScenario } from '../../../packages/shared/scenario.js';
import type { CoreConfig } from '../../../packages/shared/core-config.js';
import type { ScenarioSnapshot } from '../../../apps/server/scenario-catalog.js';
import { GameSession, GameError } from '../../../apps/local-server/game.js';
import { createGameAI, type AIResponsesClient } from '../../../apps/local-server/game-ai.js';
import { GameHarness, type HarnessTurnResult } from '../../../apps/local-server/game-harness.js';
import type { InvestigationPrompts } from '../../../apps/local-server/investigation-prompts.js';
import { storyOpeningBriefing } from '../../../apps/local-server/story.js';
import { playerRequestSchema, type PlayerRequest } from './player.js';
import type { ExpansionConfig } from './config.js';
import { artifactDigest } from './store.js';

export interface PublicPlayerState {
  status: ReturnType<GameHarness['publicView']>['status'];
  endReason: string | null;
  currentObstacle: { title: string; index: number; count: number };
  creditsRemaining: number;
  actionsUsed: number;
  heldItems: { id: string; name: string; status: string }[];
  observations: { text: string; currentlyApplicable: boolean }[];
  ambience: { targetId: string; attribute: string; value: string }[];
  lastResult: { success: boolean; narrative: string } | null;
}
export interface PublicPlayerTurn {
  index: number;
  request: PlayerRequest;
  reply: string;
  events: HarnessTurnResult['committedPublicEvents'];
}
export interface PlayerView {
  opening: string;
  state: PublicPlayerState;
  availableObjects: ExpansionConfig['objectCatalog'];
  history: PublicPlayerTurn[];
}
export interface AdapterTurnResult {
  request: PlayerRequest;
  publicReply: string;
  committedPublicEvents: HarnessTurnResult['committedPublicEvents'];
  publicStateBefore: PublicPlayerState;
  publicStateAfter: PublicPlayerState;
}
/** Input/observation adapter only: all game decisions and resource changes remain in GameHarness. */
export class TextPlayAdapter {
  readonly harness: GameHarness;
  readonly game: GameSession;
  readonly snapshot: ScenarioSnapshot;
  readonly measurementScope = Object.freeze({
    gameClock: 'fixed' as const,
    voice: 'not_exercised' as const,
    photoRecognition: 'synthetic' as const,
  });
  private readonly catalog: ExpansionConfig['objectCatalog'];
  private readonly recognized = new Map<string, ExpansionConfig['objectCatalog'][number]>();
  private readonly history: PublicPlayerTurn[] = [];
  private readonly trace: unknown[] = [];
  private sequence = 0;
  constructor(options: {
    scenario: ScenarioV2;
    coreConfig: CoreConfig;
    locale: 'ja' | 'en';
    gameModel: string;
    catalog: ExpansionConfig['objectCatalog'];
    client: AIResponsesClient;
    investigationPrompts?: InvestigationPrompts;
  }) {
    this.catalog = structuredClone(options.catalog);
    if (new Set(this.catalog.map((item) => item.id)).size !== this.catalog.length)
      throw new Error('DUPLICATE_CATALOG_ID');
    this.snapshot = {
      digest: artifactDigest(options.scenario),
      createdAt: 0,
      locale: options.locale,
      scenarioV2: structuredClone(options.scenario),
      coreConfig: structuredClone(options.coreConfig),
    };
    const gameClient: AIResponsesClient = {
      respond: (raw, signal) => {
        const body = structuredClone(raw) as any;
        if (body.text?.format?.name === 'game_result') {
          const text = body.input[0].content.find((part: any) => part.type === 'input_text');
          const data = JSON.parse(text.text);
          data.recognizedObjectProperties = [...this.recognized.entries()].map(
            ([photoId, item]) => ({
              photoId,
              name: item.name,
              ordinaryProperties: item.ordinaryProperties,
            }),
          );
          text.text = JSON.stringify(data);
        }
        return options.client.respond(body, signal);
      },
    };
    const actual = createGameAI(gameClient, () => options.gameModel, this.snapshot, {
      photoInput: 'recognized-text',
    });
    this.game = new GameSession(
      localizeScenario(this.snapshot.scenarioV2, options.locale),
      {
        ...actual,
        recognize: async (context) => ({
          items: context.photos.map((photo) => {
            const item = this.recognized.get(photo.id);
            if (!item) throw new Error('SYNTHETIC_PHOTO_UNKNOWN');
            return { photoId: photo.id, inventoryId: null, name: item.name };
          }),
          usage: '',
          summary: context.photos
            .map((photo) => this.recognized.get(photo.id)!.name)
            .join(', ')
            .slice(0, 1000),
        }),
      },
      () => 0,
      () => {},
      this.snapshot,
    );
    // The input transport is ready. No Live session, audio or delegation detector is simulated.
    this.game.heartbeat('connected');
    this.game.start();
    this.harness = new GameHarness({
      game: this.game,
      snapshot: this.snapshot,
      client: options.client,
      model: options.gameModel,
      now: () => 0,
      photoInput: 'recognized-text',
      investigationPrompts: options.investigationPrompts,
      hooks: {
        trace: (entry) => {
          this.trace.push(structuredClone(entry));
        },
      },
    });
  }
  private publicState(): PublicPlayerState {
    const state = this.harness.publicView();
    return {
      status: state.status,
      endReason: state.endReason ?? null,
      currentObstacle: {
        title: state.obstacle.title,
        index: state.obstacle.index,
        count: state.obstacle.count,
      },
      creditsRemaining: state.creditsRemaining,
      actionsUsed: state.actionsUsed,
      heldItems: state.inventory
        .filter((item) => item.status !== 'consumed')
        .map(({ id, name, status }) => ({ id, name, status })),
      observations: state.knowledge.map(({ text, currentlyApplicable }) => ({
        text,
        currentlyApplicable,
      })),
      ambience: (state.ambience ?? []).map(({ targetId, attribute, value }) => ({
        targetId,
        attribute,
        value,
      })),
      lastResult: state.lastResult
        ? { success: state.lastResult.success, narrative: state.lastResult.narrative }
        : null,
    };
  }
  view(): PlayerView {
    return {
      opening: storyOpeningBriefing(this.snapshot),
      state: this.publicState(),
      availableObjects: this.catalog.map(({ id, name, ordinaryProperties }) => ({
        id,
        name,
        ordinaryProperties: [...ordinaryProperties],
      })),
      history: this.history.map(({ index, request, reply, events }) => ({
        index,
        request: structuredClone(request),
        reply,
        events: structuredClone(events),
      })),
    };
  }
  diagnostics() {
    return {
      knowledge: this.harness.knowledge!.snapshot(),
      actions: structuredClone(this.trace),
      gameVersion: this.game.gameVersion,
      actionEpoch: this.game.actionEpoch,
      controllerEpoch: this.game.controllerEpoch,
      contextVersion: this.harness.ledger.contextVersion,
      remainingMs: this.game.clock.remainingMs,
      waitingRemainingMs: this.game.clock.waitingRemainingMs,
      measurementScope: this.measurementScope,
    };
  }
  private append(text: string) {
    this.sequence++;
    this.harness.ledger.append({
      eventId: randomUUID(),
      generation: this.game.generation,
      speaker: 'user',
      delta: text,
      startMs: this.sequence * 1000,
      endMs: this.sequence * 1000 + 1,
    });
    this.harness.sync();
  }
  async turn(raw: unknown, signal?: AbortSignal): Promise<AdapterTurnResult> {
    signal?.throwIfAborted();
    if (this.game.terminal) throw new Error('PLAY_TERMINAL');
    const request = playerRequestSchema.parse(raw);
    const before = this.publicState();
    let result: HarnessTurnResult;
    try {
      if (request.kind === 'ask') {
        this.append(request.text);
        result = await this.harness.handleRequest(
          this.harness.ledger.captureUnconsumedContext(),
          signal,
        );
      } else {
        if (new Set(request.catalogIds).size !== request.catalogIds.length)
          throw new Error('DUPLICATE_ITEM_SELECTION');
        const items = request.catalogIds.map((id) => {
          const item = this.catalog.find((item) => item.id === id);
          if (!item) throw new Error('UNKNOWN_ITEM_SELECTION');
          return item;
        });
        if (request.usage) this.append(request.usage);
        const ticket = this.harness.beginPhotos(items.length);
        const photos = items.map((item) => {
          const id = randomUUID();
          this.recognized.set(id, item);
          return { id, jpeg: Buffer.alloc(0) };
        });
        try {
          await this.game.finishPhotos(photos, ticket, true);
          this.harness.sync(true);
          result = await this.harness.handleRecognizedPhoto(
            { requestId: randomUUID(), ticket },
            signal,
          );
        } catch (error) {
          this.game.credits.cancel(ticket.creditId);
          this.game.cancelPhotos();
          throw error;
        }
      }
    } catch (error) {
      if (!(error instanceof GameError) || error.code !== 'INSUFFICIENT_CREDITS') throw error;
      result = {
        publicReply: error.message,
        committedPublicEvents: [],
        publicState: this.harness.publicView(),
      };
    }
    signal?.throwIfAborted();
    const after = this.publicState();
    this.history.push({
      index: this.history.length + 1,
      request: structuredClone(request),
      reply: result.publicReply,
      events: structuredClone(result.committedPublicEvents),
    });
    return {
      request,
      publicReply: result.publicReply,
      committedPublicEvents: result.committedPublicEvents,
      publicStateBefore: before,
      publicStateAfter: after,
    };
  }
  close() {
    this.game.end();
    this.harness.ledger.stop();
  }
}
