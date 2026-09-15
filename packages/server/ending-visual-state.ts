import type { EndingPacket } from '../../apps/local-server/ending.js';
import type { GameFacts } from '../shared/conversation.js';
import { sceneRules } from './image-service.js';

/** The same revealed obstacles and physical meanings used by the in-game scene maker. */
export function endingVisualState(packet: EndingPacket, facts: GameFacts = packet.facts) {
  const snapshot = packet.snapshot;
  if (!snapshot) return { target: facts, rules: [] };
  const scenario = snapshot.scenarioV2;
  let target = facts;
  if (scenario.story) {
    const index = scenario.obstacles.findIndex((obstacle) => obstacle.id === facts.obstacleId);
    if (index < 0) throw new Error('ENDING_INVALID_CONTINUITY');
    const visible = new Set(scenario.obstacles.slice(0, index + 1).flatMap((o) => o.factKeys));
    target = {
      obstacleId: facts.obstacleId,
      values: Object.fromEntries(Object.entries(facts.values).filter(([key]) => visible.has(key))),
    };
  }
  const rules = sceneRules({
    playId: packet.playId,
    messageId: packet.finalMessageId ?? 'ending',
    snapshot,
    facts: target,
    situation: '',
    presentation: 'ending',
  });
  return { target, rules };
}
