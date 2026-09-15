import {
  evaluationSource,
  evaluationOutputSchema,
  encodeEvaluationInput,
} from './evaluation-input.js';
import { validateEvaluationForAdoption } from './evaluate.js';
import { randomUUID } from 'node:crypto';
import type { AIResponsesClient } from '../../../apps/local-server/game-ai.js';
import { ExpansionBudget, MeasuredResponsesClient } from './budget.js';
import { ExpansionStore, artifactDigest, conditionsDigest } from './store.js';
import { expansionProposalSchema, parseResponseObject } from './generator.js';
import { evaluationRecordSchema } from './evaluation-schema.js';
import {
  parseExpansionCandidate,
  type ExpansionCandidate,
  type SourceSnapshot,
} from './schemas.js';
import type { EvaluationManifest, PlayCheckpoint } from './store-schema.js';
import { compileExpandedScenario } from './compile.js';
import { sha256 } from './source.js';
/** One revision only; never starts a play or mutates the parent run. */
export async function repairCandidate(input: {
  root: string;
  source: SourceSnapshot;
  candidate: ExpansionCandidate;
  manifest: EvaluationManifest;
  plays: PlayCheckpoint[];
  evaluation: unknown;
  client: AIResponsesClient;
  budget: ExpansionBudget;
  prompt: string;
  signal?: AbortSignal;
}) {
  const evaluation = evaluationRecordSchema.parse(input.evaluation),
    parent = input.candidate;
  if (parent.revision >= 3) throw new Error('REPAIR_LIMIT');
  if (
    evaluation.status !== 'complete' ||
    evaluation.candidateDigest !== artifactDigest(parent) ||
    evaluation.conditionsDigest !== conditionsDigest(input.manifest.conditions) ||
    evaluation.revision !== parent.revision ||
    input.manifest.conditions.candidateDigest !== artifactDigest(parent)
  )
    throw new Error('REPAIR_EVALUATION_MISMATCH');
  if (input.manifest.conditions.promptDigests['evaluation/repair'] !== sha256(input.prompt))
    throw new Error('REPAIR_PROMPT_MISMATCH');
  validateEvaluationForAdoption(evaluation, {
    candidateDigest: artifactDigest(parent),
    conditionsDigest: conditionsDigest(input.manifest.conditions),
    source: input.source,
    candidate: parent,
    plays: input.plays,
    expectedPlayIds: input.plays.map((p) => p.playId),
    allowUnresolved: true,
  });
  const findings = evaluation.verifiedFindings.filter(
    (f) => f.classification === 'confirmed_scenario_defect' && f.repairable && f.blocking,
  );
  if (!findings.length) throw new Error('NO_CONFIRMED_SCENARIO_DEFECT');
  const repairFindings = [
    ...new Map(
      findings.map((f) => {
        const detail = {
          reason: f.reason,
          evidence: f.evidence,
          counterEvidence: f.counterEvidence,
          counterEvidenceReason: f.counterEvidenceReason,
        };
        return [JSON.stringify(detail), detail];
      }),
    ).values(),
  ];
  const manifest: EvaluationManifest = {
    ...input.manifest,
    runId: randomUUID(),
    parentRunId: input.manifest.runId,
    conditions: { ...input.manifest.conditions, revision: parent.revision + 1 },
    stage: 'expanding',
    plays: [],
    callIds: [],
  };
  const draft = await ExpansionStore.createDraft(input.root, manifest, input.source);
  try {
    const client = new MeasuredResponsesClient(
      input.client,
      input.budget,
      () => ({ role: 'expansion_repair', revision: parent.revision + 1 }),
      (c) => draft.saveCall(c),
    );
    const response = await client.respond(
      {
        model: 'gpt-6-astra',
        max_output_tokens: 24000,
        store: false,
        instructions: input.prompt,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: encodeEvaluationInput({
                  source: evaluationSource(input.source),
                  candidate: parent,
                  findings: repairFindings,
                }),
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'expansion_repair',
            strict: true,
            schema: evaluationOutputSchema(expansionProposalSchema),
          },
        },
      },
      input.signal,
    );
    const proposal = expansionProposalSchema.parse(parseResponseObject(response));
    const candidate = parseExpansionCandidate({
      ...proposal,
      schemaVersion: 1,
      candidateId: parent.candidateId,
      revision: parent.revision + 1,
      parentDigest: artifactDigest(parent),
      sourceDigest: parent.sourceDigest,
      originalInvariantDigest: parent.originalInvariantDigest,
    });
    compileExpandedScenario(input.source, candidate);
    const store = await draft.finalize(candidate);
    await store.setStage('awaiting_pilot');
    return { candidate, store, stage: 'awaiting_pilot' as const };
  } catch (error) {
    await draft.fail('incomplete');
    throw error;
  }
}
