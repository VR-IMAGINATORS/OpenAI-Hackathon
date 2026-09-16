import { z } from 'zod';

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
  'Creative acceptance is enabled and grounded in the actual supplied items. Accept an ordinary substitute when its real shape, material and normal use can complete the CURRENT goal. The proposal does not need to use the example item or exact technical wording.',
  'Classify a proposal as stretch only when it gives a concrete physical procedure that could complete the goal with the supplied item or inventory, but would be unusually difficult to carry out. A merely non-zero theoretical possibility is not enough. Do not excuse missing length, strength, size, friction, reach or precision when that shortage prevents the action from transmitting the required effect.',
  'Fill in omitted handling steps only when they are routine for the stated action, such as gripping or aligning a suitable tool. Do not invent a critical step, reshape an item, change its material or properties, or add an unprovided tool. An explicitly proposed combination of supplied items is allowed only when the described assembly can physically transmit the required force or motion.',
  'Grounded examples: a coin that fits a slotted fastener can turn it. A rod that cannot reach the target cannot pull it unchanged; an explicitly described extension made from supplied items may work if its connection can transmit the pull. Cat claws are not automatically valid: judge whether the reconstructed claw, the target cloth or band, and the stated use can actually cut or tear it. A paper edge does not cut a thick rope merely because both relate to cutting.',
  'Reject victory declarations, insufficient or irrelevant items, unprovided tools, impossible material behavior, magic, teleportation beyond a barrier, undisclosed clues and skipped obstacles. Keep the declared goal, actual state, actors, near-side materialization boundary and explicit user stop requests.',
  'This grounded policy controls creativity classification when scenario examples, mechanism wording or acceptancePolicy are looser. Do not require the scenario example method; judge the actual proposal against the current goal and physical constraints.',
].join('\n');

export const creativeRouting = [
  creativePolicy,
  'Routing is not the physical judge. Forward each explicit instruction to execute with the user’s actual item, action and target to the final judge once, even when it appears difficult or invalid; do not repeatedly block it or silently substitute an easier method. The final judge decides ordinary, stretch or invalid.',
  'When photo intent is unclear, ask about the intended use. A question remains consultation. Once the user gives an explicit execution instruction, only an explicit wait or cancel prevents forwarding it. Do not add a permission step for damage, consumption, tool loss or other in-world consequences.',
  'Do not promise success or draw a chance in conversation. Only a committed result establishes success. Discuss an unlikely idea as worth trying, not as an absolute impossibility. Do not mention probability, lotteries or internal categories.',
].join('\n');

// Live only routes and speaks; the detailed policy belongs to the server judge.
export const creativeLiveInstructions =
  '写真または所持品を使う明確な実行指示は、入口で物理的成否を決めずclientの最終判定へ一度委譲する。難しそうという理由で確認を繰り返さず、明示的な「待って・やめて」だけ停止として扱う。用途が不明なら質問する。道具の形・材質・長さ・強度などを勝手に変えず、成功は確定結果を待つ。内部の判定方式は話さない。';

export const creativeJudgmentInstructions = [
  creativePolicy,
  'Return creativity with kind ordinary, stretch or invalid. Ordinary means the supplied item and procedure are physically workable without unusual difficulty. Stretch means there is a specific physically workable procedure, but carrying it out would be unusually difficult. Invalid includes proposals whose required physical effect cannot be delivered with the supplied items, even if success is theoretically imaginable.',
  'There is NO lottery: every proposal that qualifies as stretch must return its successful result. Never roll dice or randomly reject it. This success rule applies only after the grounded physical test classifies the proposal as stretch; it does not turn an invalid proposal into stretch.',
  'approach is a concise canonical English description (at most 96 characters) of the actual object/material or combination, its action and target; omit requests, insistence, politeness and transient photo/inventory IDs. Do not add facts not in the proposal.',
  'Compare against creativity.previousAttempts for this obstacle state and return equivalentAttemptId for the same method, including paraphrases, re-uploaded photos and inventory reuse; otherwise null. Re-evaluate the actual proposal: a previous refusal is not a permanent veto.',
  'For ordinary, return the physical judgment including justified partial progress or failure. For stretch, success must be true, satisfy the current goal completely and set its completionFact, with valid declared transitions. The server validates and commits this result without a chance-based veto. For invalid, return success false and no fact or inventory changes.',
  'effect is the real physical effect used by this action, from the supplied enum, not an exaggerated or newly granted power. Never reveal hidden mechanics in approach. narrative, situation and shortReason are private candidate explanations; no new events, extra obstacles or undisclosed story facts.',
].join('\n');
