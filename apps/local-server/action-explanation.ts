import { z } from 'zod';
import type { Locale } from '../../packages/shared/core-config.js';

/** Only bounded physical observations may cross from the private judge to public prose. */
export const actionExplanationSchema = z
  .object({
    mechanism: z.enum([
      'edge_cut',
      'point_scratch',
      'rigidity_wedge',
      'rigidity_push',
      'rigidity_lift',
      'length_reach',
      'hook_pull',
      'grip_pull',
      'grip_turn',
      'weight_press',
      'weight_strike',
      'absorbency_wipe',
      'light_illuminate',
      'flexibility_thread',
      'adhesion_pull',
      'shape_fit_turn',
      'shape_contact',
      'connection_transmit',
    ]),
    reason: z.enum([
      'effective',
      'insufficient_force',
      'insufficient_reach',
      'shape_mismatch',
      'slips',
      'cannot_cut',
      'insufficient_light',
      'no_relevant_effect',
      'not_permitted',
    ]),
  })
  .strict();
export type ActionExplanation = z.infer<typeof actionExplanationSchema>;

export const actionExplanationInstructions =
  'Return actionExplanation for every result. mechanism pairs the ACTUAL supplied tool property with the attempted physical interaction; reason explains why it worked or failed. Choose only supplied enums, never secret facts or invented properties/measurements. For success use effective. For partial progress effective means that interaction worked but did not finish the obstacle. For no progress choose a specific limiting reason, never effective. For an irrelevant physical use choose shape_contact with no_relevant_effect; for unavailable or prohibited operations use not_permitted. Never change the proposal to fit an enum. No tool strengthening, resizing or extra parts. These fields explain the judgment, not authorize state changes.';

// Pair each property with its action so the model cannot combine, for example, light and cutting.
const mechanisms: Record<Locale, Record<ActionExplanation['mechanism'], string>> = {
  ja: {
    edge_cut: '刃や縁で対象を切ろうとしたよ。',
    point_scratch: 'とがった先で対象を引っかいて削ろうとしたよ。',
    rigidity_wedge: '硬さを使ってすき間をこじ広げようとしたよ。',
    rigidity_push: '硬さを使って対象を押そうとしたよ。',
    rigidity_lift: '硬さを使って対象を持ち上げようとしたよ。',
    length_reach: '長さを使って離れた対象まで届かせようとしたよ。',
    hook_pull: '引っかかる形を使って対象を引こうとしたよ。',
    grip_pull: '物をつかむ性質を使って対象を引こうとしたよ。',
    grip_turn: '滑りにくさを使って対象を回そうとしたよ。',
    weight_press: '重さを使って対象を押そうとしたよ。',
    weight_strike: '重さを使って対象に衝撃を与えようとしたよ。',
    absorbency_wipe: '水分を吸う性質を使って表面を拭こうとしたよ。',
    light_illuminate: '光を使って暗い部分を照らそうとしたよ。',
    flexibility_thread: '曲げられる性質を使ってすき間に通そうとしたよ。',
    adhesion_pull: 'くっつく性質を使って対象を引こうとしたよ。',
    shape_fit_turn: '先端の形を溝に合わせて回そうとしたよ。',
    shape_contact: '形を生かして、指示された対象に作用させようとしたよ。',
    connection_transmit: 'つないだ部分を通して対象へ力を伝えようとしたよ。',
  },
  en: {
    edge_cut: 'cut the target with its edge',
    point_scratch: 'scratch through the target with its pointed tip',
    rigidity_wedge: 'pry the gap wider using its rigidity',
    rigidity_push: 'push the target using its rigidity',
    rigidity_lift: 'lift the target using its rigidity',
    length_reach: 'reach the distant target using its length',
    hook_pull: 'catch and pull the target using its hooked shape',
    grip_pull: 'pull the target using its grip',
    grip_turn: 'turn the target using its friction',
    weight_press: 'press the target using its weight',
    weight_strike: 'strike the target using its weight',
    absorbency_wipe: 'wipe the surface using its absorbency',
    light_illuminate: 'illuminate the dark area using its light',
    flexibility_thread: 'thread it through the gap using its flexibility',
    adhesion_pull: 'pull the target using its adhesion',
    shape_fit_turn: 'fit its tip into the slot and turn it',
    shape_contact: 'apply its shape to the specified target',
    connection_transmit: 'transmit force through the joined parts',
  },
};
const reasons: Record<Locale, Record<ActionExplanation['reason'], string>> = {
  ja: {
    effective: 'その性質が働いて、狙った作用を伝えられたよ。',
    insufficient_force: '必要な力に耐えたり、力を伝えたりするには足りなかったよ。',
    insufficient_reach: '長さが足りず、作用させたい場所まで届かなかったよ。',
    shape_mismatch: '形が合わず、必要な動きを伝えられなかったよ。',
    slips: '滑ってしまい、必要な力を伝えられなかったよ。',
    cannot_cut: '対象を切ったり削ったりするには、切れ味が足りなかったよ。',
    insufficient_light: '光が足りず、必要な部分を見分けられなかったよ。',
    no_relevant_effect: 'その使い方では、解除につながる作用が生じなかったよ。',
    not_permitted: '今ここにある道具と、できる操作だけでは成立しなかったよ。',
  },
  en: {
    effective: 'That property produced the intended physical effect.',
    insufficient_force: 'It could not withstand or transmit enough force.',
    insufficient_reach: 'It was too short to reach the point where it needed to act.',
    shape_mismatch: 'The shape did not fit, so it could not transmit the required movement.',
    slips: 'It slipped and could not transmit enough force.',
    cannot_cut: 'The edge could not cut or scrape through the target.',
    insufficient_light: 'There was not enough light to make out the required area.',
    no_relevant_effect: 'That use produced no effect that would release the obstacle.',
    not_permitted: 'The available tools and permitted operations could not carry out that use.',
  },
};

/** Never turn a contradictory explanation into a made-up cause of success/failure. */
export function supportedActionExplanation(
  value: unknown,
  success: boolean,
  progressed: boolean,
): ActionExplanation | undefined {
  const parsed = actionExplanationSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const explanation = parsed.data;
  if ((success || progressed) && explanation.reason !== 'effective') return undefined;
  if (!success && !progressed && explanation.reason === 'effective') return undefined;
  if (
    explanation.reason === 'cannot_cut' &&
    !['edge_cut', 'point_scratch'].includes(explanation.mechanism)
  )
    return undefined;
  if (explanation.reason === 'insufficient_light' && explanation.mechanism !== 'light_illuminate')
    return undefined;
  return explanation;
}

/** Names come from the fixed proposal; all other words are authored, not private judge prose. */
export function describeActionExplanation(
  locale: Locale,
  explanation: ActionExplanation | undefined,
  names: string[],
): string {
  const subject =
    [...new Set(names)]
      .slice(0, 3)
      .map((name) => name.slice(0, 60))
      .join(locale === 'ja' ? 'と' : ' and ') || (locale === 'ja' ? '対象' : 'the target');
  if (!explanation)
    return locale === 'ja'
      ? `${subject}で指示された操作を試したよ。どの性質がどう働いたかは、まだ特定できていない。`
      : `I tried the requested operation with ${subject}. The property and its effect have not been established.`;
  return locale === 'ja'
    ? `${subject}の${mechanisms.ja[explanation.mechanism]}${reasons.ja[explanation.reason]}`
    : `I used ${subject} to try to ${mechanisms.en[explanation.mechanism]}. ${reasons.en[explanation.reason]}`;
}
