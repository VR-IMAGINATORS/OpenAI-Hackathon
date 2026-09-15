import { createHash, randomInt } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCENE_ACTION_BUDGET } from '../../packages/server/ai-config.js';
import {
  difficultySchema,
  difficultyPresets,
  type Difficulty,
} from '../../packages/shared/difficulty.js';
import {
  localizeScenario,
  parseScenarioV2,
  publicScenario,
  type PublicScenario,
  type ScenarioV2,
} from '../../packages/shared/scenario.js';
import {
  compileStoryScenario,
  parseStoryCatalog,
  storyCandidateCount,
  type StoryCatalog,
} from '../../packages/shared/story-catalog.js';
import {
  parseCoreConfig,
  localeSchema,
  type CoreConfig,
  type Locale,
} from '../../packages/shared/core-config.js';

const MAX_CONFIG_BYTES = 256 * 1024;
export const DEFAULT_SCENARIO_PATH = 'scenarios/playtest/warehouse-expanded-r1.json';
export function parseScenarioSource(value: unknown): ScenarioV2 | StoryCatalog {
  return (value as { version?: unknown } | null)?.version === 3
    ? parseStoryCatalog(value)
    : parseScenarioV2(value);
}
export interface ScenarioSnapshot {
  readonly difficulty?: Difficulty;
  readonly digest: string;
  readonly locale: Locale;
  readonly scenarioV2: ScenarioV2;
  readonly coreConfig: CoreConfig;
  readonly createdAt: number;
}
export class ScenarioConfigError extends Error {
  readonly code = 'CONFIG_INVALID';
  readonly status = 503;
  constructor() {
    super('シナリオまたは共通設定が不正です。');
  }
}
/** Bounded even if the file grows between stat and read. Never accepts HTTP-supplied paths. */
export function readConfigJson(path: string): unknown {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error('CONFIG_SIZE');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_CONFIG_BYTES) throw new Error('CONFIG_SIZE');
    return JSON.parse(
      buffer
        .subarray(0, length)
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    );
  } finally {
    closeSync(fd);
  }
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
export class ScenarioCatalog {
  private readonly scenarioPath: string;
  private readonly coreConfigPath: string;
  constructor(
    private readonly options: {
      scenarioPath: string;
      coreConfigPath: string;
      maxGenerationAttemptsPerPlay?: number;
      randomIndex?: (candidateCount: number) => number;
      playTtlMs?: number;
      lifecycleReserveMs?: number;
      now?: () => number;
    },
  ) {
    this.scenarioPath = resolve(options.scenarioPath);
    this.coreConfigPath = resolve(options.coreConfigPath);
  }
  private validateBudgets(rules: ScenarioV2['rules']) {
    const needed = 2 * (SCENE_ACTION_BUDGET + 2);
    if (needed > (this.options.maxGenerationAttemptsPerPlay ?? 100))
      throw new Error('IMAGE_BUDGET');
    if (
      this.options.playTtlMs !== undefined &&
      rules.totalTimeSeconds * 1000 + (this.options.lifecycleReserveMs ?? 132_000) >
        this.options.playTtlMs
    )
      throw new Error(
        'SCENARIO_TIME_BUDGET: rules.totalTimeSeconds must fit PLAY_TTL_SECONDS with connection, waiting and closing allowances',
      );
  }
  private read() {
    const source = parseScenarioSource(readConfigJson(this.scenarioPath));
    const coreConfig = parseCoreConfig(readConfigJson(this.coreConfigPath));
    this.validateBudgets(source.rules);
    return { source, coreConfig };
  }
  /** Startup validation keeps field-level errors visible to the planner. */
  validate(): void {
    this.read();
  }
  /** Public overview never draws a scene or exposes its clue/obstacles. */
  preview(locale: Locale): PublicScenario {
    try {
      localeSchema.parse(locale);
      const { source } = this.read();
      return source.version === 3
        ? {
            id: source.id,
            title: source.title[locale],
            playerBriefing: source.playerBriefing[locale],
            rules: structuredClone(source.rules),
            obstacleCount: 3,
          }
        : publicScenario(localizeScenario(source, locale));
    } catch {
      throw new ScenarioConfigError();
    }
  }
  /** Every new play gets a fresh parse. Old snapshots never change or fall back silently. */
  current(locale: Locale, difficulty?: Difficulty): ScenarioSnapshot {
    try {
      localeSchema.parse(locale);
      const { source, coreConfig } = this.read();
      let scenarioV2: ScenarioV2;
      if (source.version === 3) {
        const count = storyCandidateCount(source);
        const selected = (this.options.randomIndex ?? randomInt)(count);
        if (!Number.isInteger(selected) || selected < 0 || selected >= count)
          throw new Error('INVALID_SCENARIO_SELECTION');
        scenarioV2 = compileStoryScenario(source, selected);
      } else scenarioV2 = source;
      if (difficulty !== undefined) {
        const preset = difficultyPresets[difficultySchema.parse(difficulty)];
        scenarioV2 = parseScenarioV2({
          ...scenarioV2,
          rules: {
            ...scenarioV2.rules,
            totalTimeSeconds: preset.totalTimeSeconds,
            initialCredits: preset.initialCredits,
          },
        });
        this.validateBudgets(scenarioV2.rules);
      }
      const digest = createHash('sha256')
        .update(JSON.stringify({ locale, difficulty, scenarioV2, coreConfig }))
        .digest('hex');
      return freezeDeep({
        digest,
        locale,
        ...(difficulty === undefined ? {} : { difficulty }),
        scenarioV2,
        coreConfig,
        createdAt: (this.options.now ?? Date.now)(),
      });
    } catch {
      throw new ScenarioConfigError();
    }
  }
}
