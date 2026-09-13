import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseScenarioV2, type ScenarioV2 } from '../../packages/shared/scenario.js';
import {
  parseCoreConfig,
  localeSchema,
  type CoreConfig,
  type Locale,
} from '../../packages/shared/core-config.js';

const MAX_CONFIG_BYTES = 256 * 1024;
export interface ScenarioSnapshot {
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
      now?: () => number;
    },
  ) {
    this.scenarioPath = resolve(options.scenarioPath);
    this.coreConfigPath = resolve(options.coreConfigPath);
  }
  /** Every new play gets a fresh parse. Old snapshots never change or fall back silently. */
  current(locale: Locale): ScenarioSnapshot {
    try {
      localeSchema.parse(locale);
      const scenarioV2 = parseScenarioV2(readConfigJson(this.scenarioPath));
      const coreConfig = parseCoreConfig(readConfigJson(this.coreConfigPath));
      const needed = 2 * (scenarioV2.rules.maxActions + 2);
      if (needed > (this.options.maxGenerationAttemptsPerPlay ?? 100))
        throw new Error('IMAGE_BUDGET');
      const digest = createHash('sha256')
        .update(JSON.stringify({ locale, scenarioV2, coreConfig }))
        .digest('hex');
      return freezeDeep({
        digest,
        locale,
        scenarioV2,
        coreConfig,
        createdAt: (this.options.now ?? Date.now)(),
      });
    } catch {
      throw new ScenarioConfigError();
    }
  }
}
