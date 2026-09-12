# OpenAI-Hackathon

## プロジェクトと正本

写真と音声で伝える工夫をAIが理解し、未来の脱出を助けるWebゲーム。短いハッカソンで体験の核を完成させる。
会話で合意した方向性は specs/web-foundation/game-direction.md、今回の土台の受け入れ条件はspecs/web-foundation/spec.md。
既存 skills/call-to-past/ と specs/call-to-past/ はドッグフーディング用参考。Web版の仕様・承認・検証成功を引き継がない。
別プロジェクトの履歴もこのリポジトリの作業状態として扱わない。

## 構成の境界

- apps/web: React UI。秘密APIキー/relayトークンを配布しない。
- apps/local-server: 審査員側の設定・prompt・状態・ゲーム判断を所有。
- apps/relay: 運営の認証/利用制限/API通信のみ。ゲーム設定や判定をimportしない。
- packages/shared/scenario.ts + scenarios/: プランナー編集設定のスキーマ/例。
- GPT-Live音声は製品の必須要件。黙ってテキストやRealtimeへ置換しない。
- 現段階はモック基盤。実AIや生成物の成功を模擬結果で報告しない。

## ワークフロー

SpecWorkflow (spec-workflow@spec-workflow)を使用する。
- 新規機能はcreate-feature-spec→create-feature-plan→create-feature-tasks。小さく手順が明確な修正は直接進める。
- implement-feature、review-orchestratorは必要に応じ使用。実行前に該当SKILL.mdを読む。
- 仕様はspecs/<feature>/、判断は.specworkflow/discussions/、教訓は.specworkflow/lessons.md。
- レビュー実行台帳.specworkflow/review/はGit管理しない。未実施のレビュー/検証を成功と記録しない。
- 既存の未コミット変更、試作、ユーザーの企画資料を勝手に上書き/削除しない。

## 実装と確認

Node.js22.12+、npm、TypeScript。rootから実行。
- npm run check: 型と標準JSON検証。
- npm test: 課金なしの設定/HTTPテスト。
- npm run build: UI/サーバービルド。
- npm run dev:all: loopbackモック3プロセス。
- npm run dev: UI+localのみ。運営relayを.env.localで設定。
- 詳細はdocs/development.md、実績はspecs/web-foundation/verification.md。
- 変更に合う検証を行い、実API/音声/スマホ/面白さの確認は別に報告する。

## 秘密・運用・報告

ルート.envは既存の私有ファイル。読込/表示/配布しない。.env.localと.env.relay.localを役割ごとに使用。
実APIキーをlocal/ブラウザへ渡さない。env例に実資格を含めず、認証/ヘッダー/写真等をログへ出さない。
中継の既定認証はrequired。noneは運営設定だけ。privateリポジトリ自体は中継認証ではない。
現在の上限はメモリで再起動リセット。実課金/公開運用に十分と扱わない。
本編追加前に後続の未決定事項を確認し、土台の範囲を黙ってゲーム全体へ広げない。
