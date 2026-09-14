# ローカル開発

Node.js 22.12以上を用意し、`npm ci` を実行します。統合サーバがゲーム進行・認証・AI接続を担当します。別のrelay/adminサーバは不要です。

## 音声と写真で試遊

1. `.env.local.example` を `.env.local` にコピーします。
2. `APP_PASSPHRASE`、`OPENAI_API_KEY`、`AI_MODE=live`、`AI_GLOBAL_LIVE_ATTEMPTS`、`AI_GLOBAL_RESPONSE_ATTEMPTS` を設定します。GPT-Liveを利用できるAPIキーが必要です。
3. cloudflaredをインストールし、ターミナルを再起動します。
4. `npm run play:mobile` を実行します。
5. 表示された共通HTTPS URLのQRをスマホで読み、合言葉で参加します。マイクを許可するとプレイ枠を確保します。

PCも同じURLを利用できます。1環境につき5人まで同時に独立してプレイできます。Ctrl+Cで終了すると進行中のゲームは失われます。

既存のtunnelを使う場合は `PUBLIC_APP_URL=https://...` を指定してください。パスや末尾スラッシュは含めません。cloudflaredがPATHにない場合は `CLOUDFLARED_PATH` を指定できます。

## 設定の移行

旧 `.env.relay.local` の内容は自動移行しません。必要なキーを開発者自身が `.env.local` に設定してください。`RELAY_URL`、`LOCAL_PORT`、`ADMIN_PORT`、招待QR、管理トークンは廃止しました。ポートは `PORT`、公開URLは `PUBLIC_APP_URL` を使います。

リポジトリルートの `.env` は読み込みません。秘密ファイルはGitに追加しないでください。フロントエンドは環境ファイルを読み込みません。本番は環境変数のみを使用します。

## UI開発と検証

- `npm run dev`：設定済みの統合サーバとViteを起動します。画面は http://127.0.0.1:5173 。
- `npm run dev:all`：外部AIへ接続しないmockで画面を確認します。合言葉は `local-demo-only`。音声接続はできません。
- `npm run build`：型検査、シナリオ検証、Webとサーバをビルドします。
- `npm test`：fake providerを使い、外部APIへの課金なしで検証します。
- `npm run format` / `npm run format:check`：Prettierで人間が読めるソース整形を実行します。

本番配布は [AWS設定手順](hosting.md) を参照してください。

秘密を使わずにQRとtunnelだけ確認する場合は `npm run play:mobile -- --mock` を使えます。合言葉は `local-demo-only` で、音声AIには接続しません。トンネル公開直後はDNS登録・HTTPS接続のため最大120秒待ち、15秒ごとに待機理由を表示します。接続確認は設定済みDNSへ問い合わせ、新規 `*.trycloudflare.com` の名前解決が失敗するとCloudflare DNS（1.1.1.1 / 1.0.0.1）でも確認します。固定URLはこの公開DNSへの再問い合わせの対象外です。OSのDNS設定は変更せず、HTTPS証明書と起動したサーバーの識別子を確認してからQRを表示します。QR表示後にスマホだけURLを開けない場合は、スマホをモバイル回線へ切り替えて確認してください。

## PRの送り先

通常の開発PRは `develop` に向けます（`gh pr create --base develop`）。`main` へのpushはAWS開発環境へのデプロイを起動するため、リリース時にだけ反映します。

## エンディング動画

動画機能は既定で無効です。実際に試す場合は、既存の`.env.local`へ`FAL_KEY`、`ENDING_VIDEO_ENABLED=true`、`AI_GLOBAL_VIDEO_ATTEMPTS`（1〜1,000）を追加し、`RESULT_TTL_SECONDS=600`に変更して再起動します。コピーし直して既存の設定を消さないでください。GitHubのSecretはローカルPCへ自動配布されません。詳しくは[falの設定手順](fal-ending-setup.md)を参照してください。

動画用の脚本・画像生成・検査には既存のOpenAI設定とそれぞれの予算も必要です。`AI_MODE=mock`および`npm run dev:all`では実OpenAI・実falを呼びません。有効化フラグを設定した場合のキー・予算検証と、実providerの利用判定は別です。

ゲーム終了後に、解除数で決まるhappy / normal / badを表示します。全確定行動からAIが40種類のタグのうち主役1個（該当なしも可）と短い結末文を作り、画像・動画制作前に保存します。画面は結末→解除数→タグ→短文→動画の順で、文章が届き次第自動表示するため、動画を待ちながら読めます。動画は再生ボタンで開始します。状態取得は読み取り専用で、再読み込みによる再生成はしません。

liveモードでは最初に文章・タグを生成して保存し、動画有効時は映像脚本を別途生成します。文章が失敗しても、確定済みの結末・行動・状態から動画制作を続けます。既存のResponses全体予算内でstory通常1回（出力検証の修正込み最大2回）、direction最大1回を使います。動画無効・参照画像なし・動画予算不足なら文章のみで、mock・中断は実生成しません。映像脚本・画像・動画の失敗でも保存済み文章は残り、動画処理枠が埋まっていても文章生成は進めます。文章生成自体は最大60秒、文章のみのジョブは待機を含め最大120秒（ENDING_JOB_TIMEOUT_SECONDSが短ければその値）です。解除0個や全試行失敗も正常な結末です。定義と仕様は[エンディングタグ](../specs/ending-tags/spec.md)、エラーコード・Play IDによる確認は[調査手順](ending-diagnostics.md)を参照してください。

締切は`ENDING_JOB_TIMEOUT_SECONDS`（既定480、60〜540秒）、同時動画数は`ENDING_CONCURRENT`（既定2、1〜2）で設定します。結果保持は動画締切+60秒以上、最大600秒です。動画の回数上限・状態・生成物はメモリで管理し、再起動でリセット・消失します。実生成・スマホでの再生・映像品質の成功はfakeテストでは確認できません。

## ゲームコア設定

- 共通の会話・判断・画像検査のルール: `config/game-core.json`
- 既定の6舞台・10ギミック・18構成: `scenarios/story-catalog.json`（version 3）
- 旧Web版の固定シナリオ: `SCENARIO_PATH=scenarios/mobile-playtest.json`（version 2）で明示的に指定する。
- `npm run validate:scenario` で参考v1・互換v2・標準v3の全18構成・共通設定を検証する。

ローカルでは保存後に新しく開始したプレイへ反映します。進行中のプレイは開始時の設定を維持します。AWSではJSONを含めた再デプロイが必要です。不正な設定は新規開始を拒否します。モデルやAPIキー、費用上限はこのJSONに書かず、運営の環境変数で管理します。

共通会話policy・factsによる判定・画像検査・英語選択UIを本編へ接続しています。参加時に選んだ言語はプレイ中固定です。開始前の概要と新規プレイは最新の有効な設定から取得します。

標準v3ではプレイ作成時にだけ舞台とギミック順を抽選し、再接続や画面再読込では維持します。制限時間はカタログの `rules.totalTimeSeconds`（既定300秒）で調整できます。プレイ枠の寿命との整合条件、物語と謎の編集方法は[シナリオ編集ガイド](planner-guide.md)を参照してください。

## Game core更新

音声自動実行・会話履歴・検査つき状況画像・終了後結果保持の現在の構成と試遊手順は[ゲームコアの動作確認](game-core.md)を参照。旧手動実行ボタンの説明はv1回帰用の経路にのみ適用する。
