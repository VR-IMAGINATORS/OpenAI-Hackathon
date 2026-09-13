import { resolve } from 'node:path';
import { parseScenario, parseScenarioV2 } from '../packages/shared/scenario.js';
import { parseCoreConfig } from '../packages/shared/core-config.js';
import { readConfigJson } from '../apps/server/scenario-catalog.js';

const explicit = process.argv[2] ?? process.env.SCENARIO_PATH;
const paths = explicit ? [explicit] : ['scenarios/default.json', 'scenarios/mobile-playtest.json'];
try {
  for (const path of paths) {
    const raw = readConfigJson(resolve(path));
    const scenario =
      (raw as { version?: unknown })?.version === 2 ? parseScenarioV2(raw) : parseScenario(raw);
    console.log(
      `Scenario v${scenario.version} OK: ${scenario.id} (${scenario.obstacles.length} obstacles)`,
    );
  }
  parseCoreConfig(readConfigJson(resolve('config/game-core.json')));
  console.log('Game core config OK');
} catch (error) {
  console.error(
    'シナリオ設定を確認してください:',
    error instanceof Error ? error.message : 'invalid JSON',
  );
  process.exitCode = 1;
}
