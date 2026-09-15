import { config as loadEnv } from 'dotenv';
import { defaultExpansionMain } from './expansion/orchestration.js';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { ResponsesProvider } from './provider.js';
import { MockProvider, loadFixture } from './mock.js';
import { benchmark } from './benchmark.js';
import { runGeneration, evaluateSaved, type MissionProvider } from './pipeline.js';
import { RunStore, readRun } from './store.js';
import { renderReport } from './report.js';
import type { MissionConfig, RunRecord } from './schemas.js';

const help = `自動ミッション生成プロトタイプ\n\n  npm.cmd run mission -- generate --config config/auto-mission/default.json --mock|--live\n  npm.cmd run mission -- evaluate --input runs/auto-mission/<run>/run.json --mock|--live\n  npm.cmd run mission -- benchmark --config config/auto-mission/default.json --mock|--live\n  npm.cmd run mission -- render --input runs/auto-mission/<run>/run.json\n\n実API: OPENAI_API_KEYを現在の環境または.env.localから読みます。\n--liveは課金通信を実行します。既定の全体上限600秒、最大17 calls。\n出力: runs/auto-mission/ にJSONとダークHTML。renderはオフラインです。\n\nミッション拡充:\n  npm.cmd run mission -- expand --config config/auto-mission/expand-default.json --mock\n  npm.cmd run mission -- expand-continue --input <manifest.json> --mock\n  npm.cmd run mission -- expand-retry --input <manifest.json> --play <playId> --mock\n  npm.cmd run mission -- expand-pilot --input <manifest.json> --mock\n  npm.cmd run mission -- expand-render --input <manifest.json|draft.json>\n  npm.cmd run mission -- expand-adopt --input <manifest.json> --revision <number>\n拡充liveは --mock を --live --max-cost-usd <USD> に置換。続行時は追加実行分の上限です。\n初回3プレイで停止し、残り6プレイはexpand-continueで明示実行します。`;
export async function main(args = process.argv.slice(2)): Promise<number> {
  if (!args.length || args.includes('--help')) {
    console.log(help);
    return 0;
  }
  const [command, ...rest] = args;
  if (command.startsWith('expand')) return defaultExpansionMain(args);
  if (!['generate', 'evaluate', 'benchmark', 'render'].includes(command)) {
    console.error(help);
    return 2;
  }
  const options = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i];
    if (!['--live', '--mock', '--config', '--input'].includes(name) || options.has(name)) {
      console.error('引数が不正です。--help を参照してください。');
      return 2;
    }
    if (name === '--live' || name === '--mock') options.set(name, true);
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) {
        console.error('引数の値がありません。');
        return 2;
      }
      options.set(name, value);
    }
  }
  const input = options.get('--input');
  const configPath = options.get('--config');
  const live = options.has('--live');
  const mock = options.has('--mock');
  if (
    command === 'render'
      ? live || mock || configPath || typeof input !== 'string'
      : live === mock ||
        (command === 'evaluate' ? typeof input !== 'string' || !!configPath : !!input)
  ) {
    console.error('引数の組み合わせが不正です。--help を参照してください。');
    return 2;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  let active: MissionProvider | undefined;
  try {
    if (command === 'render') {
      const record = await readRun(input as string);
      const store = await RunStore.create();
      await store.save(record);
      await store.report(renderReport(record));
      console.log(`再描画: ${resolve(store.directory, 'report.html')}`);
      return 0;
    }
    if (live) loadEnv({ path: '.env.local', quiet: true });
    const apiKey = live ? process.env.OPENAI_API_KEY : undefined;
    if (live && !apiKey) {
      console.error('CONFIG_INVALID: OPENAI_API_KEY が未設定です。');
      return 2;
    }
    const fixture = mock ? await loadFixture() : undefined;
    const createProvider = (
      config: MissionConfig,
      budget?: MissionProvider['budget'],
    ): MissionProvider =>
      live
        ? new ResponsesProvider(config, { apiKey: apiKey!, budget })
        : new MockProvider(config, { budget, fixture });
    const progress = (message: string) =>
      console.log(`[${new Date().toLocaleTimeString('ja-JP')}] ${message}`);
    if (command === 'benchmark') {
      const snapshot = await loadConfig(
        typeof configPath === 'string' ? configPath : 'config/auto-mission/default.json',
      );
      const stores = new Map<string, RunStore>();
      const result = await benchmark(snapshot.config, {
        mode: live ? 'live' : 'mock',
        createProvider,
        signal: controller.signal,
        onProgress: progress,
        save: async (record: RunRecord) => {
          let store = stores.get(record.runId);
          if (!store) {
            store = await RunStore.create();
            stores.set(record.runId, store);
          }
          await store.save(record);
        },
      });
      for (const record of result.records) {
        const store = stores.get(record.runId)!;
        await store.report(renderReport(record));
        console.log(`${record.status}: ${resolve(store.directory, 'report.html')}`);
      }
      const summary = await RunStore.create();
      await writeFile(
        resolve(summary.directory, 'benchmark.json'),
        JSON.stringify(result, null, 2) + '\n',
        { flag: 'wx' },
      );
      console.table(result.cases);
      console.log(`比較結果: ${resolve(summary.directory, 'benchmark.json')}`);
      return !result.complete ||
        result.records.some((r) => r.failureCode && r.failureCode !== 'STORY_REJECTED')
        ? 2
        : result.cases.every((c) => c.matched)
          ? 0
          : 1;
    }
    const saved = command === 'evaluate' ? await readRun(input as string) : undefined;
    const snapshot =
      saved?.inputSnapshot ??
      (await loadConfig(
        typeof configPath === 'string' ? configPath : 'config/auto-mission/default.json',
      ));
    active = createProvider(snapshot.config);
    const store = await RunStore.create();
    console.log(
      `${live ? 'LIVE' : 'MOCK'} / 全体上限${snapshot.config.limits.deadlineSeconds}秒 / ${resolve(store.directory)}`,
    );
    const deps = {
      provider: active,
      mode: live ? ('live' as const) : ('mock' as const),
      references: snapshot.references,
      save: (record: RunRecord) => store.save(record),
      signal: controller.signal,
      onProgress: progress,
    };
    const record = saved
      ? await evaluateSaved(saved, deps)
      : await runGeneration(snapshot.config, deps);
    const started = performance.now();
    await store.report(renderReport(record));
    record.timings.push({
      phase: 'report-save',
      revision: null,
      role: null,
      startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: performance.now() - started,
      status: 'completed',
      reason: null,
    });
    await store.save(record);
    await store.report(renderReport(record));
    console.log(
      `${record.status === 'passed' ? '成立性の検査に合格' : '生成できませんでした'} / ${(record.durationMs! / 1000).toFixed(2)}秒 / ${record.failureCode ?? 'OK'}`,
    );
    console.log(`レポート: ${resolve(store.directory, 'report.html')}`);
    console.log(`再検証用: ${resolve(store.directory, 'run.json')}`);
    return record.status === 'passed' ? 0 : record.failureCode === 'STORY_REJECTED' ? 1 : 2;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    console.error(
      code === 'STORAGE_ERROR'
        ? 'STORAGE_ERROR: 保存できませんでした。'
        : '実行に失敗しました。設定・入力ファイルの形式と保存先を確認してください。',
    );
    return 2;
  } finally {
    active?.budget.close();
    process.removeListener('SIGINT', interrupt);
  }
}
