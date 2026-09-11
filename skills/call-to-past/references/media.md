# 各ターンの未来画像

game.pyのイベント描画packetを入力にする。現在の全contextをそのまま使うと次の障害を早出しする可能性があるため、処理済み障害とそのイベントの結果だけを描く。

各ターンは現在の障害と道具を中心に寄った構図にする。別の拘束部位や出口設備は画面外・衣服・暗部で隠し、まだ扱っていない部位を「拘束されていない」と確定させる全身画も避ける。未公開の障害を後から追加したように見える矛盾を防ぐ。

OpenAI Images APIの `gpt-image-2.5-flare` を `quality=low`、`1536x1024`、1枚で用いる。ローカル参照画像は事前に閲覧する。APIキーは環境変数または利用者が指定した資格情報ファイルから読み、値を出力・保存しない。

最初の画像API送信より前に、`uv run --with "openai>=2.26,<3" --with "pillow>=11,<13" python -X utf8 scripts/flare_image.py ... --preflight-only` を実行する。これは画像APIを呼ばず、Python、検証済み範囲のOpenAI SDK/Pillow、OpenAI用APIキー、プロンプト、参照画像、リンクを含まない新規出力先、SDK引数互換性を検査する。結果の `request` にあるモデル設定、プロンプトと参照画像のSHA-256、出力先に加え、最新価格・確認日時・出典を利用者へ提示し、具体的な承認を得る。承認内容を `approved: true`、`approved_at`、`approval_note`、`price_checked_at`、`price_source`、`estimated_usd`、同一の `request` を持つJSONへ保存する。その後だけ、同じ引数から `--preflight-only` を外し `--approval-json` を加えて1回実行する。CLIは `max_retries=0`、出力先の排他的予約、厳密Base64/PNG検証を行う。失敗後は再実行せず、`request_id`、`reserved_output` とAPI側の状態を確認する。preflightはモデルのアカウント利用可否までは保証しない。

生成に使ったプロンプト、参照画像のセッション内パス、event ID、生成経路、生成結果のファイルパスをセッション内の新規JSONに残す。画像の見た目を確認した内容はその範囲を記す。キーや原本の不要な個人情報は記録しない。

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
