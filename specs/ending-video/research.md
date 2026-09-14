# Web版エンディング動画の調査

2026-09-14。コード読解・公式資料の確認。実API送信なし。

## 既存実装で確認したこと

| 対象 | 確認結果 | 設計への影響 |
| --- | --- | --- |
| デモ `references/ending.md` | 開始・文字入り終了画像、直近最大2行動、15秒H3、結果を再判定しない | 古い開始画像のみの設計資料より優先する |
| デモ `scripts/game.py` `_derive_ending` | 3解除happy / 2解除normal / それ以外bad | ユーザーがWebへの適用を確認済み |
| `scenarios/mobile-playtest.json` | restraint / door / escape の3ギミック | 現行Webで同じ分岐を適用できる |
| `packages/shared/scenario.ts` | endingは15秒・失敗時も生成という宣言のみ | 設定の存在を動画実装済みと解釈しない |
| `GameSession.check()` | ゲーム時間切れはlost、待機期限切れはexpired | ゲーム終了と通信・運用中断を分ける |
| `GameSession.judgeAction()` / `commit()` | 最終行動の回数切れ分岐が、非最終ギミック成功時のindex更新より先 | indexだけから解除数を復元すると過少計数になる。独立した解除履歴を更新する |
| `GameRuntime` | 最終行動中はended通知が結果画像の登録より先。Live終了まで最大12秒 | 結末入力を先に固定し、対応する最終画像を明示的に関連付ける。到着順で画像を選ばない |
| `SceneJobs` / `ResultStore` | 検査済み画像をメモリ保持。既定TTL 300秒、最大10終了プレイ、全体128MiB | 動画分の容量設計とTTL変更が必要 |
| `AiService.registerMedia()` | 有効プレイ中の登録が必要、期限は画像用。既存generationはテキストからの画像のみ | 終了前に専用permitを予約。脚本・参照画像編集を予算管理下に追加する |
| `tools/deploy.ts` / 両workflow | OPENAI_API_KEY等をEnvironmentからサーバーへ注入。fal設定なし | GitHubに保存するだけでは使えない。渡すコードも追加する |

ユーザー追加方針: 結末は舞台ごとの固定文ではなく、提示した伏線と確定した行動結果に合わせて生成する。直近2行動は映像の候補範囲であり、物語入力の全範囲ではない。序盤の伏線を保つため、表示用チャットとは別に出典付きの提示履歴を持つ。AI発話は物語上の提示内容として扱い、確定factsや勝敗を変更する権限にはしない。

## 技術判断

### falへの非同期送信

Decision: Nodeのfetchを使う型付きtransportでsubmit / status / result / cancelを分離する。入力は公開画像URLを発行せず、上限付きJPEGのdata URIを使う。request IDと応答の照会URLを検証して保持する。

Rationale: [falのモデルAPI](https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api)に開始・終了画像、data URI、キュー送信・状態取得・結果取得が記載されている。既存Nodeサーバーに統合できる。

Alternatives: Python CLIの子プロセス実行は対話承認・ローカル素材・状態ファイルへの依存が強い。同期の長いHTTP要求はリロード時の重複とタイムアウトの扱いが難しい。Webhookは今回の単一プロセス構成には必須でない。

### 再送と停止

Decision: submitは最大1回。`X-Fal-No-Retry: 1`を指定し、送信結果不明時は自動再送しない。照会は有限回・有限時間。上流URLのoriginとパスを検査し、APIキーを他ホストへ送らない。

Rationale: [fal Queue](https://fal.ai/docs/documentation/model-apis/inference/queue)はクライアント待機期限と上流停止を区別している。処理中のキャンセルは停止保証ではない。公開メディアURLも認証の代替ではない。

Alternatives: POSTの一般的な自動リトライは二重課金の懸念がある。ローカルAbortだけを上流キャンセル成功とみなすことはできない。

### 開始・終了画像

Decision: 現行のIMAGE_MODEL設定を使用し、Image APIの画像編集経路を追加する。サーバーで用意した参照JPEGを送る。既存の画像生成・検査の全体予算と並列制限を共有し、エンディング専用の局所試行上限を設ける。

Rationale: 既存の`OpenAITransport`には`images/generations`のみ。デモの`flare_image.py`は参照がある場合`images.edit`を使用する。[OpenAI画像生成ガイド](https://developers.openai.com/api/docs/guides/image-generation)はImage APIの編集とFlareの指定を説明している。

Alternatives: 最終画像を無加工でH3に渡すだけでは文字入り終了画像の現行制作手順を満たさない。文字だけをブラウザで重ねる実装も今回の移植対象とは異なる。

### 公開サーバーの寿命と保持

Decision: 結果と動画を所有者認証付きの有限メモリで保持し、動画配信は同一originのHTTP endpointを使う。動画のメモリ上限を設定する。終了時に専用permitを登録し、通話のretireと動画ジョブを分離する。

Rationale: 現行仕様は終了後の画像受信を認め、永続保存は行っていない。動画のためにDB・S3・別workerへ広げる必要はない。

Alternatives: fal URLの直接配信はアプリの認証境界を引き継がない。再起動後の回収を保証するなら永続ジョブ保存が必要で、今回の範囲を超える。

## 費用の読み方

[fal公式料金](https://fal.ai/models/minimax/h3-max-turbo/image-to-video)は2026-09-14確認時、768Pが割引中0.01 USD/秒、9月14日の割引終了後は0.04 USD/秒と記載。15秒の通常価格は動画部分のみ0.60 USD。切替時刻・請求への適用はここでは保証しない。画像編集、画像検査、脚本生成の費用を別途加算する。実運用前に再確認する。

## GitHub設定

[GitHub公式Secrets手順](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)にEnvironment secretsの追加方法がある。本リポジトリは`development` / `judging`をworkflowが明示しているため、それぞれへFAL_KEYを登録する方法を案内する。値の登録・確認をチャットやログで行わない。

## 未検証事項と対応

APIアカウントの権限、素材2枚での実H3生成、待ち時間、映像の文字・連続性・演技、スマホの音声付き再生、5人分のメモリは実検証待ち。自動fakeテストは接続成功・映像品質の根拠にしない。
