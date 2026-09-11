# 各ターンの未来画像

game.pyのイベント描画packetを入力にする。現在の全contextをそのまま使うと次の障害を早出しする可能性があるため、処理済み障害とそのイベントの結果だけを描く。

各ターンは現在の障害と道具を中心に寄った構図にする。別の拘束部位や出口設備は画面外・衣服・暗部で隠し、まだ扱っていない部位を「拘束されていない」と確定させる全身画も避ける。未公開の障害を後から追加したように見える矛盾を防ぐ。

`imagegen`スキルを読み、同スキルのCLIをAPI経路として用いる。モデルは`gpt-image-2.5-flare`、標準は`quality=low`、`size=1536x1024`、`n=1`、`output-format=png`。出力先は最初からセッション内の一意なファイル名へ固定し、生成後の保存先探索を行わない。`uv run --with openai`を使えばSDKをプロジェクトへ恒久追加せずキャッシュできる。

最初の外部送信前にOpenAI公式モデルページで利用可否と最新単価を確認する。送信先、モデル、品質、サイズ、セッション中の最大生成枚数、送る写真/生成画像/プロンプトを示して明示承認を得る。同じ条件と承認済み枚数内は再確認しない。条件変更、上限超過、再生成は再承認する。曖昧な失敗やタイムアウトでは再送せず、同じ出力/requestの状態を確認する。

APIキーは`OPENAI_API_KEY`、または利用者が明示したローカル資格情報ファイルからプロセス環境へ読み込む。キー値を標準出力、チャット、プロンプト、履歴JSON、配布物へ書かない。固定の個人パスをスキルへ埋め込まない。

新規の場面画像は`generate`、人物・衣装・空間・道具写真を引き継ぐイベント画像は`edit`を使い、参照画像を意味のある順序で`--image`へ渡す。入力画像は事前に閲覧する。Flareが利用不能、または指定パラメータを拒否した場合は勝手に別モデルや品質へ変更せず止める。

`$ImageGen`には、スキル一覧で確認した`imagegen/scripts/image_gen.py`の実在する絶対パスを設定する。パスを推測せず、実行前に`--help`または`--dry-run`で確認する。

```powershell
uv run --with openai python -X utf8 $ImageGen generate `
  --model gpt-image-2.5-flare --prompt-file $Prompt `
  --n 1 --size 1536x1024 --quality low --output-format png --out $Output

uv run --with openai python -X utf8 $ImageGen edit `
  --model gpt-image-2.5-flare --image $PreviousImage --image $ObjectPhoto `
  --prompt-file $Prompt --n 1 --size 1536x1024 --quality low --output-format png --out $Output
```

生成に使ったプロンプト、参照画像のセッション内パス、event ID、APIモデル、品質、サイズ、生成経路、経過秒、生成結果のファイルパスとSHA-256をセッション内の新規JSONに残す。画像の見た目を確認した内容はその範囲を記す。キー、資格情報ファイルの内容、原本の不要な個人情報は記録しない。

最初の結果画像を人物・衣装・空間の基準として保存する。以後はその基準と直前の結果画像、今回の物体写真を参照する。写真原本を変えず、生成したファイルをイベントへ添付・コピーする。1回の判定に必要なのは1枚。失敗時の再生成は同じevent IDに結び付ける。

## プロンプトの骨格

```text
High-quality realistic 3D mystery adventure game still, cinematic lighting, landscape 16:9.
The same androgynous adult survivor throughout: charcoal hooded jacket, plain gray trousers,
no identifiable face; rear view or crop at mouth level, never eyes or full face, no gore.
Future AI physically operates the materialized object(s) at the caller's direction.
SCENE ANCHOR: [保存されたscene anchor、既存の基準画像]
CURRENT EVENT ONLY: [そのイベントで試した障害、行動、確定済み成否]
MATERIALIZED OBJECTS: [写真由来の物と観察された材質・形]
COMPOSITION: [別々なら両方、組み合わせた場合は組み合わせた1つの状態]
REMAINING INVENTORY: [使用可能な持越品のみ。消費物や合成元を複製しない]
Show the physical result clearly. Do not add puzzles, reveal later obstacles, change the
committed success/failure, add readable captions, UI, ending labels or a visible face.
Use a close composition on this obstacle and its tools; keep all other body restraints
and exit fixtures out of frame or occluded. Do not establish the unseen body as unrestrained.
```

生成後に画像を閲覧し、具現化物・合成状態・成否・未公開障害・顔の露出を確認する。技術的にPNGが開けることと見た目の合格は別。違えばその画像を保存したうえで同じイベントの画像だけ修正し、判定を再実行しない。画像の再生成やイベント単位のwaiveは次の行動をprepareする前、かつ物語・エンディング成果物を作る前に済ませる。進行後に過去画像を差し替えて履歴の根拠を変えない。

画像が利用不能なら未完了として止め、再開できる状態を残す。ユーザーが文章版を明示選択した場合だけwaiveする。その記録は実画像確認の成功と数えない。
