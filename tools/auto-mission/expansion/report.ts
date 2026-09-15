import { readFileSync } from 'node:fs';
import { writeFile, rename, unlink, lstat, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExpansionStore, PLAY_BYTES_LIMIT, RUN_BYTES_LIMIT } from './store.js';
import { compileExpandedScenario } from './compile.js';
import { summarizeUsage, predictRemainingCost } from './usage.js';
import type { SourceSnapshot, ExpansionCandidate } from './schemas.js';
import type { EvaluationManifest, PlayCheckpoint } from './store-schema.js';
import type { CallUsage } from './usage.js';
export const escapeHtml = (value: unknown): string =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const labels: Record<string, string> = {
  ja: '日本語',
  en: 'English',
  premise: '導入',
  playerBriefing: '初期説明',
  setting: '舞台設定',
  story: '物語',
  title: '題名',
  mechanism: '仕組み',
  goal: '目標・受理条件',
  constraints: '制約',
  referenceSolutions: '元の解法',
  knowledge: '知識・手がかり',
  localizedText: '本文',
  hints: '段階ヒント',
  situationDisplay: '状況説明',
  expandedStory: '拡充全文',
  changeMap: '追加・変更・維持の対応',
  prerequisites: '開示条件',
  body: '本文',
  reason: '理由',
};
function valueHtml(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '<p class="muted">未記録</p>';
  if (typeof value !== 'object') return '<p>' + escapeHtml(value) + '</p>';
  if (depth >= 6) return '<pre>' + escapeHtml(JSON.stringify(value, null, 2)) + '</pre>';
  if (Array.isArray(value))
    return value.length
      ? '<ol>' +
          value.map((item) => '<li>' + valueHtml(item, depth + 1) + '</li>').join('') +
          '</ol>'
      : '<p class="muted">なし</p>';
  return (
    '<dl>' +
    Object.entries(value)
      .map(
        ([key, entry]) =>
          '<dt>' +
          escapeHtml(labels[key] ?? key) +
          '</dt><dd>' +
          valueHtml(entry, depth + 1) +
          '</dd>',
      )
      .join('') +
    '</dl>'
  );
}
const pair = (title: string, original: unknown, expanded: unknown) =>
  '<section><h2>' +
  escapeHtml(title) +
  '</h2><div class="pair"><article class="card original"><h3>元の内容</h3>' +
  valueHtml(original) +
  '</article><article class="card expanded"><h3>拡充した内容</h3>' +
  valueHtml(expanded) +
  '</article></div></section>';
const panel = (title: string, value: unknown) =>
  '<details class="panel"><summary>' +
  escapeHtml(title) +
  '</summary><div>' +
  valueHtml(value) +
  '</div></details>';
