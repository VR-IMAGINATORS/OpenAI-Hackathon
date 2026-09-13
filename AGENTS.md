# OpenAI-Hackathon

## プロジェクトと正本

写真と音声で伝える工夫をAIが理解し、未来の脱出を助けるWebゲーム。短いハッカソンで体験の核を完成させる。
会話で合意した方向性は specs/web-foundation/game-direction.md、基盤の受け入れ条件はspecs/web-foundation/spec.md、現行の公開・複数人構成はspecs/hosted-multiplayer/。
既存 .agents/skills/call-to-past/ と specs/call-to-past/ はドッグフーディング用参考。Web版の仕様・承認・検証成功を引き継がない。
別プロジェクトの履歴もこのリポジトリの作業状態として扱わない。

## 構成の境界

- apps/web: React UI。秘密APIキーやサーバー用の認証情報を配布しない。
- apps/local-server: 統合サーバー内のprompt・状態・ゲーム判断を所有。ディレクトリ名は旧構成から継承。
- apps/server: 統合HTTP・認証・プレイ管理。packages/server: 内部AI通信と利用制限。独立relayは廃止。
- packages/shared/scenario.ts + scenarios/: プランナー編集設定のスキーマ/例。
- GPT-Live音声は製品の必須要件。黙ってテキストやRealtimeへ置換しない。
- 音声・写真ゲームを実装済み。実AIや生成物の成功を模擬結果で報告しない。

## ワークフロー

SpecWorkflow (spec-workflow@spec-workflow)を使用する。
- 新規機能はcreate-feature-spec→create-feature-plan→create-feature-tasks。小さく手順が明確な修正は直接進める。
- implement-feature、review-orchestratorは必要に応じ使用。実行前に該当SKILL.mdを読む。
- ハッカソン中は、ユーザーから明示的な指示があるまでマルチレビューを実行しない。
- 仕様はspecs/<feature>/、判断は.specworkflow/discussions/、教訓は.specworkflow/lessons.md。
- レビュー実行台帳.specworkflow/review/はGit管理しない。未実施のレビュー/検証を成功と記録しない。
- 既存の未コミット変更、試作、ユーザーの企画資料を勝手に上書き/削除しない。

## ブランチとPR

- 通常のPR先はdevelop。mainへのpushはデプロイを起動するため、リリースを明示された場合にだけmainへ反映する。
- 作業ブランチはcodex/配下を使用する。PR作成時はbaseをdevelopに明示する。

## 実装と確認

Node.js22.12+、npm、TypeScript。rootから実行。
- npm run check: 型と標準JSON検証。
- npm test: 課金なしの設定/HTTPテスト。
- npm run build: UI/サーバービルド。
- npm run dev:all: loopbackの統合サーバーとVite。mockでは実AIに接続しない。
- npm run dev: UI+統合サーバー。.env.localでサーバー側AI設定を行う。
- 詳細はdocs/development.md、AWS設定はdocs/hosting.md、今回の実績はspecs/hosted-multiplayer/verification.md。
- 変更に合う検証を行い、実API/音声/スマホ/面白さの確認は別に報告する。

## 秘密・運用・報告

ルート.envは既存の私有ファイル。読込/表示/配布しない。ローカルの統合サーバー設定は.env.local、本番は環境変数を使用。旧.env.relay.localは自動移行しない。
実APIキーは運営が管理する統合サーバーだけで使用し、審査員やブラウザへ渡さない。env例に実資格を含めず、認証/ヘッダー/写真等をログへ出さない。
公開アプリは共通合言葉で認証する。運用APIは独立したBearer認証を使う。privateリポジトリ自体はアプリの認証ではない。
現在の上限はメモリで再起動リセット。実課金/公開運用に十分と扱わない。
本編追加前に後続の未決定事項を確認し、土台の範囲を黙ってゲーム全体へ広げない。

## モバイル試遊
ゲームはspecs/mobile-playtest/、公開・複数人構成はspecs/hosted-multiplayer/が正本。npm run play:mobileでbuild→統合サーバー→HTTPSトンネル→共通URLのQR。ゲーム状態とAI通信・認証・上限は統合サーバーで管理する。実音声と実機撮影の検証をfake upstreamテストと混同しない。
