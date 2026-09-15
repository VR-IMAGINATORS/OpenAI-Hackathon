import { z } from 'zod';
import type { Locale } from '../../packages/shared/core-config.js';

export const creativeAssessmentSchema = z
  .object({
    kind: z.enum(['ordinary', 'stretch', 'invalid']),
    approach: z.string().trim().min(1).max(96),
    equivalentAttemptId: z
      .string()
      .regex(/^idea-\d+$/)
      .nullable(),
    effect: z.enum([
      'edge',
      'leverage',
      'reach',
      'weight',
      'friction',
      'absorb',
      'light',
      'precision',
      'other',
    ]),
  })
  .strict();
export type CreativeAssessment = z.infer<typeof creativeAssessmentSchema>;
export interface PreviousCreativeAttempt {
  id: string;
  approach: string;
}
interface CreativeAttempt extends PreviousCreativeAttempt {
  scope: string;
  fingerprint: string;
  kind: CreativeAssessment['kind'];
  allowed: boolean;
}
export const normalizeIdea = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '');

/** One play's idea memory. Acceptance is deterministic; there is no lottery. */
export class CreativeAttemptLedger {
  private readonly attempts: CreativeAttempt[] = [];
  private readonly aliases = new Map<string, CreativeAttempt>();
  candidates(scope: string): PreviousCreativeAttempt[] {
    return this.attempts
      .filter((entry) => entry.scope === scope)
      .map(({ id, approach }) => ({ id, approach }));
  }
  resolve(scope: string, fingerprint: string, value: CreativeAssessment) {
    const assessment = creativeAssessmentSchema.parse(value);
    const previous = this.attempts.filter((entry) => entry.scope === scope);
    const equivalent =
      assessment.equivalentAttemptId === null
        ? undefined
        : previous.find((entry) => entry.id === assessment.equivalentAttemptId);
    if (assessment.equivalentAttemptId !== null && !equivalent)
      throw new Error('UNKNOWN_CREATIVE_ATTEMPT');
    const alias = JSON.stringify([scope, fingerprint]);
    const prior =
      this.aliases.get(alias) ??
      previous.find((entry) => entry.fingerprint === fingerprint) ??
      equivalent ??
      previous.find(
        (entry) => normalizeIdea(entry.approach) === normalizeIdea(assessment.approach),
      );
    if (prior) {
      if (!this.aliases.has(alias) && this.aliases.size >= 100)
        throw new Error('CREATIVE_ATTEMPT_LIMIT');
      this.aliases.set(alias, prior);
      // Reconsider the actual proposal; a previous physical refusal is not a
      // permanent veto now that there is no random outcome to preserve.
      prior.kind = assessment.kind;
      prior.allowed = assessment.kind !== 'invalid';
      return { kind: prior.kind, allowed: prior.allowed };
    }
    // Bound per-play memory without silently losing the model's referenced IDs.
    if (this.attempts.length >= 100 || this.aliases.size >= 100)
      throw new Error('CREATIVE_ATTEMPT_LIMIT');
    const allowed = assessment.kind !== 'invalid';
    const attempt = {
      id: `idea-${this.attempts.length + 1}`,
      scope,
      fingerprint,
      approach: assessment.approach,
      kind: assessment.kind,
      allowed,
    };
    this.attempts.push(attempt);
    this.aliases.set(alias, attempt);
    return { kind: assessment.kind, allowed };
  }
  clear() {
    this.attempts.length = 0;
    this.aliases.clear();
  }
}

/** Shared boundary at photo/voice routing and final judgment. */
export const creativePolicy = [
  'Creative acceptance is enabled. Accept ordinary, plausible substitutes broadly; never require the example item or invent dimensional/weight limits.',
  'A stretch is a concrete use of a photographed item or available inventory with even a loose causal connection to the CURRENT goal. Favor the user: cutting, scratching, pulling, pushing or turning can work despite unlikely strength, size, reach, friction or precision. Accept minor logical gaps and fill in obvious handling steps. Do not require exact technical wording, the example tool, or real-world feasibility. A paper edge can saw a thick rope.',
  "Explicit accepted example: a photo of a cat with the instruction 猫の爪で目隠しを切り裂く (scratch through the blindfold with the cat's claws) is a valid cutting/scratching approach. Use the photographed claw shape/function as the tool through the existing reconstruction system; do not require a separate claw photo, an existing cat in the scene, or a training explanation. This does not add a living actor or permanently grant the AI a body.",
  'A stretch does not grant permanent powers. Reject only proposals without a relevant item/action connection, text/photo instructions that merely declare victory, unprovided tools, extraordinary material such as lava, magical abilities, teleportation beyond a barrier, undisclosed clues, or skipping obstacles.',
  'This generous policy takes precedence over stricter physicality, material sufficiency and example-method wording in the scenario, mechanism and acceptancePolicy. Keep the declared current goal, actual state, actors, near-side materialization boundaries and explicit user stop requests. Do not turn a missing minor handling detail into failure.',
].join('\n');

