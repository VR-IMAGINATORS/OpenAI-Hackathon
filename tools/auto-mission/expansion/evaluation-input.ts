import type { EvaluationEvidence } from './verify.js';
import type { PlayCheckpoint } from './store-schema.js';
export function turnId(play: PlayCheckpoint, index: number): string {
  const turn = play.turns[index] as { id?: unknown; turnId?: unknown; index?: unknown };
  if (typeof turn?.id === 'string') return turn.id;
  return typeof turn?.turnId === 'string' ? turn.turnId : String(turn?.index ?? index + 1);
}
/** Preserve original pointer paths while omitting unselected catalog text and duplicate prose. */
export function evaluationSource(source: EvaluationEvidence['source']) {
  return {
    sourceDigest: source.sourceDigest,
    selection: source.selection,
    compiledOriginal: source.compiledOriginal,
    originalSections: {
      gimmicks: source.originalSections.gimmicks.map((g) => ({
        id: g.id,
        referenceSolutions: g.referenceSolutions,
      })),
    },
  };
}
export function evidencePayload(input: EvaluationEvidence) {
  return {
    source: evaluationSource(input.source),
    candidate: input.candidate,
    plays: input.plays,
    turnReferences: input.plays.map((p) => ({
      playId: p.playId,
      turnIds: p.turns.map((_, i) => turnId(p, i)),
    })),
  };
}
import { z } from 'zod';
import { strictOutputSchema } from '../provider.js';
/** Reference repeated schema nodes instead of resending each evidence shape six times. */
export function evaluationOutputSchema(schema: z.ZodType, evidence?: EvaluationEvidence) {
  strictOutputSchema(schema);
  const json = z.toJSONSchema(schema, { target: 'draft-7', reused: 'ref' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  if (evidence) {
    const sourcePointers = [
      '/selection',
      '/compiledOriginal',
      '/compiledOriginal/setting',
      '/compiledOriginal/story',
      '/compiledOriginal/rules',
      '/compiledOriginal/obstacles',
      '/compiledOriginal/knowledge',
      '/originalSections/gimmicks',
      ...evidence.source.compiledOriginal.obstacles.map(
        (_, i) => '/compiledOriginal/obstacles/' + i,
      ),
      ...evidence.source.compiledOriginal.knowledge.map(
        (_, i) => '/compiledOriginal/knowledge/' + i,
      ),
      ...evidence.source.originalSections.gimmicks.map(
        (_, i) => '/originalSections/gimmicks/' + i + '/referenceSolutions',
      ),
    ];
    const candidatePointers = Object.entries(evidence.candidate).flatMap(([key, value]) => [
      '/' + key,
      ...(Array.isArray(value) ? value.map((_, i) => '/' + key + '/' + i) : []),
    ]);
    const constrain = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.map(constrain);
      const node = value as Record<string, any>;
      if (node.properties?.kind?.const === 'pointer') {
        return {
          anyOf: [
            ['source', sourcePointers],
            ['candidate', candidatePointers],
          ].map(([document, pointers]) => ({
            ...node,
            properties: {
              ...node.properties,
              document: { type: 'string', const: document },
              pointer: { type: 'string', enum: pointers },
            },
          })),
        };
      }
      return Object.fromEntries(
        Object.entries(node).map(([key, child]) => [key, constrain(child)]),
      );
    };
    return constrain(json) as Record<string, unknown>;
  }
  return json;
}
/** Lossless dictionary encoding of repeated long values, including before/after state snapshots. */
export function encodeEvaluationInput(value: unknown): string {
  const counts = new Map<string, number>();
  const visit = (v: unknown) => {
    if (typeof v !== 'string' && (!v || typeof v !== 'object')) return;
    const key = JSON.stringify(v);
    if (key.length >= 100) counts.set(key, (counts.get(key) ?? 0) + 1);
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(value);
  const values = [...counts].filter(([, count]) => count > 1).map(([key]) => key);
  const indices = new Map(values.map((key, index) => [key, index]));
  const transform = (v: unknown, allowRef = true): unknown => {
    if (typeof v === 'string' || (v && typeof v === 'object')) {
      const index = indices.get(JSON.stringify(v));
      if (allowRef && index !== undefined) return { $ref: '#/sharedValues/' + index };
    }
    if (Array.isArray(v)) return v.map((item) => transform(item));
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, transform(item)]));
    return v;
  };
  const original = JSON.stringify(value);
  const packed = JSON.stringify({
    encoding:
      'Lossless JSON references. Recursively replace each {$ref:"#/sharedValues/N"} with sharedValues[N]. Evaluate the decoded data; evidence pointers always refer to original source/candidate paths, not sharedValues.',
    sharedValues: values.map((key) => transform(JSON.parse(key), false)),
    data: transform(value),
  });
  return Buffer.byteLength(packed) < Buffer.byteLength(original) ? packed : original;
}
export function decodeEvaluationInput(text: string): unknown {
  const root = JSON.parse(text) as { sharedValues?: unknown[]; data?: unknown };
  if (!Array.isArray(root.sharedValues)) return root;
  const expand = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(expand);
    const obj = v as Record<string, unknown>;
    if (typeof obj.$ref === 'string' && /^#\/sharedValues\/\d+$/.test(obj.$ref))
      return expand(root.sharedValues![Number(obj.$ref.split('/').at(-1))]);
    return Object.fromEntries(Object.entries(obj).map(([k, item]) => [k, expand(item)]));
  };
  return expand(root.data);
}
