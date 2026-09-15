import { sha256 } from './source.js';
import {
  evidencePayload,
  turnId,
  evaluationOutputSchema,
  encodeEvaluationInput,
} from './evaluation-input.js';
import type { AIResponsesClient } from '../../../apps/local-server/game-ai.js';
import { parseResponseObject } from './generator.js';
import {
  verifiedOutputSchema,
  type EvidenceRef,
  type VerifiedFinding,
} from './evaluation-schema.js';
import type { ExpansionCandidate, SourceSnapshot } from './schemas.js';
import type { PlayCheckpoint } from './store-schema.js';
export interface EvaluationEvidence {
  source: SourceSnapshot;
  candidate: ExpansionCandidate;
  plays: PlayCheckpoint[];
}
export { turnId } from './evaluation-input.js';
export function validateEvidence(refs: EvidenceRef[], input: EvaluationEvidence): void {
  for (const ref of refs) {
    if (ref.kind === 'turn') {
      const play = input.plays.find((p) => p.playId === ref.playId);
      if (!play || !play.turns.some((_, i) => turnId(play, i) === ref.turnId))
        throw new Error('INVALID_TURN_REFERENCE');
    } else {
      let current: unknown = input[ref.document];
      for (const token of ref.pointer === ''
        ? []
        : ref.pointer
            .slice(1)
            .split('/')
            .map((v) => v.replace(/~1/g, '/').replace(/~0/g, '~'))) {
        if (!current || typeof current !== 'object' || !Object.hasOwn(current, token))
          throw new Error('INVALID_POINTER_REFERENCE');
        current = (current as Record<string, unknown>)[token];
      }
    }
  }
}
export async function verifyFindings(
  input: EvaluationEvidence,
  findings: { id: string; claim: string; evidence: EvidenceRef[] }[],
  client: AIResponsesClient,
  prompt: string,
  signal?: AbortSignal,
  maxInputBytes = 65536,
): Promise<VerifiedFinding[]> {
  const request = (payload: unknown, partial = false) => ({
    model: 'gpt-6-astra',
    max_output_tokens: 12000,
    store: false,
    instructions:
      prompt +
      (partial
        ? '\nThis is a partial conversation window. Keep conclusions provisional; later windows may contain the missing clue. Preserve concerns and counterevidence for your final synthesis.'
        : ''),
    input: [
      { role: 'user', content: [{ type: 'input_text', text: encodeEvaluationInput(payload) }] },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'expansion_verify',
        strict: true,
        schema: evaluationOutputSchema(verifiedOutputSchema, input),
      },
    },
  });
  const fits = (payload: unknown) =>
    Buffer.byteLength(JSON.stringify({ ...request(payload, true), service_tier: 'default' })) <=
    maxInputBytes;
  const payload = (plays: PlayCheckpoint[]) => ({
    ...evidencePayload({ ...input, plays }),
    findings,
  });
  const check = (value: unknown) => {
    const output = verifiedOutputSchema.parse(parseResponseObject(value));
    const ids = output.findings.map((f) => f.findingId);
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== findings.length ||
      findings.some((f) => !ids.includes(f.id))
    )
      throw new Error('MISSING_VERIFICATION');
    for (const f of output.findings) validateEvidence([...f.evidence, ...f.counterEvidence], input);
    return output;
  };
  const chunks: {
    payload: ReturnType<typeof payload>;
    turnRefs: { playId: string; turnId: string }[];
  }[] = [];
  if (fits(payload(input.plays)))
    chunks.push({
      payload: payload(input.plays),
      turnRefs: input.plays.flatMap((p) =>
        p.turns.map((_, i) => ({ playId: p.playId, turnId: turnId(p, i) })),
      ),
    });
  else
    for (const play of input.plays) {
      let turns: unknown[] = [];
      let refs: { playId: string; turnId: string }[] = [];
      for (let index = 0; index < play.turns.length; index++) {
        if (!fits(payload([{ ...play, turns: [...turns, play.turns[index]] }]))) {
          if (!turns.length) throw new Error('VERIFY_SINGLE_TURN_INPUT_LIMIT');
          chunks.push({ payload: payload([{ ...play, turns }]), turnRefs: refs });
          turns = [];
          refs = [];
        }
        turns.push(play.turns[index]);
        refs.push({ playId: play.playId, turnId: turnId(play, index) });
        if (!fits(payload([{ ...play, turns }]))) throw new Error('VERIFY_SINGLE_TURN_INPUT_LIMIT');
      }
      chunks.push({ payload: payload([{ ...play, turns }]), turnRefs: refs });
    }
  if (!chunks.length) throw new Error('VERIFY_BASE_INPUT_LIMIT');
  const assessments: {
    inputDigest: string;
    turnRefs: { playId: string; turnId: string }[];
    output: ReturnType<typeof check>;
  }[] = [];
  for (const chunk of chunks) {
    const output = check(await client.respond(request(chunk.payload, chunks.length > 1), signal));
    assessments.push({
      inputDigest: sha256(encodeEvaluationInput(chunk.payload)),
      turnRefs: chunk.turnRefs,
      output,
    });
  }
  let output = assessments[0]!.output;
  if (chunks.length > 1) {
    output = check(
      await client.respond(
        request({
          ...evidencePayload({ ...input, plays: [] }),
          findings,
          ownPartialAssessments: assessments,
          instruction:
            'Synthesize ONLY your own provisional findings across all windows. All turns are represented. Consider every concern and counterexample. A gap in one window alone is not a scenario defect. If evidence is insufficient, use inconclusive.',
        }),
        signal,
      ),
    );
  }
  return output.findings.map((f) => ({
    ...f,
    model: 'gpt-6-astra',
    blocking: f.classification !== 'player_miss',
    repairable: f.classification === 'confirmed_scenario_defect',
    segments: assessments.map((a) => ({
      inputDigest: a.inputDigest,
      turnRefs: a.turnRefs,
      finding: a.output.findings.find((item) => item.findingId === f.findingId)!,
    })),
  }));
}
