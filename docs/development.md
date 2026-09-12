# 開発・審査用の起動

## 前提と通信確認

Node.js22.12以上とnpm。まずrepository rootで `npm ci`。
`npm run dev:all` はAPIキー不要。画面5173、local4310、relay4311をloopbackで起動。合言葉はlocal-demo-only。画面の接続確認でモックの往復を確認する。Ctrl+Cで停止。
サーバー/JSON変更後は再起動、画面の変更はViteが反映する。

## 運営中継を使うローカル起動

1. .env.local.exampleを.env.localへコピー。
2. RELAY_URLに運営のHTTPS URLを指定。例のloopbackは開発用。
3. `npm run dev` で画面+localだけ起動。
4. 別途受け取った合言葉を画面へ入力。

現在提供できるのはモック診断まで。実API連携を実装/検証するまでは審査用ゲームとして提出しない。

ビルドして起動する場合:
```sh
npm run build
npm start
```
http://127.0.0.1:4310 で画面とAPIを提供する。rootディレクトリから実行すること。

## relayの単独起動（運営）

.env.relay.exampleを.env.relay.localへコピーし、requiredの場合はRELAY_PASSPHRASEを設定。
`npm run dev:relay` またはビルド後に `npm run start:relay`。
RELAY_AUTH_MODE=noneで合言葉だけ無効化。クライアント側の設定では解除できない。
.env.local（審査員）と.env.relay.local（運営）は別。既存ルート.envを読まない。
dev:allは隔離したモック設定を強制し、これらのenvファイルを読まない。

外部公開は未実施。現在のrelayはモック用。公開/課金前の条件はarchitecture.md参照。
審査後は運営relayを停止する。運営の利用枠での実AIプレイは以後動かない。モックのローカル確認は継続可能。

## コマンド

| コマンド | 用途 |
|---|---|
| npm run check | TypeScript + 標準シナリオ検証 |
| npm test | 課金なしの設定/認証/HTTP統合テスト |
| npm run build | 型/設定を検証してUIとサーバーを出力 |
| npm run validate:scenario -- path/to/file.json | 別JSONを検証 |
| npm run dev:all | モック3プロセス |
| npm run dev | UI/localのみ |
| npm run dev:relay | 運営relayのみ |
| npm start / npm run start:relay | ビルド後の起動 |

Windows PowerShellの実行ポリシーでnpm.ps1が拒否される場合は `npm.cmd` を使用できる。

## トラブルと確認範囲

- ポート競合: 既存プロセスを確認。devは固定5173/4310、relayは4311。
- 認証失敗: dev:allの合言葉と、通常relayの合言葉は別。
- 接続不可: relayの稼働とRELAY_URLを確認。認証解除ではネットワーク問題は解決しない。
- 設定エラー: 該当JSON/環境設定を修正して再起動。成功を装うフォールバックはしない。
- スマホ音声は将来HTTPS/tunnelとマイク許可が必要。PCのlocalhost表示や狭幅レイアウト確認は実スマホ音声検証の代わりではない。
