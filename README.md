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

旧試作の利用方法は [旧スキル](.agents/skills/call-to-past/SKILL.md)、[旧仕様/検証](specs/call-to-past/verification.md)。

会話版のエンディングでは、先に部屋・人物・道具の位置と動きを設計します。同じ設計データから配置図、時間を動かして見られるプレビュー、動画用の文章を作ります。最後に成否と未脱出の理由が分かり、それまでは結末を伏せる構成を生成前にレビューします。音は効果音・環境音のみで、生成後の映像確認は人が担当します。これはWeb版の実装状況とは別です。

```mermaid
flowchart LR
  A[プレイ履歴] --> B[空間と動きの設計]
  B --> C[配置図とプロンプト]
  C --> D[生成前の設計レビュー]
  D --> E[画像・動画の生成]
  E --> F[人が映像を確認]
  style F fill:#e6f4ea,stroke:#137333
```

詳細と実行コマンドは[空間設計手順](.agents/skills/call-to-past/references/spatial-staging.md)を参照してください。別セッションへの説明には[エンディング動画生成の引き継ぎ資料](docs/ending-video-handoff.md)を使えます。
旧試作のルールやテスト結果を、Web版の確定事項・実績として扱いません。

エンディングは[映画の一場面を作る制作設計](docs/ending-film-production-design.md)へ改訂中です。人物の目的・切迫感・プレイヤーの工夫から場面案を比較し、見せ場を選んでから撮影方法を決めます。絵コンテ画像は開発時だけの任意資料とする方針です。映画演出の動画は試作済みで、本番フローへの実装と効果の評価は別途必要です。

最後の`TRUE END` / `NORMAL END` / `BAD END`とVFXも、H3で本編と一緒に生成する設計にしました。返された動画をそのまま再生するため、文字の後付け合成を必須にしません。[公開例を調べたノウハウとプロンプト例](docs/research/minimax-h3/typography-motion-graphics.md)を用意しています。文字入りH3動画の生成・品質確認はまだ実施していません。

追加の比較試作では、開始画像のみでH3へ渡せるよう準備・回収CLIを拡張しました。ゲーム中は絵コンテ画像を作らず、文章の演出設計を使う方針です。試作の開始画像は作成済み、H3動画は未送信。通常プレイ登録とWeb統合は後続です。

次の開発は [後続の進め方](specs/web-foundation/next-steps.md) を参照してください。

## ドッグフーディング用のCodex試作

このリポジトリをCodexで開くと、`.agents/skills/call-to-past/` がプロジェクト用スキルとして検出されます。ユーザー領域へのコピーは不要です。表示されない場合は新しいセッションを開始してください。

```text
$call-to-past を使って、新しいゲームを日本語で始めてください。
```

実行スクリプトと素材は、読み込んだ `SKILL.md` のあるフォルダを基準に参照します。プレイ記録は作業フォルダ内の `runs/call-to-past/` へ保存するため、通常はリポジトリルートから実行します。[CLI手順](.agents/skills/call-to-past/references/cli.md)も参照してください。

試作のテスト（リポジトリルート、ネットワーク・有料生成なし。Windowsでは `py` も使用可能）:

```powershell
python -X utf8 -m unittest discover -s .agents/skills/call-to-past/tests -v
```

## スマホで音声と写真を使って試遊する

モバイル試遊版は `npm run play:mobile` で起動します。PCのターミナルと管理画面に表示されるQRからスマホで参加できます。

事前に運営側のGPT-Live利用権限を持つAPIキーとrelay設定、および起動PCのcloudflaredが必要です。審査員にAPIキーを渡す必要はありません。[セットアップと起動手順](docs/development.md#モバイル試遊版を起動する)を参照してください。

ゲームは音声相談・写真認識・明示実行・JSONの障害進行を実装しています。生成画像・動画・緊迫イベントは後続です。実API・実機の確認状況は[検証記録](specs/mobile-playtest/verification.md)に分けて記載します。
