# 各ターンの未来画像

game.pyのイベント描画packetを入力にする。現在の全contextをそのまま使うと次の障害を早出しする可能性があるため、処理済み障害とそのイベントの結果だけを描く。

各ターンは現在の障害と道具を中心に寄った構図にする。別の拘束部位や出口設備は画面外・衣服・暗部で隠し、まだ扱っていない部位を「拘束されていない」と確定させる全身画も避ける。未公開の障害を後から追加したように見える矛盾を防ぐ。

native imagegenを用いる。ローカル参照画像は事前にview_imageで見る。画像にローカルパスがある場合はreferenced_image_paths、パスがない添付を扱う場合だけ必要最小数のnum_last_images_to_includeを使う。両者を同時に使わない。モデル指定欄がないので生成モデルは`Codex native imagegen (model not exposed)`と記録。

現在のCodexでは生成結果のoutput_hintに`$CODEX_HOME/generated_images/...`の保存先が返ることを実測した。その明示された実ファイルをコピーし、原本は残す。環境が変わってパスを返さない場合は、提供されたexport機能か利用者による保存で実ファイルを得るまで添付完了にしない。直接OpenAI APIへ勝手に切り替えない。

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
