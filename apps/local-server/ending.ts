import type { EndingOutcome, GameEndReason } from '../../packages/shared/ending.js';
import type { GameFacts } from '../../packages/shared/conversation.js';
import type { InventoryItem, PublicGameState } from '../../packages/shared/game.js';
import type { Scenario } from '../../packages/shared/scenario.js';
import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import type { StoryEvidenceSnapshot } from './story-evidence.js';

export interface CommittedEndingAction {
  actionId: string;
  order: number;
  obstacleId: string;
  usage: string;
  items: {
    id: string;
    name: string;
    beforeStatus: InventoryItem['status'];
    afterStatus: InventoryItem['status'];
  }[];
  beforeVersion: number;
  afterVersion: number;
  beforeFacts: GameFacts;
  afterFacts: GameFacts;
  success: boolean;
  narrative: string;
  cleared: boolean;
}

export interface EndingSceneReference {
  messageId: string;
  gameVersion: number;
}

/** Factual state is captured once, independently of subsequent image completion. */
export interface EndingPacket {
  playId: string;
  snapshot: ScenarioSnapshot | null;
  scenario: Scenario;
  locale: 'ja' | 'en';
  outcome: EndingOutcome | null;
  endReason: GameEndReason;
  clearedIds: string[];
  remainingObstacles: { id: string; title: string; situation: string }[];
  facts: GameFacts;
  inventory: InventoryItem[];
  actions: CommittedEndingAction[];
  evidence: StoryEvidenceSnapshot;
  endedAt: number;
  gameVersion: number;
  finalMessageId: string | null;
  recentActionScenes: {
    actionId: string;
    before: EndingSceneReference | null;
    after: EndingSceneReference | null;
  }[];
}

export function endingOutcome(
  status: PublicGameState['status'],
  clearedIds: readonly string[],
): EndingOutcome | null {
  if (status === 'won') return 'happy';
  if (status === 'lost') return clearedIds.length >= 2 ? 'normal' : 'bad';
  return null;
}

export function freezeEndingPacket(packet: EndingPacket): EndingPacket {
  const copy = structuredClone(packet);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}