export interface ExpansionReportData {
  source: SourceSnapshot;
  candidate: ExpansionCandidate | null;
  manifest?: EvaluationManifest;
  draft?: unknown;
  plays: PlayCheckpoint[];
  calls: CallUsage[];
  evaluation: unknown;
  executions?: unknown;
}
export function renderExpansionReport(data: ExpansionReportData): string {
  const original = data.source.compiledOriginal;
  const compiled = data.candidate ? compileExpandedScenario(data.source, data.candidate) : null;
  const stage = data.manifest?.stage ?? (data.draft as { stage?: string })?.stage ?? 'incomplete';
  const mode = data.manifest?.mode ?? (data.draft as { mode?: string })?.mode ?? 'unknown';
  const completed = data.plays.filter(
    (play) => play.status === 'cleared' || play.status === 'uncleared',
  );
  const uniqueCompleted = new Set(completed.map((play) => play.playId)).size;
  const limitNote =
    uniqueCompleted < 9
      ? '全9プレイは未完了です。初回3件ではモデルと遊び方が交絡するため、モデルの優劣を結論づけません。'
      : '9プレイの記録があります。成立性・評価の完了・人間の採用は、それぞれ別に確認してください。';
  const storyOf = (s: typeof original) => ({
    premise: s.premise,
    playerBriefing: s.playerBriefing,
    setting: s.setting,
    story: s.story ?? null,
  });
  let content = pair(
    '01 / 物語全文',
    storyOf(original),
    compiled ? { ...storyOf(compiled), expandedStory: data.candidate!.expandedStory } : null,
  );
  content += panel(
    '選択した原構成と共有設定（原文のスナップショット）',
    data.source.originalSections,
  );
  for (const [index, obstacle] of original.obstacles.entries()) {
    const solutions = data.source.originalSections.gimmicks[index]?.referenceSolutions;
    content += pair(
      '02 / ギミック ' + (index + 1) + ' — ' + obstacle.title.ja,
      { ...obstacle, referenceSolutions: solutions },
      compiled
        ? {
            ...compiled.obstacles[index],
            referenceSolutions: solutions,
            knowledge: compiled.knowledge.filter(
              (entry) => entry.observationTargetId === obstacle.id,
            ),
          }
        : null,
    );
  }
  content += pair(
    '03 / 手がかりと開示条件',
    { knowledge: original.knowledge, observationTargets: original.observationTargets },
    compiled
      ? {
          knowledge: compiled.knowledge,
          observationTargets: compiled.observationTargets,
          investigation: compiled.investigation,
        }
      : null,
  );
  content += panel('追加・変更・維持の対応表', data.candidate?.changeMap ?? null);
  content +=
    '<section><h2>04 / プレイと評価</h2><p class="note">' +
    escapeHtml(limitNote) +
    ' テキスト模擬ではGPT-Liveの音声、実機写真認識、人間の思考時間や面白さを保証しません。</p>';
  content += panel('独立評価・根拠・反証・修正可否', data.evaluation);
  for (const play of data.plays)
    content += panel(
      play.playId +
        ' / ' +
        play.model +
        ' / ' +
        play.persona +
        ' / ' +
        play.status +
        ' / attempt ' +
        play.attemptId,
      play,
    );
  content +=
    '</section><section><h2>05 / 使用量と条件</h2><p class="section-note">使用量不明は0として扱いません。金額は料金表に基づく概算で、キャッシュ書き込み内訳が不明な場合は保守的に計算しています。</p>';
  content += panel('使用量・予約・処理別費用', summarizeUsage(data.calls));
  if (data.manifest)
    content += panel(
      '残りプレイの参考費用予測',
      predictRemainingCost(
        completed.map((play) => ({
          model: play.model,
          status: play.status,
          calls: data.calls.filter((call) => play.callIds.includes(call.callId)),
        })),
        data.manifest.playMatrix
          .filter((row) => !completed.some((play) => play.playId === row.playId))
          .map((row) => row.model),
      ),
    );
  content += panel('料金の基準日・モデル・固定条件・採用状態', data.manifest ?? data.draft);
  content += panel('明示実行ごとの追加予算と結果', data.executions ?? null);
  content += panel('API呼び出し台帳（キー・ヘッダーは含みません）', data.calls) + '</section>';
  content +=
    '<details class="panel"><summary>カタログ原文の全文（共有設定・選択外の構成も保持）</summary><pre>' +
    escapeHtml(data.source.rawCatalogText) +
    '</pre></details>';
  content += panel('候補版の全文', data.candidate);
  const css = readFileSync(new URL('./report.css', import.meta.url), 'utf8');
  return (
    '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>シナリオ拡充の比較</title><style>' +
    css +
    '</style></head><body><main><header><div class="eyebrow">CALL TO THE PAST / SCENARIO STUDY</div><h1>調査の手がかりを、見比べる。</h1><p class="muted">' +
    escapeHtml(original.title.ja) +
    ' · 原資料から固定した1構成</p><span class="badge">' +
    escapeHtml(mode) +
    '</span><span class="badge">' +
    escapeHtml(stage) +
    '</span><span class="badge">revision ' +
    escapeHtml(data.candidate?.revision ?? '未確定') +
    '</span><span class="badge">記録済み ' +
    uniqueCompleted +
    ' / 9 プレイ</span><p class="note">このレポートは解法を知る採用判断者向けです。読むだけではゲームへ採用されません。' +
    (mode === 'mock' ? ' mockは輸送・状態境界の検証であり、実AIの評価結果ではありません。' : '') +
    '</p></header>' +
    content +
    '<footer>原資料・生成追加・候補版・会話を保存データから表示しています。外部通信は行いません。</footer></main></body></html>'
  );
}
async function bytesIn(directory: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(directory)) {
    const path = join(directory, name),
      stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('REPORT_SYMLINK');
    total += stat.isDirectory() ? await bytesIn(path) : stat.size;
  }
  return total;
}
export async function renderSavedExpansion(input: string): Promise<void> {
  if (!['manifest.json', 'draft.json'].includes(basename(input)))
    throw new Error('REPORT_INPUT_INVALID');
  const loaded =
    basename(input) === 'draft.json'
      ? await ExpansionStore.readOnlyDraft(input)
      : await ExpansionStore.readOnly(input);
  const data: ExpansionReportData =
    'manifest' in loaded ? loaded : { ...loaded, plays: [], evaluation: null };
  const html = renderExpansionReport(data),
    bytes = Buffer.byteLength(html);
  if (bytes > PLAY_BYTES_LIMIT || (await bytesIn(loaded.directory)) + bytes > RUN_BYTES_LIMIT)
    throw new Error('REPORT_SIZE_LIMIT');
  const output = join(loaded.directory, 'report.html'),
    temporary = join(loaded.directory, '.report-' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, html, { flag: 'wx' });
    await rename(temporary, output);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
