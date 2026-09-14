import { readFileSync } from 'node:fs';
import type { RunRecord } from './schemas.js';
export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const reportStyles = readFileSync(new URL('./report.css', import.meta.url), 'utf8');
const seconds = (ms: number | null) => (ms === null ? '未計測' : `${(ms / 1000).toFixed(2)} 秒`);
const json = (value: unknown) => `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
const labels: Record<string, string> = {
  contractGenerator: '固定条件の生成',
  contractChecker: '固定条件の検証',
  storyGenerator: 'ストーリー生成',
  repairer: '修正',
  physics: '身体・物理評価',
  resources: '道具・回数評価',
  causality: '因果・説明評価',
  verifier: '指摘の検証',
};
const referencePrices: Record<string, [number, number]> = {
  'gpt-6-astra': [10, 50],
  'gpt-5.6-sol': [4, 20],
  'gpt-5.6-terra': [2, 12],
  'gpt-5.6-luna': [0.2, 1.2],
};
export function estimateReferenceCost(
  record: RunRecord,
): { usd: number; unknownCalls: number } | null {
  if (record.mode === 'mock') return null;
  let usd = 0,
    unknownCalls = 0;
  for (const call of record.calls) {
    const model = call.responseModel ?? call.requestedModel;
    const price = Object.entries(referencePrices).find(
      ([name]) => model === name || model.startsWith(name + '-'),
    )?.[1];
    if (!price || call.usage?.inputTokens == null || call.usage.outputTokens == null) {
      unknownCalls++;
      continue;
    }
    usd += (call.usage.inputTokens * price[0] + call.usage.outputTokens * price[1]) / 1_000_000;
  }
  return { usd, unknownCalls };
}
export function renderReport(record: RunRecord): string {
  const final = record.revisions.at(-1);
  const cost = estimateReferenceCost(record);
  const passed = record.status === 'passed';
  const status = passed
    ? '成立性の検査に合格'
    : record.status === 'running'
      ? '実行途中'
      : '生成できませんでした';
  const knownOutput = record.calls.reduce((sum, c) => sum + (c.usage?.outputTokens ?? 0), 0);
  const unknownUsage = record.calls.filter((c) => c.usage?.outputTokens == null).length;
  const models = [...new Set(record.calls.map((c) => c.responseModel ?? c.requestedModel))];
  const timingRows = record.timings
    .map(
      (t) =>
        `<tr><td>${escapeHtml(t.role ? labels[t.role] : t.phase)}</td><td>${t.revision === null ? '—' : t.revision + 1}</td><td>${seconds(t.durationMs)}</td><td>${escapeHtml(t.status)}</td><td>${escapeHtml(t.reason ?? '')}</td></tr>`,
    )
    .join('');
  const revisions = record.revisions
    .map(
      (r, i) =>
        `<details ${i === record.revisions.length - 1 ? 'open' : ''}><summary>候補 ${r.candidate.revision + 1} · ${escapeHtml(r.candidate.title)}</summary><div class="detail"><h3>機械検査</h3>${r.mechanical ? `<p>${r.mechanical.resourceTotals.photoSends} 回送信 · ${r.mechanical.resourceTotals.actions} 行動 · 推定 ${r.mechanical.estimatedTotalSeconds} 秒</p><ul>${r.mechanical.checks.map((c) => `<li class="${c.status === 'fail' ? 'bad' : ''}">${escapeHtml(c.status)} — ${escapeHtml(c.reason)} <small>${escapeHtml(c.path)}</small></li>`).join('')}</ul>` : '<p>未実施</p>'}<h3>独立評価</h3>${r.reviews.length ? r.reviews.map((review) => `<article><h4>${escapeHtml(labels[review.role])} · ${escapeHtml(review.verdict)}</h4><p>${escapeHtml(review.summary)}</p>${json(review.findings)}</article>`).join('') : '<p>未実施</p>'}<h3>指摘の検証・反証</h3>${r.verification ? json(r.verification) : '<p>未実施</p>'}<h3>コードによる最終判定</h3>${json(r.verdict)}<details><summary>状態の推移</summary>${json(r.mechanical?.stateTrace ?? [])}</details><details><summary>この候補の全文・構造化解法</summary>${json(r.candidate)}</details></div></details>`,
    )
    .join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>ミッション生成レポート</title><style>${reportStyles}</style></head><body><main><div class="eyebrow">CALL TO THE PAST / MISSION LAB</div><header class="hero"><span class="badge">${record.mode === 'mock' ? 'MOCK · 模擬実行' : 'LIVE · 実API'}</span><span class="badge">${escapeHtml(record.status)}</span><h1 class="${passed ? 'good' : 'bad'}">${status}</h1><p>${escapeHtml(record.failureReason ?? '固定条件と例示解法の成立性を検査しました。面白さや物理的成立を保証するものではありません。')}</p><p class="muted">${escapeHtml(record.failureCode ?? '')}</p><div class="metrics"><div class="metric"><strong>${seconds(record.durationMs)}</strong><span>全体の実経過時間 / 目標180秒</span></div><div class="metric"><strong>${record.calls.length} calls</strong><span>API呼び出し / 上限${record.inputSnapshot.config.limits.maxApiCalls}</span></div><div class="metric"><strong>${Math.max(0, record.revisions.length - 1)} 回</strong><span>修正回数 / 上限${record.inputSnapshot.config.limits.maxRepairs}</span></div><div class="metric"><strong>${knownOutput.toLocaleString()}</strong><span>既知の出力token${unknownUsage ? ` / 使用量不明${unknownUsage}件` : ''}</span></div></div><p class="muted">${record.mode === 'mock' ? '模擬実行の所要時間・合否は、実モデルの速度や品質の評価には使えません。' : record.durationMs !== null && record.durationMs > 180000 ? '目標180秒を超えた試行です。10分は初期タイムアウトの設定値です。' : '単一試行の結果です。代表値や所要時間の保証ではありません。'}</p></header>
<h2>最終案</h2>${final ? `<article><h3>${escapeHtml(final.candidate.title)}</h3><p>${escapeHtml(final.candidate.opening)}</p>${final.candidate.obstacles.map((o, i) => `<h4>${i + 1}. ${escapeHtml(o.id)}</h4><p>${escapeHtml(o.description)}</p><p class="muted">例示解法: ${escapeHtml(o.solutionExample)}</p>`).join('')}<h4>結末</h4><p>${escapeHtml(final.candidate.ending)}</p></article>` : record.contract ? `<article><h3>固定条件案（ストーリー本文の生成前）</h3><p>${escapeHtml(record.contract.initialState.description)}</p>${record.contract.initialState.props.map((prop) => `<h4>${escapeHtml(prop.id)}</h4><p>${escapeHtml(prop.description)}</p>`).join('')}<p class="muted">${escapeHtml(record.contractCheck?.summary ?? '固定条件の検証結果はまだ取得できていません。')}</p></article>` : '<p>固定条件案もまだ取得できていません。失敗情報は下部にあります。</p>'}
<h2>段階別の時間</h2><p class="muted">parallel-reviews は並列評価の実経過です。各APIの所要時間を足して全体時間とはしません。ゲーム内の行動見積りとは別の計測です。</p><div class="table"><table><thead><tr><th>段階</th><th>候補</th><th>実測</th><th>状態</th><th>理由</th></tr></thead><tbody>${timingRows}</tbody></table></div>
<p class="muted">参考費用: ${cost ? `既知の使用量 ${cost.usd.toFixed(4)} USD${cost.unknownCalls ? ` / 算出不能 ${cost.unknownCalls} 件` : ''}（2026-09-14確認の標準単価。キャッシュ割引等は未反映。請求額の上限ではありません）` : 'MOCKのため算出しません'}</p><h2>評価と修正の履歴</h2>${revisions || '<p>候補なし</p>'}<h2>固定条件と実行情報</h2><details><summary>固定条件・検証結果</summary><h3>コード検査</h3>${json(record.contractValidation ?? null)}<h3>独立AI検証</h3>${json(record.contractCheck)}<h3>固定条件</h3>${json(record.contract)}</details><details><summary>入力設定・参考例</summary>${json(record.inputSnapshot)}</details><details><summary>モデル・API使用量</summary><p>${escapeHtml(models.join(', '))}</p>${json(record.calls)}</details><footer>Run ${escapeHtml(record.runId)} · ${escapeHtml(record.startedAt)}<br>保存済みJSONから再描画できます。外部通信・外部素材・スクリプトは使用していません。</footer></main></body></html>`;
}
