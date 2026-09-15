import { readFileSync } from 'node:fs';
import {
  evidencePayload,
  evaluationOutputSchema,
  encodeEvaluationInput,
  decodeEvaluationInput,
} from './evaluation-input.js';
import type { AIResponsesClient } from '../../../apps/local-server/game-ai.js';
import { ExpansionBudget, MeasuredResponsesClient } from './budget.js';
import type { CallUsage } from './usage.js';
import { parseResponseObject } from './generator.js';
import { artifactDigest, conditionsDigest } from './store.js';
import { sha256 } from './source.js';
import type { EvaluationConditions, PlayCheckpoint } from './store-schema.js';
import {
  REVIEW_MODELS,
  reviewOutputSchema,
  evaluationRecordSchema,
  type EvaluationRecord,
} from './evaluation-schema.js';
import { validateEvidence, verifyFindings, turnId, type EvaluationEvidence } from './verify.js';
export function loadEvaluationPrompts() {
  return {
    review: readFileSync(new URL('./prompts/review.md', import.meta.url), 'utf8'),
    verify: readFileSync(new URL('./prompts/verify.md', import.meta.url), 'utf8'),
    repair: readFileSync(new URL('./prompts/repair.md', import.meta.url), 'utf8'),
  };
}
export async function evaluateCandidate(
  input: EvaluationEvidence & {
    conditions: EvaluationConditions;
    client: AIResponsesClient;
    budget: ExpansionBudget;
    checkpoint?: (call: CallUsage) => Promise<void>;
    prompts: { review: string; verify: string };
    signal?: AbortSignal;
  },
): Promise<EvaluationRecord> {
  const record: EvaluationRecord = {
    schemaVersion: 1,
    candidateDigest: artifactDigest(input.candidate),
    revision: input.candidate.revision,
    conditionsDigest: conditionsDigest(input.conditions),
    playIds: input.plays.map((p) => p.playId),
    reviews: [],
    verifiedFindings: [],
    verificationModel: null,
    status: 'incomplete',
    failure: null,
  };
  try {
    if (
      input.conditions.candidateDigest !== record.candidateDigest ||
      input.conditions.sourceDigest !== input.source.sourceDigest ||
      input.conditions.revision !== record.revision ||
      new Set(record.playIds).size !== record.playIds.length
    )
      throw new Error('EVALUATION_IDENTITY_MISMATCH');
    for (const [name, prompt] of Object.entries(input.prompts))
      if (input.conditions.promptDigests['evaluation/' + name] !== sha256(prompt))
        throw new Error('EVALUATION_PROMPT_MISMATCH');
    if (
      input.plays.some(
        (p) =>
          p.candidateDigest !== record.candidateDigest ||
          p.conditionsDigest !== record.conditionsDigest ||
          p.revision !== record.revision ||
          !['cleared', 'uncleared'].includes(p.status),
      )
    )
      throw new Error('PLAY_INCOMPLETE_OR_MISMATCH');
    // All reviewers see the same ordered, lossless turn partition, never another reviewer's answers.
    const evidence: EvaluationEvidence = {
      source: input.source,
      candidate: input.candidate,
      plays: input.plays,
    };
    const request = (model: string, text: string, instructions = input.prompts.review) => ({
      model,
      max_output_tokens: 8000,
      store: false,
      instructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
      text: {
        format: {
          type: 'json_schema',
          name: 'expansion_review',
          strict: true,
          schema: evaluationOutputSchema(reviewOutputSchema, evidence),
        },
      },
    });
    const fits = (text: string) =>
      Buffer.byteLength(
        JSON.stringify({ ...request(REVIEW_MODELS[0], text), service_tier: 'default' }),
      ) <= input.budget.options.limits.maxInputBytes;
    const makeText = (plays: PlayCheckpoint[]) =>
      encodeEvaluationInput(evidencePayload({ ...evidence, plays }));
    const chunks: { text: string; turnRefs: { playId: string; turnId: string }[] }[] = [];
    if (!input.plays.length) {
      const text = makeText([]);
      if (!fits(text)) throw new Error('EVALUATION_BASE_INPUT_LIMIT');
      chunks.push({ text, turnRefs: [] });
    }
    for (const play of input.plays) {
      let turns: unknown[] = [];
      let refs: { playId: string; turnId: string }[] = [];
      for (let index = 0; index < play.turns.length; index++) {
        const next = [...turns, play.turns[index]];
        if (!fits(makeText([{ ...play, turns: next }]))) {
          if (!turns.length) throw new Error('EVALUATION_SINGLE_TURN_INPUT_LIMIT');
          chunks.push({ text: makeText([{ ...play, turns }]), turnRefs: refs });
          turns = [];
          refs = [];
        }
        turns.push(play.turns[index]);
        refs.push({ playId: play.playId, turnId: turnId(play, index) });
        if (!fits(makeText([{ ...play, turns }])))
          throw new Error('EVALUATION_SINGLE_TURN_INPUT_LIMIT');
      }
      const text = makeText([{ ...play, turns }]);
      if (!fits(text)) throw new Error('EVALUATION_BASE_INPUT_LIMIT');
      chunks.push({ text, turnRefs: refs });
    }
    const checkReview = (review: ReturnType<typeof reviewOutputSchema.parse>) => {
      if (
        new Set(review.feasibilityFindings.map((f) => f.id)).size !==
        review.feasibilityFindings.length
      )
        throw new Error('DUPLICATE_FINDING');
      validateEvidence(review.feasibilityEvidence, evidence);
      for (const finding of review.feasibilityFindings)
        validateEvidence(finding.evidence, evidence);
      for (const score of Object.values(review.funScores)) {
        if (score.score !== null && !score.evidence.length) throw new Error('UNSUPPORTED_SCORE');
        validateEvidence(score.evidence, evidence);
      }
    };
    for (const model of REVIEW_MODELS) {
      const client = new MeasuredResponsesClient(
        input.client,
        input.budget,
        () => ({ role: 'expansion_review', revision: record.revision }),
        input.checkpoint,
      );
      const segments = [];
      for (const chunk of chunks) {
        const review = reviewOutputSchema.parse(
          parseResponseObject(await client.respond(request(model, chunk.text), input.signal)),
        );
        checkReview(review);
        segments.push({ inputDigest: sha256(chunk.text), turnRefs: chunk.turnRefs, review });
      }
      let review = segments[0]!.review;
      if (segments.length > 1) {
        const own = encodeEvaluationInput({ candidateDigest: record.candidateDigest, segments });
        const response = await client.respond(
          request(
            model,
            own,
            input.prompts.review +
              '\nThese are exclusively your own assessments of deterministic parts of one candidate and all its plays. Synthesize the four scores using evidence (null if inadequate); retain all distinct feasibility concerns, including contradictions between segments. No average threshold or win-rate gate. Do not invent references.',
          ),
          input.signal,
        );
        review = reviewOutputSchema.parse(parseResponseObject(response));
        checkReview(review);
        // A synthesis cannot silently discard a concern discovered in a segment.
        review.feasibilityFindings = segments
          .flatMap((segment, i) =>
            segment.review.feasibilityFindings.map((finding, j) => ({
              ...finding,
              id: 'segment-' + i + '-' + j,
            })),
          )
          .concat(
            review.feasibilityFindings.map((finding, j) => ({ ...finding, id: 'synthesis-' + j })),
          );
        review = reviewOutputSchema.parse(review);
      }
      record.reviews.push({
        ...review,
        model,
        candidateDigest: record.candidateDigest,
        playIds: record.playIds,
        segments,
      });
    }
    const findings = record.reviews.flatMap((r, i) =>
      r.feasibilityFindings.map((f, j) => ({ ...f, id: 'review-' + i + '-' + j })),
    );
    // Every normal failed play is examined even if reviewers did not flag a defect.
    for (const play of input.plays.filter((p) => p.status === 'uncleared')) {
      if (!play.turns.length) throw new Error('FAILED_PLAY_WITHOUT_EVIDENCE');
      findings.push({
        id: 'failed-' + play.playId,
        claim: 'Determine why this play did not clear; do not assume scenario fault.',
        evidence: [
          { kind: 'turn', playId: play.playId, turnId: turnId(play, play.turns.length - 1) },
        ],
      });
    }
    const verifier = new MeasuredResponsesClient(
      input.client,
      input.budget,
      () => ({ role: 'expansion_verify', revision: record.revision }),
      input.checkpoint,
    );
    for (const group of findings.length ? findings.map((f) => [f]) : [[]]) {
      const referenced = new Set(
        group.flatMap((f) =>
          f.evidence.filter((ref) => ref.kind === 'turn').map((ref) => ref.playId),
        ),
      );
      record.verifiedFindings.push(
        ...(await verifyFindings(
          { ...evidence, plays: input.plays.filter((p) => referenced.has(p.playId)) },
          group,
          verifier,
          input.prompts.verify,
          input.signal,
          input.budget.options.limits.maxInputBytes,
        )),
      );
    }
    record.verificationModel = 'gpt-6-astra';
    record.status = 'complete';
  } catch (error) {
    record.failure = error instanceof Error ? error.message.slice(0, 2000) : 'EVALUATION_FAILURE';
  }
  return evaluationRecordSchema.parse(record);
}
export function validateEvaluationForAdoption(
  value: unknown,
  expected: {
    candidateDigest: string;
    conditionsDigest: string;
    plays: PlayCheckpoint[];
    expectedPlayIds: string[];
    source: EvaluationEvidence['source'];
    candidate: EvaluationEvidence['candidate'];
    allowUnresolved?: boolean;
  },
): EvaluationRecord {
  const record = evaluationRecordSchema.parse(value);
  const same = (a: string[], b: string[]) =>
    a.length === b.length && new Set(a).size === a.length && a.every((v) => b.includes(v));
  if (
    record.status !== 'complete' ||
    record.failure !== null ||
    record.candidateDigest !== expected.candidateDigest ||
    record.conditionsDigest !== expected.conditionsDigest ||
    record.verificationModel !== 'gpt-6-astra' ||
    !same(record.playIds, expected.expectedPlayIds) ||
    !same(
      record.reviews.map((r) => r.model),
      [...REVIEW_MODELS],
    )
  )
    throw new Error('EVALUATION_NOT_READY');
  if (
    record.reviews.some(
      (r) => r.candidateDigest !== record.candidateDigest || !same(r.playIds, record.playIds),
    ) ||
    (!expected.allowUnresolved &&
      record.verifiedFindings.some(
        (f) => f.classification !== 'player_miss' || f.blocking || f.repairable,
      ))
  )
    throw new Error('UNRESOLVED_FEASIBILITY');
  if (
    !same(
      expected.plays.map((p) => p.playId),
      record.playIds,
    ) ||
    expected.plays.some(
      (p) =>
        !['cleared', 'uncleared'].includes(p.status) ||
        p.candidateDigest !== record.candidateDigest ||
        p.conditionsDigest !== record.conditionsDigest ||
        p.revision !== record.revision,
    )
  )
    throw new Error('PLAY_INCOMPLETE_OR_MISMATCH');
  const expectedIds = record.reviews
    .flatMap((r, i) => r.feasibilityFindings.map((_, j) => 'review-' + i + '-' + j))
    .concat(
      expected.plays.filter((p) => p.status === 'uncleared').map((p) => 'failed-' + p.playId),
    );
  if (
    !same(
      record.verifiedFindings.map((f) => f.findingId),
      expectedIds,
    )
  )
    throw new Error('MISSING_VERIFICATION');
  const evidence = {
    source: expected.source,
    candidate: expected.candidate,
    plays: expected.plays,
  };
  if (artifactDigest(expected.candidate) !== record.candidateDigest)
    throw new Error('EVALUATION_ARTIFACT_MISMATCH');
  const refs = expected.plays.flatMap((p) => p.turns.map((_, i) => p.playId + ':' + turnId(p, i)));
  const fingerprints = record.reviews.map((r) => r.segments.map((s) => s.inputDigest).join(':'));
  if (new Set(fingerprints).size !== 1) throw new Error('INDEPENDENT_REVIEW_INPUT_MISMATCH');
  for (const review of record.reviews) {
    if (
      !review.segments.length ||
      !same(
        review.segments.flatMap((s) => s.turnRefs.map((r) => r.playId + ':' + r.turnId)),
        refs,
      )
    )
      throw new Error('REVIEW_COVERAGE_MISSING');
    for (const assessment of [review, ...review.segments.map((s) => s.review)]) {
      validateEvidence(assessment.feasibilityEvidence, evidence);
      for (const finding of assessment.feasibilityFindings)
        validateEvidence(finding.evidence, evidence);
      for (const score of Object.values(assessment.funScores)) {
        if (score.score !== null && !score.evidence.length) throw new Error('UNSUPPORTED_SCORE');
        validateEvidence(score.evidence, evidence);
      }
    }
  }
  for (const finding of record.verifiedFindings) {
    if (
      finding.blocking !== (finding.classification !== 'player_miss') ||
      finding.repairable !== (finding.classification === 'confirmed_scenario_defect')
    )
      throw new Error('INVALID_VERIFIED_CLASSIFICATION');
    validateEvidence([...finding.evidence, ...finding.counterEvidence], evidence);
    const origin = record.reviews
      .flatMap((r, i) =>
        r.feasibilityFindings.map((f, j) => ({
          id: 'review-' + i + '-' + j,
          evidence: f.evidence,
        })),
      )
      .find((f) => f.id === finding.findingId);
    const referenced = new Set(
      origin?.evidence.filter((ref) => ref.kind === 'turn').map((ref) => ref.playId) ??
        expected.plays
          .filter((p) => 'failed-' + p.playId === finding.findingId)
          .map((p) => p.playId),
    );
    const expectedRefs = expected.plays
      .filter((p) => referenced.has(p.playId))
      .flatMap((p) => p.turns.map((_, i) => p.playId + ':' + turnId(p, i)));
    if (
      !finding.segments.length ||
      !same(
        finding.segments.flatMap((s) => s.turnRefs.map((ref) => ref.playId + ':' + ref.turnId)),
        expectedRefs,
      )
    )
      throw new Error('VERIFICATION_COVERAGE_MISSING');
    for (const segment of finding.segments) {
      if (segment.finding.findingId !== finding.findingId)
        throw new Error('VERIFICATION_FINDING_MISMATCH');
      validateEvidence([...segment.finding.evidence, ...segment.finding.counterEvidence], evidence);
    }
  }
  return record;
}

