import { KnowledgeStore } from './companion-knowledge.js';
import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import type { GameFacts } from '../../packages/shared/conversation.js';
import type { PublicGameState } from '../../packages/shared/game.js';
import type { IntentContext } from './conversation.js';

/** Count committed completions, including a clear on the last available action. */
export function storyClearCount(snapshot: ScenarioSnapshot, facts: GameFacts): number {
  return snapshot.scenarioV2.obstacles.filter((obstacle) => {
    const completion = obstacle.completionFact;
    return completion && facts.values[completion.key] === completion.value;
  }).length;
}

export function storyContext(snapshot: ScenarioSnapshot, clearedCount: number) {
  const { story } = snapshot.scenarioV2;
  if (!story) return undefined;
  const locale = snapshot.locale;
  const phase = clearedCount >= 2 ? 'final' : clearedCount === 1 ? 'middle' : 'opening';
  return {
    aiName: story.aiName[locale],
    world: story.world[locale],
    scene: snapshot.scenarioV2.title[locale],
    openingClue: snapshot.scenarioV2.knowledge
      .filter((entry) => entry.kind === 'known')
      .map((entry) => entry.localizedText[locale])
      .join(' '),
    phase,
  };
}

/** Compatibility entry point now returns only public companion context. */
export function storyNarration(snapshot: ScenarioSnapshot, clearedCount: number) {
  return storyContext(snapshot, clearedCount);
}

export const openingHandoff = {
  ja: '時間がないから、詳しくはメッセージで送るわ。',
  en: 'We’re short on time, so I’ll send the details in a message.',
};

/** Spoken introduction stays short regardless of the amount of scene knowledge. */
export function storyOpening(snapshot: ScenarioSnapshot) {
  const story = snapshot.scenarioV2.story;
  if (!story) return snapshot.coreConfig.conversation[snapshot.locale].openingMessage;
  const locale = snapshot.locale;
  return locale === 'ja'
    ? `良かった、繋がった！私は${story.aiName.ja}。一週間後のあなたが、${snapshot.scenarioV2.title.ja}に閉じ込められた。急いで脱出しなくちゃ。写真を送ってくれたら、こちらの端末で同じ道具を具現化して、私が扱えます。${openingHandoff.ja}`
    : `Good, we’re connected! I’m ${story.aiName.en}. Your future self is trapped in ${snapshot.scenarioV2.title.en}, one week from now. We need to escape quickly. Send me a photo and this device can recreate the same tool for me to use. ${openingHandoff.en}`;
}

/** Display-only briefing, composed from public initial knowledge without another AI call. */
export function storyOpeningBriefing(snapshot: ScenarioSnapshot) {
  const locale = snapshot.locale;
  const situation = new KnowledgeStore(snapshot)
    .knownFacts()
    .filter((entry) => entry.currentlyApplicable)
    .map((entry) => entry.text);
  const details =
    [...new Set(situation)].join('\n') ||
    snapshot.scenarioV2.obstacles[0]!.situationDisplay[locale];
  return locale === 'ja'
    ? `一週間後のあなたが、${snapshot.scenarioV2.title.ja}に閉じ込められた。特殊な通信で、過去のあなたに連絡しています。\n\n${details}\n\n身近なものの写真を撮って、私に送ってください。そして、それをどう使うか教えて。`
    : `Your future self is trapped in ${snapshot.scenarioV2.title.en}, one week from now. I’m contacting you in the past through a special connection.\n\n${details}\n\nTake a photo of something nearby and send it to me. Then tell me how to use it.`;
}

export function storyFromState(
  snapshot: ScenarioSnapshot,
  state: PublicGameState,
  facts?: GameFacts,
) {
  if (!snapshot.scenarioV2.story) return undefined;
  const cleared = facts
    ? storyClearCount(snapshot, facts)
    : state.status === 'won'
      ? state.obstacle.count
      : state.obstacle.index;
  return storyNarration(snapshot, cleared);
}

/** Conservative opt-in: ordinary feasibility questions must not reveal a solution. */
export function requestsStoryHint(context: IntentContext): boolean {
  const eligible = new Set(context.eligibleEvidenceSeq);
  const request = context.fragments
    .filter((fragment) => fragment.speaker === 'user' && eligible.has(fragment.serverSeq))
    .map((fragment) => fragment.delta)
    .join('');
  if (
    /ヒント(?:は|を)?(?:今は|まだ)?(?:いらない|要らない|不要)|\b(?:no|without)\s+(?:any\s+)?hints?\b|don['’]?t\s+(?:give|want)(?:\s+me)?(?:\s+(?:a|any))?\s+hints?/i.test(
      request,
    )
  )
    return false;
  return /ヒント|手がかり(?:を|が)?(?:教え|ほし|欲し)|どう(?:すれば|やって)(?:いい|よい|解|外|開)|解き方|解けない|行き詰|\bhints?\b|\b(?:give|share|tell|need|want)\b.{0,40}\bclues?\b|\b(?:another|more)\s+clues?\b|how (?:can|do|should) (?:i|we) (?:solve|open|unlock|escape)|(?:i.m |we.re )?stuck/i.test(
    request,
  );
}

export function storyHint(
  snapshot: ScenarioSnapshot,
  obstacleIndex: number,
  context: IntentContext,
  hintsAlreadyGiven = 0,
  knowledge?: KnowledgeStore,
) {
  if (!snapshot.scenarioV2.story || !requestsStoryHint(context)) return undefined;
  const obstacle = snapshot.scenarioV2.obstacles[obstacleIndex];
  if (!obstacle?.hints?.length) return undefined;
  const index = Math.min(Math.max(0, hintsAlreadyGiven), obstacle.hints.length - 1);
  const store = knowledge ?? new KnowledgeStore(snapshot);
  if (!knowledge) {
    // Legacy callers provide a committed obstacle index, not a model-selected one.
    const values = Object.fromEntries(
      snapshot.scenarioV2.core.facts.map((fact) => [fact.key, fact.initial]),
    );
    for (const previous of snapshot.scenarioV2.obstacles.slice(0, obstacleIndex)) {
      if (previous.completionFact)
        values[previous.completionFact.key] = previous.completionFact.value;
    }
    store.advance({ obstacleId: obstacle.id, values });
  }
  const baseId = `${obstacle.id}-hint-${index + 1}`;
  const batch = store.eligibleRevealCandidates();
  const id = batch.candidates.some((entry) => entry.id === `${baseId}-partial`)
    ? `${baseId}-partial`
    : baseId;
  if (!store.snapshot().revealedIds.includes(id) && !store.applyReveals([id], batch.version))
    return undefined;
  const known = store.knownFacts().find((entry) => entry.id === id);
  if (!known) return undefined;
  return { obstacleId: obstacle.id, level: index + 1, hint: known.text };
}
