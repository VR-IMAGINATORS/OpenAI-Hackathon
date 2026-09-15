# 暗い倉庫・拡充版 r1 を遊ぶ

このブランチには `scenarios/playtest/warehouse-expanded-r1.json` を同梱しています。2026-09-15に試遊した候補と同じ内容で、再生成は不要です。

## PCで起動

Node.js 22.12以上を用意し、リポジトリのルートで実行します。

```sh
git switch codex/improve-game-core
git pull
npm ci
```

`.env.local` がまだなければ `.env.local.example` をコピーし、サーバーを動かす人が `OPENAI_API_KEY` と `APP_PASSPHRASE` を設定してください。既存の `.env.local` はそのまま利用できます。音声はGPT-Live、写真認識・画像生成も実APIを使います。

```sh
npm run play:expanded
```

ビルド後、[ゲーム画面](http://127.0.0.1:4311)を開き、`.env.local` の `APP_PASSPHRASE` を入力します。マイクを許可して開始してください。終了は起動したターミナルで Ctrl+C。

- このコマンドが拡充版を選ぶため、`.env.local` の `SCENARIO_PATH` を変更する必要はありません。
- 合言葉の固定値はありません。環境変数に同名設定がある場合は環境変数が優先されます。
- ポートは4311です。別プロセスが使っている場合は停止するか、起動するシェルの環境変数 `PORT` で空きポートを指定してください。

## 他の人にURLを渡す・スマートフォンで遊ぶ

サーバーを動かす人だけが上記設定を行い、cloudflaredをインストールしたうえで実行します。詳細は [モバイル試遊手順](development.md) と既存の `play:mobile` 設定を参照してください。

```sh
npm run play:expanded -- --mobile
```

起動後に表示されるHTTPS URL（QR）と、設定した合言葉をプレイヤーに渡します。プレイヤー側のcloneやAPIキー設定は不要です。ターミナルを開いたままにしてください。URL共有では実API利用料がサーバー運営者に発生します。既存の同時プレイ数・API回数制限を使い、拡充評価CLIの20 USD予算とは別に管理されます。

## 候補の状態

- 元run: `abb49ad6-ef59-4aca-aba8-0f13814b3660`、candidate revision 1。
- candidate digest: `5fa606052ab8ae20caed6219a0113d485e0057affcf348b1a7d20fc8b8599b0c`。
- 実AIのテキスト模擬3件はクリア。品質評価は未合格で、正式採用版ではありません。
- 内扉の「操作窓の隙間から奥の輪を引く」説明が分かりづらいという試遊報告は未修正です。
- 詳細: [評価結果](../specs/improve-game-core/live-evaluation-result.md)。今回の共有準備で音声・写真・スマホの実機検証を完了扱いにはしていません。
