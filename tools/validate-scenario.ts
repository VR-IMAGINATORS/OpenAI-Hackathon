import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseScenario } from '../packages/shared/scenario.js';

const path = resolve(process.argv[2] ?? process.env.SCENARIO_PATH ?? 'scenarios/default.json');
try {
  const scenario = parseScenario(JSON.parse(await readFile(path, 'utf8')));
  console.log(`Scenario OK: ${scenario.id} (${scenario.obstacles.length} obstacles)`);
} catch (error) {
  console.error(
    'シナリオ設定を確認してください:',
    error instanceof Error ? error.message : 'invalid JSON',
  );
  process.exitCode = 1;
}
