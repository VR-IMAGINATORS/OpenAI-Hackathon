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

## モバイル試遊版を起動する

音声会話はGPT-Live、写真認識と攻略判定はResponses APIを使います。ゲームの判断・シナリオ・状態は起動したPCに保持します。生成画像・動画・緊迫イベントは後続開発です。

1. 運営PCで `.env.relay.example` を `.env.relay.local` へコピーし、合言葉とlive設定を有効にします。APIキーは運営PCだけに設定します。`RELAY_TOKEN_TTL_SECONDS` は900を使用します。ファイル内に同名変数を重複させないでください。
2. 運営PCで `npm run dev:relay` を起動します。審査員が別PCなら、運営relayをHTTPSで提供し、そのoriginを審査員側 `.env.local` の `RELAY_URL` に指定します。審査員の `.env.local` にAPIキーは不要です。
3. ゲーム起動PCに [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) をインストールします。Windowsは `winget install --id Cloudflare.cloudflared --exact`、その後ターミナルを開き直してください。自動インストールは行いません。
4. ゲーム起動PCで `npm ci`、続けて `npm run play:mobile` を実行します。ビルド後にゲームとトンネルが起動し、HTTPSの疎通確認後にターミナルへQRを表示します。
5. スマホのカメラでQRを読み取ります。PC管理リンクでもQRを表示できます。招待は5分・一度限り。同じPCで遊ぶ場合は管理画面の「このPCでプレイする」を開きます。
6. 必要なら合言葉を入力し、音声接続をタップしてマイクを許可します。開始後、写真を撮って使い方を声で伝え、認識の短文を確認して「これで実行」を押します。
7. 終了はCtrl+C。PC管理画面でプレイ破棄・QR再発行もできます。

既にビルド済みなら `npm run play:mobile:start` で起動できます。初期設定は `scenarios/mobile-playtest.json`（緊迫イベント無効）です。`.env.local` の `SCENARIO_PATH` がある場合はそちらを優先します。

`PUBLIC_GAME_URL=https://...` を `.env.local` に指定すると、既に設定した別のHTTPSトンネルを使えます。転送先は `http://127.0.0.1:4310`。PC管理の4312と運営relayの4311はゲーム用トンネルへ公開しません。URLにパス・クエリ・認証情報は指定できません。

Quick Tunnelは試遊向けで稼働保証がなく、既存のcloudflared設定がある場合は起動できないことがあります。ツールは既存設定を変更しません。トンネルで画面が開いても、回線がWebRTCを制限すると音声がつながらない場合があります。その場合はスマホの携帯回線やPCのテザリングで確認してください。

### 実APIの運用上限

初期の音声接続上限は10分、1認証tokenで作成3回・Responses40回、同時音声1接続。全体の上限は運営設定で必須指定します。音声のheartbeatが30秒途絶するとrelayが切断します。終了未確認の接続は枠を保持し、新規作成を止めます。

ゲーム時計は5分で、操作不能のAI待ち・接続復旧時だけ停止します。待機の合計は60秒まで。撮影や通常の会話では時計が進みます。終了/失効時は写真と会話をメモリから破棄し、再起動でプレイは失われます。

回数上限はメモリ管理で、relay再起動で戻ります。金額の絶対上限ではありません。運営が利用状況を確認し、不要になったrelayを停止してください。実API試験の成功、スマホ実機での撮影・音声、面白さは自動テストとは別に確認します。
