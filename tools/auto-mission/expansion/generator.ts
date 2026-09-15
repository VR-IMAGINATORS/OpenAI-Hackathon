import { z } from 'zod';
import type { AIResponsesClient } from '../../../apps/local-server/game-ai.js';
import { scenarioKnowledgeEntrySchema } from '../../../packages/shared/harness.js';
import { strictOutputSchema } from '../provider.js';
import {
  expansionCandidateSchema,
  key,
  parseExpansionCandidate,
  type ExpansionCandidate,
  type SourceSnapshot,
} from './schemas.js';
import { compileExpandedScenario } from './compile.js';
import type { ExpansionInput } from './config.js';
export const expansionProposalSchema = expansionCandidateSchema
  .omit({
    schemaVersion: true,
    candidateId: true,
    revision: true,
    parentDigest: true,
    sourceDigest: true,
    originalInvariantDigest: true,
  })
  .extend({
    knowledgeAdditions: z
      .array(scenarioKnowledgeEntrySchema.safeExtend({ observationTargetId: key }))
      .max(100),
  });
export class GeneratorValidationError extends Error {
  constructor(readonly output: unknown) {
    super('GENERATION_REJECTED');
  }
}
export type ExpansionProposal = z.infer<typeof expansionProposalSchema>;
export function candidateFromProposal(
  source: SourceSnapshot,
  proposalValue: unknown,
): ExpansionCandidate {
  const proposal = expansionProposalSchema.parse(proposalValue);
  return parseExpansionCandidate({
    ...proposal,
    schemaVersion: 1,
    candidateId: 'expanded-' + source.sourceDigest.slice(0, 16),
    revision: 1,
    parentDigest: null,
    sourceDigest: source.sourceDigest,
    originalInvariantDigest: source.originalInvariantDigest,
  });
}
export function parseResponseObject(value: unknown): unknown {
  const data = value as {
    status?: unknown;
    output?: { type?: unknown; content?: { type?: unknown; text?: unknown }[] }[];
  };
  if (data?.status !== 'completed' || !Array.isArray(data.output))
    throw new Error('GENERATOR_RESPONSE_INCOMPLETE');
  const content = data.output.flatMap((item) =>
    item.type === 'message' && Array.isArray(item.content) ? item.content : [],
  );
  if (content.some((item) => item.type === 'refusal')) throw new Error('GENERATOR_REFUSAL');
  const texts = content.filter(
    (item) => item.type === 'output_text' && typeof item.text === 'string',
  );
  if (texts.length !== 1) throw new Error('GENERATOR_OUTPUT_INVALID');
  return JSON.parse(texts[0]!.text as string);
}
export async function generateCandidate(
  input: ExpansionInput,
  client: AIResponsesClient,
  signal?: AbortSignal,
) {
  if (input.config.generator.model !== 'gpt-6-astra')
    throw new Error('GENERATOR_TOP_TIER_REQUIRED');
  const raw = JSON.parse(input.source.rawCatalogText) as {
    scenes: { id: string }[];
    gimmicks: { id: string }[];
  };
  // The compiled scenario already contains shared world, scene, mechanics and states.
  // Add only the source records omitted by compilation, rather than duplicating all prose.
  const generationInput = {
    selection: input.source.selection,
    compiledOriginal: input.source.compiledOriginal,
    referenceSolutions: input.source.originalSections.gimmicks.map((g) => ({
      id: g.id,
      referenceSolutions: g.referenceSolutions,
    })),
    referenceItems: input.source.originalSections.shared.items,
    pointers: {
      scene: '/scenes/' + raw.scenes.findIndex((s) => s.id === input.source.selection.sceneId),
      gimmicks: input.source.selection.obstacleIds.map(
        (id) => '/gimmicks/' + raw.gimmicks.findIndex((g) => g.id === id),
      ),
    },
  };
  const settings = input.config.generator;
  const response = await client.respond(
    {
      model: settings.model,
      reasoning: { effort: settings.reasoningEffort },
      max_output_tokens: settings.maxOutputTokens,
      store: false,
      instructions: input.generatorPrompt,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(generationInput) }] },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'expansion_generator',
          strict: true,
          schema: strictOutputSchema(expansionProposalSchema),
        },
      },
    },
    signal,
  );
  let proposal: unknown;
  try {
    proposal = parseResponseObject(response);
    const candidate = candidateFromProposal(input.source, proposal);
    return { candidate, compiled: compileExpandedScenario(input.source, candidate) };
  } catch {
    throw new GeneratorValidationError(proposal ?? null);
  }
}
/** Deterministic fixture for transport/control tests, never a real generation result. */
export function mockExpansionProposal(source: SourceSnapshot): ExpansionProposal {
  const first = source.originalSections.gimmicks[0] as { name: { ja: string; en: string } };
  const overview = {
    ja: first.name.ja + 'の近くから、周囲の様子を確かめられそうだ。',
    en: 'I can begin by investigating the ' + first.name.en + '.',
  };
  const proposal: ExpansionProposal = {
    openingOverview: overview,
    expandedStory: [
      {
        id: 'opening',
        title: source.compiledOriginal.title,
        body: source.compiledOriginal.premise,
      },
    ],
    knowledgeAdditions: [],
    observationTargets: [],
    knowledgeMetadata: [],
    displayOverrides: [{ path: '/playerBriefing', value: overview }],
    ambienceSlots: [],
    publicVisuals: [],
    changeMap: [],
  };
  source.compiledOriginal.knowledge.forEach((entry, index) => {
    if (!entry.observationTargetId) return;
    const hint = source.originalSections.gimmicks.some(
      (g) =>
        Array.isArray(g.hints) &&
        (g.hints as unknown[]).some(
          (h) => JSON.stringify(h) === JSON.stringify(entry.localizedText),
        ),
    );
    proposal.knowledgeMetadata.push({
      knowledgeId: entry.id,
      targetId: entry.observationTargetId,
      layer: hint ? 'hint' : 'overview',
    });
    if (
      entry.revealMode === 'automatic' &&
      entry.prerequisites.some(
        (p) => p.factKey === entry.observationTargetId && p.value === 'blocked',
      )
    ) {
      const target = source.originalSections.gimmicks.find(
        (g) => g.id === entry.observationTargetId,
      ) as { name: { ja: string; en: string } };
      proposal.displayOverrides.push({
        path: '/knowledge/' + index + '/localizedText',
        value: target.name,
      });
      const detail = {
        ...entry,
        id: entry.id + '-detail',
        revealMode: 'on_request' as const,
        observationTargetId: entry.observationTargetId,
      };
      proposal.knowledgeAdditions.push(detail);
      proposal.knowledgeMetadata.push({
        knowledgeId: detail.id,
        targetId: entry.observationTargetId,
        layer: 'detail',
      });
    }
  });
  return expansionProposalSchema.parse(proposal);
}
export function mockGeneratorClient(source: SourceSnapshot): AIResponsesClient {
  return {
    respond: async (body: unknown) => ({
      model: (body as { model: string }).model,
      status: 'completed',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(mockExpansionProposal(source)) }],
        },
      ],
    }),
  };
}
