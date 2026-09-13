# Call to the Past — 未来からの着信

身近な物の写真と、音声で伝える意外な使い方で、未来の自分を脱出へ導くAIゲームです。GPT-Liveとの会話、写真認識、音声指示による自動行動、メッセンジャー形式の履歴、JSONシナリオの障害進行、検査つき状況画像を実装しています。日本語/英語を選んでプレイできます。エンディング動画と緊迫イベントは未実装です。

## プレイ・開発

審査員は運営が共有するHTTPS URLを開き、共通の合言葉で参加します。APIキーやローカルサーバは不要です。最大5人が独立してプレイできます。

開発者はNode.js 22.12以上とcloudflaredを用意し、次を実行します。

```sh
npm ci
# .env.local.exampleを.env.localへコピーし、サーバ用APIキーなどを設定
npm run play:mobile
```

表示されるQRからスマホで参加できます。起動するアプリサーバは1つです。[詳細なローカル手順](docs/development.md) / [AWS配布手順](docs/hosting.md)。

## 編集場所

| 場所 | 内容 |
|---|---|
| apps/web/ | モバイル優先のReact画面・マイク・写真入力 |
| apps/server/ | 統合HTTPサーバ、認証、同時プレイ管理、運用API |
| apps/local-server/game.ts | プレイ単位のゲーム進行・行動確定 |
| apps/local-server/hosted-runtime.ts | 写真・音声とゲームの接続 |
| apps/local-server/game-ai.ts / live.ts | AI認識・判定・音声のプロンプト |
| packages/server/ai-service.ts | AI接続・上限・終了管理 |
| scenarios/ | プランナーが編集するJSONシナリオ |
| specs/hosted-multiplayer/ | 今回の仕様・計画・実装タスク |

[シナリオ編集](docs/planner-guide.md) / [構成](docs/architecture.md)。

## 検証

```sh
npm run build
npm test
npm run format:check
```

fake providerでの成功と、実API・実機・AWSの確認は分けて扱います。ゲームの進行はメモリ上にあり、サーバ再起動時には失われます。通常デプロイは既存Liveの終了を確認してから切り替えます。ホスト強制停止時の外部Live終了は保証できません。

## プロジェクト

ハッカソンの提出ソースにはWeb・ゲーム・通信・配布設定を含みます。秘密値は含めません。審査終了後は運営環境を削除します。

開発は [AGENTS.md](AGENTS.md) とSpecWorkflowに従います。過去の [Codex試作](.agents/skills/call-to-past/SKILL.md) は参考用です。


## Game core更新

音声自動実行・会話履歴・検査つき状況画像・終了後結果保持の現在の構成と試遊手順は[ゲームコアの動作確認](docs/game-core.md)を参照。旧手動実行ボタンの説明はv1回帰用の経路にのみ適用する。
