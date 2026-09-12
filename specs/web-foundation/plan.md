Status: approved (2026-09-12; Q32 scope authorization, delegated technical choices)

# Web開発基盤の実装計画

## 範囲・選定

Q32でドキュメント+画面/ローカル/中継の最小構成まで承認。技術は企画で委任済み。
Node22.12+、npm、TypeScript、React/Vite、Express。単一package.json。DB、パッケージ公開、有料API呼出し、ゲーム本編は今回なし。既存Python試作は維持。

## ファイル・処理

1. packages/shared/scenario.ts のparseScenario（新規）: Zodで構造・unique ID・障害参照・範囲を検証。scenarios/default.jsonは編集例。tools/validate-scenario.tsで単独検証。公開投影は未公開障害/達成条件を除く。
2. apps/relay/app.ts のcreateRelayApp(config)（新規）: health、合言葉認証、Bearer付きモック診断。既定required、noneのみ解除。期限/発行数/要求数/認証試行の上限。32KB JSON制限。秘密やトークンをログへ出さず、ゲーム設定に依存しない。
3. apps/local-server/app.ts のcreateLocalApp(config)（新規）: bootstrapとPOST /api/connection。後者はlogin→diagnosticし、トークンを応答に含めない。設定URLのみへ通信（HTTPS/loopback限定、redirect拒否、timeout）。Host/Origin検証。ビルドしたUIを同一originで配信。
4. apps/web/src/App.tsxとCSS（新規）: シナリオ概要/制限値/接続フォーム/状態表示。モック明示、label、live region、狭幅対応、送信中無効化。ゲーム実行/音声は未実装。
5. root package/tsconfig/vite config、tools/dev.ts（新規）: devはUI+local、dev:allはmock relay追加。startはビルド済local+UI、start:relayは独立relay。dev:allだけ明示的な公開テスト合言葉・loopback固定で起動し外部.envを読まない。
6. README/AGENTS更新、CLAUDE新規、docs/architecture.md、docs/planner-guide.md、spec/plan/contracts/検証記録。local/relayの環境例を分離。ルート.envを読まず、秘密をgitignore。

## 境界と運用制約

カウンターは単一プロセスのメモリで再起動リセット。実API費用上限を保証しない。公開/実API前に永続上限、同時音声・時間上限、操作allowlist、課金再試行を追加。生のupstreamエラーは転送しない。任意URL/任意ヘッダーの中継は作らない。
API契約はcontracts/openapi.yaml、設定はdata-model.md。実APIは別フェーズとすることで過剰実装を避ける。

## 検証対応表

- F01/F09: ドキュメントを実コマンドと照合。
- F02: 起動・SIGINT停止・ポート競合を確認。
- F03/F04: ビルド・HTTP統合テスト・PC/狭幅UI確認。
- F05/F06: required/none、誤合言葉、期限/上限、無認証拒否、秘密非露出、bodyサイズ。
- F07/F08: 不正JSON/参照・公開投影・relay非依存を確認。
- F10: npm run check、npm test、npm run buildを実行しverificationに記録。

独立設計/セキュリティレビュー後にタスク化する。実装開始の承認はQ32を使用し、委任済み技術選択は重複確認しない。外部投稿の依頼がないため作業チケットはローカルに記録する。

## 独立レビュー反映
設計/セキュリティの2名が文書を読みレビュー。2026-09-12、実装前。設定の数値/enumを起動時に検証。HostとOriginは独立した完全一致allowlist、ViteはHost転送を保持。local要求/relay応答32KB上限、loginから本文読込まで単一timeoutを適用。tokenは暗号乱数で生成。自然文triggerConditionの意味判定は後続で、構造条件のみコード検証。提出物4点はREADMEに明記。実行テストはこのレビューの対象外。
