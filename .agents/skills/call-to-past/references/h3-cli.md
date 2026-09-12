# H3エンディング動画CLI

この経路は本スキルに同梱した `minimax/h3-max-turbo/image-to-video` の実装を使い、**768P・15秒・1本・balanced** に固定する。別途`h3-video`スキルをインストールする必要はない。開始画像と終了画像は必須で、同じピクセル寸法・縦横比にする。R2V、複数候補、別尺、別解像度への切替は、この承認枠に含めない。`--seed` は比較目的などで利用者が値を明示した場合だけ `prepare` に加える。

`media.py` はローカル準備、承認記録、一度だけの送信、保存済みrequest IDの回収を分離する。今回のスキル実装承認はfalへの外部送信承認ではない。`approve` は、利用者から既に得た具体的な承認をそのまま保存するだけであり、コマンド実行自体が承認を作ることはない。

## 1. 最新価格からcost-planを作る

送信直前に [fal公式H3 Turbo I2Vページ](https://fal.ai/models/minimax/h3-max-turbo/image-to-video) で動画単価を確認し、同時点のUSD/JPYを用意する。`pricing-checked-at` はタイムゾーン付きISO-8601で記録する。24時間を超えた見積、未来日時、非fal URL、非有限値・0以下の単価/為替、不整合なUSD/JPY計算は拒否される。

PowerShell例。`$CallToPast` は読み込んだ `SKILL.md` の親フォルダの絶対パスに設定する（[CLI 手順](cli.md)参照）。作業フォルダはプレイ用のフォルダのまま維持する。`$Session`、単価、為替、日時も実値へ置き換える。

```powershell
$CallToPast = "<INSTALLED_CALL_TO_PAST_SKILL>"
$Session = "<SESSION_DIRECTORY>"
python "$CallToPast\scripts\estimate_cost.py" `
  --mode i2v `
  --resolution 768P `
  --duration 15 `
  --video-rate "<CURRENT_USD_PER_SECOND>" `
  --usd-jpy "<CURRENT_USD_JPY>" `
  --pricing-source "https://fal.ai/models/minimax/h3-max-turbo/image-to-video" `
  --pricing-checked-at "<ISO_8601_WITH_TIMEZONE>" `
  --output "$Session\ending-cost-plan.json"
```

I2Vの参照トークンは0でなければならない。cost-planの合計はH3動画リクエストだけであり、Codex利用分、native画像生成、判定、物語生成、その他プロバイダーの費用を含まない。

## 2. 承認用スナップショットを固定する

`$Run` はまだ存在しない新しいディレクトリを指定する。元ファイルは変更せず、prompt、開始画像、終了画像、cost-planを `$Run\approval-snapshot\` へコピーし、全文・寸法・SHA-256・費用内訳を `approval-manifest.json` にまとめる。

```powershell
$Media = "<CALL_TO_PAST_SKILL>\scripts\media.py"
$Run = "$Session\ending-h3-001"
python $Media prepare `
  --run-dir $Run `
  --prompt-file "$Session\ending-prompt.txt" `
  --start-image "$Session\ending-start.png" `
  --end-image "$Session\ending-end.png" `
  --cost-plan "$Session\ending-cost-plan.json"
```

利用者がseedを明示した場合だけ、上記へ `--seed <INTEGER>` を加える。

次で承認対象を再表示できる。

```powershell
python $Media show --run-dir $Run
```

利用者へ、少なくとも次を一緒に提示する。

- falへ送る開始画像と終了画像そのもの
- プロンプト全文
- endpoint、768P、15秒、1本、balanced、seedの有無
- 4ファイルのSHA-256とmanifest SHA-256
- 公式価格URL、確認日時、動画単価、USD/JPY、USD/円の合計
- 表示額はH3動画だけで、native/Codex等の費用を含まないこと
- 画像2枚とプロンプトをfalへ外部送信すること

## 3. 利用者の具体的承認を記録する

上記の内容を見た利用者が、この1本の外部送信を明示的に承認した後だけ実行する。`<MANIFEST_SHA256>` は `prepare` または `show` が表示した値、`--approval-text` は利用者の実際の返答を改変せず指定する。承認文が複数行ならUTF-8ファイルを作り、`--approval-evidence-file <FILE>` を使う。

```powershell
python $Media approve `
  --run-dir $Run `
  --manifest-sha256 "<MANIFEST_SHA256>" `
  --approval-text "<VERBATIM_USER_APPROVAL>"
```

マニフェストが承認前後に1バイトでも変われば、承認とのハッシュ照合で送信を停止する。

## 4. 1回だけ送信する

`FAL_KEY` が環境にあれば最優先で使う。未設定の場合だけ `--credentials-file` を読み、その中の `fal.ai` Markdownセクションから候補が厳密に1つ見つかった場合に限り使う。別セクションの値、falセクションが複数、候補0件/複数件は拒否する。キー値は子プロセス環境だけへ渡し、標準出力・標準エラーを保存しない。資格情報ファイルの実パスや値を配布例へ書かない。

`submit`、`status`、`result` は常に`call-to-past`内の同梱ランタイムを使う。見積・送信・QCの3スクリプトのいずれかが欠けていれば停止し、`call-to-past`の再インストールを案内する。外部スキルや任意パスへ切り替えるCLI引数は持たない。

```powershell
python $Media submit `
  --run-dir $Run `
  --credentials-file "<LOCAL_CREDENTIALS_FILE>"
```

送信直前にマニフェスト、承認、4スナップショット、画像寸法、固定設定、価格鮮度を再検証する。検証後、アップロードより先に `submission-attempt.json` を排他的に作る。この記録が存在するrunでは二度目のsubmitを拒否する。

同梱 `scripts/generate_h3.py` を1回だけ起動し、同じbatch・request slot 1を使う。アップロード失敗、タイムアウト、子プロセス異常、request ID欠落を含め、試行記録後の失敗は `submission-uncertain.json` として扱う。受付されなかったと推測しても自動再POSTしない。依存スクリプトが既知キーをエラー文へ含めた場合は、run配下のJSON/TXT/LOGから値を伏せてから報告する。

## 5. 保存済みrequest IDだけを照会・回収する

`status` と `result` は `$Run\h3\request-id.json` のendpoint/request IDだけを読む。コマンドラインから別IDを渡す欄はなく、新しいsubmitへ切り替わらない。

```powershell
python $Media status `
  --run-dir $Run `
  --credentials-file "<LOCAL_CREDENTIALS_FILE>"

python $Media result `
  --run-dir $Run `
  --credentials-file "<LOCAL_CREDENTIALS_FILE>"
```

取得ごとに `$Run\h3\retrievals\<取得ID>\ending.mp4` という新しい場所を使う。途中失敗の `.part` は証拠として残し、同じ保存済みrequest IDを次の新規取得ディレクトリで再照会する。statusはproviderの保存JSONから `QUEUED` / `IN_PROGRESS` / `COMPLETED` / `FAILED` を推定し、判断材料がない場合は `UNKNOWN` と表示する。status/resultの通信失敗でもsubmitは再実行しない。

result成功時は同じ取得ディレクトリへ `receipt.json` を排他的に保存し、標準出力の `receipt_file` にそのパスを返す。receiptはversion 1、endpoint、保存済みrequest ID、承認manifest SHA-256、開始・終了画像SHA-256、実際に取得した `ending.mp4` のSHA-256とbytes、完了日時を固定する。作成前後にmanifest、承認、4スナップショット、保存済みrequest IDを再照合するが、既に承認・送信済みの結果回収なので価格の24時間鮮度は要求しない。ゲームへ動画を添付するときは、このreceiptとH3 runを一緒に渡し、receiptまたは動画が後から変わっていないことを照合する。

## 6. 動画QC

動画を取得してから、同梱QCスクリプトの検査を新しい出力先で実行する。

```powershell
python "$CallToPast\scripts\verify_and_concat.py" `
  --clip "<RETRIEVED_ENDING_MP4>" `
  --output "$Run\qc\ending-qc-copy.mp4" `
  --report "$Run\qc\report.json" `
  --qa-dir "$Run\qc\frames" `
  --expected-duration 15 `
  --sample-count 12

ffprobe -v error `
  -show_entries "stream=index,codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels:format=duration" `
  -of json "<RETRIEVED_ENDING_MP4>"
```

環境音・効果音を予定しているため、ffprobe結果にaudio streamがない動画は合格にしない。`verify_and_concat.py` のA/V差判定は音声なしでも真になり得るので、音声streamの存在と実際の聞こえ方を別に確認する。

さらに動画を15秒すべて再生し、開始/終了フレームへの整合、同一人物・衣装・空間、顔が目まで露出していないこと、実際の行動とエンドの一致、字幕・タイトル混入、音量・SEを目視・試聴する。12枚の均等抽出は途中破綻の標本であり、全フレーム確認済みとは扱わない。これらを実行していないローカルテストは「H3実生成・動画QA済み」と報告しない。
