import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  missionConfigSchema,
  missionContractSchema,
  contractProposalSchema,
  type MissionConfig,
  type InputSnapshot,
  type ContractProposal,
  type MissionContract,
} from './schemas.js';

export const topTierModels = ['gpt-6-astra'] as const;
const supportedModels = new Set(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
export function stableStringify(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    return item;
  };
  return JSON.stringify(normalize(value));
}
export function digestValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
export function parseConfig(input: unknown): MissionConfig {
  const config = missionConfigSchema.parse(input);
  if (new Set(config.objectCatalog.map((item) => item.id)).size !== config.objectCatalog.length)
    throw new Error('CONFIG_INVALID: objectCatalog IDs must be unique');
  for (const role of [
    'contractGenerator',
    'contractChecker',
    'storyGenerator',
    'repairer',
    'verifier',
  ] as const) {
    if (!(topTierModels as readonly string[]).includes(config.models[role].model))
      throw new Error('CONFIG_INVALID: ' + role + ' requires a supported top-tier model');
  }
  for (const settings of Object.values(config.models)) {
    if (!supportedModels.has(settings.model)) throw new Error('CONFIG_INVALID: unsupported model');
    if (settings.maxOutputTokens > config.limits.maxOutputTokensTotal)
      throw new Error('CONFIG_INVALID: role output reservation exceeds total budget');
  }
  return config;
}
async function boundedRead(filePath: string, maxBytes: number): Promise<string> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size > maxBytes)
    throw new Error('CONFIG_INVALID: input file exceeds size limit');
  const content = await readFile(filePath, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > maxBytes)
    throw new Error('CONFIG_INVALID: input file exceeds size limit');
  return content;
}
export async function loadConfig(configPath: string): Promise<InputSnapshot> {
  const absolute = path.resolve(configPath);
  if (path.extname(absolute).toLowerCase() !== '.json')
    throw new Error('CONFIG_INVALID: config must be JSON');
  const config = parseConfig(JSON.parse(await boundedRead(absolute, 256 * 1024)));
  const references: InputSnapshot['references'] = [];
  let remainingBytes = config.limits.maxInputBytesPerCall;
  for (const reference of config.referenceScenarios) {
    if (
      reference.includes('://') ||
      !['.md', '.json', '.txt'].includes(path.extname(reference).toLowerCase()) ||
      path.basename(reference).startsWith('.env')
    )
      throw new Error('CONFIG_INVALID: reference must be an explicit local document');
    const referencePath = path.resolve(path.dirname(absolute), reference);
    const content = await boundedRead(referencePath, remainingBytes);
    remainingBytes -= Buffer.byteLength(content, 'utf8');
    references.push({ path: reference, content });
  }
  return { config, references };
}
export function assembleContract(
  config: MissionConfig,
  proposal: ContractProposal,
  inputDigest: string,
): MissionContract {
  return missionContractSchema.parse({
    ...contractProposalSchema.parse(proposal),
    schemaVersion: 1,
    inputDigest,
    world: config.world,
    difficulty: config.difficulty,
    objectCatalog: config.objectCatalog,
  });
}