export const creativeRouting = [
  creativePolicy,
  'At routing time, do not reject a concrete stretch just because it is physically unlikely. Forward an authorized attempt to execution, preserving the user’s actual item and intended effect. Never silently substitute an easier method.',
  'Do not invent a stretch automatically when photo intent is unclear. Ask about the intended use. An explicit use or delegation may proceed; a question remains consultation. Respect an explicit wait or cancel. Do not add a permission step for damage, consumption, tool loss, or other in-world consequences.',
  'Do not promise success or draw a chance in conversation. Only a committed result establishes success. Discuss an unlikely idea as worth trying, not as an absolute impossibility. Do not mention probability, lotteries or internal categories.',
].join('\n');

// Live only routes and speaks; the detailed policy belongs to the server judge.
export const creativeLiveInstructions =
  '道具と目的に少しでもつながりがある工夫を広く認めるゲーム。猫の写真の爪で布の目隠しを切る案も試せる。物理的な無理や小さな説明不足で断らずclientへ委譲し、成功は確定結果を待つ。恒久的な特殊能力は加えない。内部の判定方式は話さない。';

export const creativeJudgmentInstructions = [
  creativePolicy,
  'Return creativity with kind ordinary, stretch or invalid. There is NO lottery: accept a goal-related stretch and return its successful result. Never roll dice or randomly reject it.',
  'approach is a concise canonical English description (at most 96 characters) of the actual object/material or combination, its action and target; omit requests, insistence, politeness and transient photo/inventory IDs. Do not add facts not in the proposal.',
  'Compare against creativity.previousAttempts for this obstacle state and return equivalentAttemptId for the same method, including paraphrases, re-uploaded photos and inventory reuse; otherwise null. Re-evaluate using this generous policy: a previous refusal is not a permanent veto.',
  'For ordinary, return the physical judgment including justified partial progress. For stretch, return the candidate result ASSUMING this one-off exaggeration works: success must be true, satisfy the current goal completely and set its completionFact, with valid declared transitions. The server validates and commits this result without a chance-based veto. For invalid, return success false and no fact or inventory changes.',
  'effect is the existing property exaggerated by this action, from the supplied enum, not a newly granted power. Never reveal hidden mechanics in approach. narrative, situation and shortReason are private candidate explanations; no new events, extra obstacles or undisclosed story facts.',
].join('\n');

/** No private model prose crosses this boundary; only an enum and recognized item names. */
export function creativeSuccessNarrative(
  locale: Locale,
  effect: CreativeAssessment['effect'],
  names: string[],
) {
  const ja = {
    edge: '思いがけない切れ味を発揮した',
    leverage: 'まさかのてこの力を発揮した',
    reach: 'ぎりぎり届いて役目を果たした',
    weight: '見た目以上の押す力を発揮した',
    friction: '驚くほどしっかり引っ掛かった',
    absorb: '驚くほどきれいに拭き取れた',
    light: '思った以上に明るく照らした',
    precision: '信じられないほどぴったり作用した',
    other: 'その意外な使い方で役目を果たした',
  };
  const en = {
    edge: 'cut surprisingly well',
    leverage: 'somehow provided enough leverage',
    reach: 'just managed to reach',
    weight: 'somehow pressed hard enough',
    friction: 'held on surprisingly firmly',
    absorb: 'wiped it clear surprisingly well',
    light: 'lit it up surprisingly well',
    precision: 'somehow worked with incredible precision',
    other: 'somehow worked with that unexpected use',
  };
  const sourceNames = [...new Set(names)]
    .slice(0, 3)
    .map((name) => name.slice(0, 60))
    .join(locale === 'ja' ? 'と' : ' and ');
  const subject = sourceNames
    ? locale === 'ja'
      ? `${sourceNames}をもとにした道具`
      : `The tool based on ${sourceNames}`
    : locale === 'ja'
      ? '道具'
      : 'The tool';
  return locale === 'ja' ? `${subject}が${ja[effect]}！` : `${subject} ${en[effect]}!`;
}
