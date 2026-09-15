import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, basename, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseCoreConfig } from '../../../packages/shared/core-config.js';
import { freezeSource, validateSource, sha256, canonical } from './source.js';
import { EXPANSION_PRICING } from './usage.js';
import { loadPlayerPrompts } from './player.js';
import { loadEvaluationPrompts } from './evaluate.js';
import { loadInvestigationPrompts } from '../../../apps/local-server/investigation-prompts.js';
const text = z.string().min(1).max(2000),
  id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const model = z.enum(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
export const expansionConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourcePath: text,
    candidateIndex: z.number().int().nonnegative(),
    coreConfigPath: text,
    locale: z.enum(['ja', 'en']),
    initiative: z.enum(['observations', 'hypotheses', 'suggestions']),
    generator: z
      .object({
        model: z.literal('gpt-6-astra'),
        reasoningEffort: z.enum(['low', 'medium', 'high']),
        maxOutputTokens: z.number().int().min(1).max(60000),
      })
      .strict(),
    playerModels: z.array(model).length(3),
    personas: z.array(z.enum(['investigation', 'broad', 'early'])).length(3),
    gameModel: model,
    maxTurns: z.number().int().min(1).max(25),
    objectCatalog: z
      .array(
        z.object({ id, name: text, ordinaryProperties: z.array(text).min(1).max(20) }).strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const values of [c.playerModels, c.personas, c.objectCatalog.map((i) => i.id)])
      if (new Set(values).size !== values.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate configuration entry' });
  });
export type ExpansionConfig = z.infer<typeof expansionConfigSchema>;
export async function readExpansionText(path: string, max = 256 * 1024): Promise<string> {
  if (basename(path).startsWith('.env') || path.includes('://'))
    throw new Error('CONFIG_PATH_INVALID');
  const info = await stat(path);
  if (!info.isFile() || info.size > max) throw new Error('CONFIG_SIZE');
  const data = await readFile(path, 'utf8');
  if (Buffer.byteLength(data) > max) throw new Error('CONFIG_SIZE');
  return data;
}
export async function loadExpansionConfig(path: string) {
  if (extname(path).toLowerCase() !== '.json') throw new Error('CONFIG_JSON_REQUIRED');
  const absolute = resolve(path),
    config = expansionConfigSchema.parse(JSON.parse(await readExpansionText(absolute)));
  const source = freezeSource(
    await readExpansionText(resolve(dirname(absolute), config.sourcePath)),
    config.candidateIndex,
  );
  const coreConfig = parseCoreConfig(
    JSON.parse(await readExpansionText(resolve(dirname(absolute), config.coreConfigPath))),
  );
  const generatorPrompt = await readExpansionText(
    fileURLToPath(new URL('./prompts/generator.md', import.meta.url)),
  );
  for (const name of [config.generator.model, config.gameModel, ...config.playerModels])
    if (!EXPANSION_PRICING.models[name]) throw new Error('UNKNOWN_MODEL_PRICE');
  const playerPrompts = loadPlayerPrompts(),
    investigationPrompts = loadInvestigationPrompts(),
    evaluationPrompts = loadEvaluationPrompts();
  return {
    config,
    source,
    coreConfig,
    generatorPrompt,
    playerPrompts,
    investigationPrompts,
    evaluationPrompts,
    configDigest: sha256(canonical({ config, coreConfig })),
    catalogDigest: sha256(canonical(config.objectCatalog)),
    promptDigests: {
      generator: sha256(generatorPrompt),
      ...Object.fromEntries(
        Object.entries(evaluationPrompts).map(([name, text]) => [
          'evaluation/' + name,
          sha256(text),
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(playerPrompts).map(([name, text]) => ['player/' + name, sha256(text)]),
      ),
      ...Object.fromEntries(
        Object.entries(investigationPrompts).map(([name, text]) => [
          'investigation/' + name,
          sha256(text),
        ]),
      ),
    },
  };
}
export type ExpansionInput = Awaited<ReturnType<typeof loadExpansionConfig>>;
export async function codeIdentity() {
  const run = promisify(execFile),
    paths = [
      'apps',
      'packages',
      'tools',
      'tests',
      'config',
      'scenarios',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'tsconfig.server.json',
    ];
  const revision = (
    await run('git', ['rev-parse', 'HEAD'], { maxBuffer: 1024 * 1024 })
  ).stdout.trim();
  const diff = (
    await run('git', ['diff', '--binary', 'HEAD', '--', ...paths], { maxBuffer: 32 * 1024 * 1024 })
  ).stdout;
  const untracked = (
    await run('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths], {
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout
    .split('\0')
    .filter(Boolean)
    .sort();
  const files = [];
  for (const path of untracked) {
    if (basename(path).startsWith('.env')) continue;
    files.push({ path, digest: sha256(await readExpansionText(path, 2 * 1024 * 1024)) });
  }
  return { codeRevision: revision, dirtyDigest: sha256(canonical({ diff, files })) };
}

export function parseSavedExpansionInput(value: unknown): ExpansionInput {
  const raw = value as ExpansionInput;
  if (!raw || typeof raw !== 'object') throw new Error('SAVED_INPUT_INVALID');
  const config = expansionConfigSchema.parse(raw.config),
    source = validateSource(raw.source),
    coreConfig = parseCoreConfig(raw.coreConfig);
  const prompt = z
    .string()
    .min(1)
    .max(12000)
    .refine((value) => value.trim().length > 0);
  const generatorPrompt = prompt.parse(raw.generatorPrompt);
  const playerPrompts = z
    .object({ base: prompt, investigation: prompt, broad: prompt, early: prompt })
    .strict()
    .parse(raw.playerPrompts);
  const investigationPrompts = z
    .object({
      selection: prompt,
      response: prompt,
      observations: prompt,
      hypotheses: prompt,
      suggestions: prompt,
    })
    .strict()
    .parse(raw.investigationPrompts);
  const evaluationPrompts = z
    .object({ review: prompt, verify: prompt, repair: prompt })
    .strict()
    .parse(raw.evaluationPrompts);
  const configDigest = sha256(canonical({ config, coreConfig })),
    catalogDigest = sha256(canonical(config.objectCatalog));
  const promptDigests = {
    generator: sha256(generatorPrompt),
    ...Object.fromEntries(
      Object.entries(playerPrompts).map(([name, text]) => ['player/' + name, sha256(text)]),
    ),
    ...Object.fromEntries(
      Object.entries(investigationPrompts).map(([name, text]) => [
        'investigation/' + name,
        sha256(text),
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(evaluationPrompts).map(([name, text]) => ['evaluation/' + name, sha256(text)]),
    ),
  };
  if (
    raw.configDigest !== configDigest ||
    raw.catalogDigest !== catalogDigest ||
    canonical(raw.promptDigests) !== canonical(promptDigests)
  )
    throw new Error('SAVED_INPUT_DIGEST_MISMATCH');
  return {
    config,
    source,
    coreConfig,
    generatorPrompt,
    playerPrompts,
    investigationPrompts,
    evaluationPrompts,
    configDigest,
    catalogDigest,
    promptDigests,
  };
}