/** Deliberately synthetic: no claim of real model review or game enjoyment. */
export function createMockEvaluationClient(): AIResponsesClient {
  return {
    respond: async (body: unknown) => {
      const request = body as { model: string; input: { content: { text: string }[] }[] };
      const payload = decodeEvaluationInput(request.input[0]!.content[0]!.text) as {
        findings?: { id: string; evidence: unknown[] }[];
      };
      const evidence = [{ kind: 'pointer', document: 'candidate', pointer: '/openingOverview' }];
      const score = {
        score: null,
        rationale: 'Synthetic transport fixture; not an enjoyment evaluation.',
        evidence: [],
        suggestions: [],
      };
      const output =
        request.model === 'gpt-6-astra'
          ? {
              findings: (payload.findings ?? []).map((f) => ({
                findingId: f.id,
                classification: 'player_miss',
                reason: 'Synthetic verification fixture only',
                evidence: f.evidence,
                counterEvidence: [],
                counterEvidenceReason: 'No real verification was performed by this mock.',
              })),
            }
          : {
              feasibilityFindings: [],
              feasibilityEvidence: evidence,
              funScores: {
                investigationDesire: score,
                inferenceFromInformation: score,
                satisfyingDiscovery: score,
                conversationValue: score,
              },
            };
      return {
        model: request.model,
        status: 'completed',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] },
        ],
      };
    },
  };
}
