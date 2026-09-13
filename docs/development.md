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

秘密を使わずにQRとtunnelだけ確認する場合は `npm run play:mobile -- --mock` を使えます。合言葉は `local-demo-only` で、音声AIには接続しません。トンネル公開直後はDNS登録のため最大45秒ほど接続を待ちます。

## PRの送り先

通常の開発PRは `develop` に向けます（`gh pr create --base develop`）。`main` へのpushはAWS開発環境へのデプロイを起動するため、リリース時にだけ反映します。
