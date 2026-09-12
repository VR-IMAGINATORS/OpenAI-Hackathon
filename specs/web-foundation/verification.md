# 開発基盤の検証

2026-09-12。Windows / Node.js v22.15.1 / npm10.9.2。対象はWeb版の土台のみ。

## 実施結果

| 検証 | 結果 |
|---|---|
| npm install | 成功、package-lock.jsonを生成 |
| npm run check | 成功（TypeScript + 標準シナリオ） |
| npm test | **22件成功、失敗/skipなし** |
| npm run build | 成功。dist/webとdist/serverを生成 |
| npm run dev:all | 画面5173、local4310、relay4311の起動成功 |
| Chromeで誤合言葉→正しい合言葉 | 拒否→実HTTPでモック往復成功。応答にtoken/合言葉なし、入力欄を消去 |
| 認証none | ビルド済み画面をlocalから配信し、入力欄なしで実HTTPの診断成功 |
| relay停止 | 画面に接続不可/再確認を表示。成功表示なし |
| PC1440×1000 / 狭幅390×844 | スクリーンショットを目視確認。横はみ出し/JS pageerrorなし |
| Ctrl+C停止 | 5173/4310/4311すべて解放。Windows npm.cmdの終了確認はYで完了 |
| ポート5173競合 | launcherがexit1、他の2サーバーを終了し4310/4311解放 |
| Git除外 | .env/.env.local/.env.relay.local/node_modules/生成物を除外。環境例は追跡対象 |

22件の内訳: シナリオ3件、サーバー設定5件、実HTTP14件。
HTTPはrequired/none、token期限/回数、全体発行/要求上限、認証試行窓、Host/Origin、32KB要求/応答上限、redirect拒否、停止、不正JSON/スキーマ、loginとdiagnosticと本文読込を含むtimeout、秘密非露出を確認。
サーバーの自動テストはephemeral loopback portを使用し、外部AIへ送信していない。

## 検証過程と制約

初回buildはUIの並行実装中でindex.html未作成のため失敗。全ファイル完成後の最終buildは成功。
標準シェル/画像閲覧/ブラウザツールは環境helperの起動エラーがあったため、許可されたコマンド実行と同梱Playwrightで検証した。画像は読み取って目視確認済み。
独立した設計/セキュリティレビューは実装前の文書を対象に実施。全文コードの独立レビュー完了を意味しない。

手動確認の補助スクリプト/スクリーンショットはartifacts/（Git対象外）。再現用の主要検証はnpm testとdocs/development.md。
完成した実ゲーム、GPT-Live音声、実写真/画像/動画、AIの面白さ、実スマホ音声、外部HTTPS/tunnel運用、審査規定への適合は**未検証**。公開/課金運用の準備完了とも扱わない。
既存Python/Codex試作のテストは変更対象外のため今回実行していない。
