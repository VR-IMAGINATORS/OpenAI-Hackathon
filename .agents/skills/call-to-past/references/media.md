# 各ターンの未来画像

## 初回状況画像

`game.py start`がliveセッションを作り、返却された公開contextに`phase: "action"`、`scene`、`current_gimmick`が揃った時点を、場面と最初のギミックの選出完了とする。導入後の最初の攻略入力を待つ前に、Codex内蔵`image_gen`で緊急端末カメラから見える状況画像を1枚生成する。この生成は攻略行動ではなく、`prepare`や`commit`を実行しない。

画像生成へ渡してよいのは、公開contextの`scene.name`、`scene.description`、`scene.anchor`、必要な場合だけ初期伏線としての`scene.mystery`、および`current_gimmick.name`と`current_gimmick.observation`だけ。`hints`、全マスター、後続ギミック、reference solutionは渡さない。まだ具現化物がない初期状態として、便利な道具、未公開の拘束や出口機構、人型AI、顔、流血、UI、字幕を追加しない。

生成結果はセッションへ`initial-context-native.png`のような別名でコピーし、元の内蔵生成ファイルは残す。同名がすでにある場合は上書きせず、不一致または別版を保持するときは`initial-context-native-v2.png`のように版を分ける。未公開障害、便利な道具、解法例、顔、UI、字幕、余分な人物や手がないこと、現在の障害が理解できることを目視確認する。不合格画像は表示せず保存したまま、違反点だけを直すプロンプトで別版を生成・再確認する。表示可能と確認できた画像だけを採用し、導入の所定位置で一度だけユーザーへ表示する。

生成経路、実際のプロンプト、session ID、scene ID、gimmick ID、各出力ファイル、SHA-256、目視確認結果を`initial-image-generation.json`へ保存する。記録には`status`（`pending` / `ready` / `shown`）、`shown_at`、版ごとの検査履歴を持たせ、更新時も過去の版と状態遷移を残す。再開時はこの記録を読む。`pending`なら同じ初回画像作業を続け、`ready`なら画像を再検査して一度だけ表示し`shown`へ更新し、`shown`なら重複表示しない。記録がなくても攻略行動またはイベントがすでに始まっている旧セッションには、未行動状態の初回画像を新規生成しない。

初回状況画像を、最初のイベント結果画像における人物・衣装・空間・照明・緊急端末位置の基準画像として使う。内蔵生成が失敗・利用不能なら`pending`のまま成功扱いにせず、セッションを再開可能な状態で止めて理由を伝える。外部APIへ切り替える場合は、攻略結果用のevent IDや`attach-image`を使わない。下記のpreflight、最新価格提示、具体的承認、一度だけの送信、曖昧失敗時の非再送だけを適用し、初回専用記録へ保存する。出力名は`initial-context-flare.png`のように経路を区別する。

初回用プロンプトの骨格：

```text
High-quality realistic 3D mystery adventure game still, cinematic lighting, landscape 16:9.
View from the established emergency-terminal camera in the selected scene.
SCENE: [scene.name、scene.description、scene.anchor]
INITIAL CLUE: [必要な場合だけscene.mystery。読める文字やUIにしない]
CURRENT OBSTACLE ONLY: [current_gimmick.name、current_gimmick.observation]
Show the exact untouched state before any tool is materialized or action is attempted.
Frame the current obstacle clearly enough for the player to understand what is blocked.
The same androgynous adult survivor wears a charcoal hooded jacket and plain gray trousers.
Hide the eyes and full face. The AI has no humanoid body.
No useful loose tools, solution example, extra hands, robot, hologram, gore, captions or UI.
Keep every later obstacle and unrelated exit fixture outside the frame or hidden in darkness.
```

## 攻略結果画像

game.pyのイベント描画packetを入力にする。現在の全contextをそのまま使うと次の障害を早出しする可能性があるため、処理済み障害とそのイベントの結果だけを描く。

各ターンは現在の障害と道具を中心に寄った構図にする。別の拘束部位や出口設備は画面外・衣服・暗部で隠し、まだ扱っていない部位を「拘束されていない」と確定させる全身画も避ける。未公開の障害を後から追加したように見える矛盾を防ぐ。

OpenAI Images APIの `gpt-image-2.5-flare` を `quality=low`、`1536x1024`、1枚で用いる。ローカル参照画像は事前に閲覧する。APIキーは環境変数または利用者が指定した資格情報ファイルから読み、値を出力・保存しない。

`$CallToPast` は読み込んだ `SKILL.md` の親フォルダの絶対パスに設定する（[CLI 手順](cli.md)参照）。作業フォルダはプレイ用のフォルダのまま維持する。

最初の画像API送信より前に、`uv run --with "openai>=2.26,<3" --with "pillow>=11,<13" python -X utf8 "$CallToPast/scripts/flare_image.py" ... --preflight-only` を実行する。これは画像APIを呼ばず、Python、検証済み範囲のOpenAI SDK/Pillow、OpenAI用APIキー、プロンプト、参照画像、リンクを含まない新規出力先、SDK引数互換性を検査する。結果の `request` にあるモデル設定、プロンプトと参照画像のSHA-256、出力先に加え、最新価格・確認日時・出典を利用者へ提示し、具体的な承認を得る。承認内容を `approved: true`、`approved_at`、`approval_note`、`price_checked_at`、`price_source`、`estimated_usd`、同一の `request` を持つJSONへ保存する。その後だけ、同じ引数から `--preflight-only` を外し `--approval-json` を加えて1回実行する。CLIは `max_retries=0`、出力先の排他的予約、厳密Base64/PNG検証を行う。失敗後は元APIを再実行せず、`request_id`、`send_state`、`reserved_output`を保存し、下記の内蔵生成へ切り替える。API側の課金・完了状態が不明でも、その確認を切替の前提にしない。preflightはモデルのアカウント利用可否までは保証しない。

生成に使ったプロンプト、参照画像のセッション内パス、event ID、生成経路、生成結果のファイルパスをセッション内の新規JSONに残す。画像の見た目を確認した内容はその範囲を記す。キーや原本の不要な個人情報は記録しない。

最初の結果画像を人物・衣装・空間の基準として保存する。以後はその基準と直前の結果画像、今回の物体写真を参照する。写真原本を変えず、生成したファイルをイベントへ添付・コピーする。1回の判定に必要なのは1枚。失敗時の再生成は同じevent IDに結び付ける。

[Story.md](../Story.md)の実体を持たないAIと緊急端末の設定に合わせる。操作主体を描くために人型AIや余分な手を足さず、道具が対象へ力を伝える状態を見せる。端末を見せる場合は最初の位置・外観を固定し、既存画像と矛盾する場合は画面外に置く。

## API失敗時はCodex内蔵生成へ切り替える

APIキーの未設定、preflightの依存関係エラー、APIエラー、応答回収失敗、画像なし・0バイトなどで結果画像を得られない場合は、切替を短く伝えてCodex内蔵`image_gen`を使う。このスキルの標準フローとして切替が許可されているため、利用者に再確認しない。内容の安全上の拒否を別経路で回避してはならず、その場合は拒否された内容を見直す。

1. APIの失敗情報（判明したrequest ID、send_state、出力先）と切替理由を、セッション内の`image-generation-turn-XX.json`等へ保存する。`maybe_sent`は未確定のまま保持し、APIで失敗確定・未課金だったと書き換えない。0バイトの予約ファイルと既存の承認・プロンプトも残す。
2. 同じevent IDのrender-packet、同じ物体写真、既存の人物・空間の基準画像を内蔵ツールへ渡す。写真を閲覧してから使い、参照画像の入力方法は利用できる内蔵ツールの仕様に従う。ローカルパスを読めなくても、同一写真が会話で実際に表示済みなら、その会話画像を参照できる方法を使う。未確認の画像や内部パスを推測しない。
3. 誤字やAPI専用指定は整理してよいが、道具・構図の意図・確定した成否は維持する。実際の内蔵生成プロンプトを別名で保存する。APIキーとFlareのpreflightは内蔵生成には不要。Flareのモデル名・low設定・料金見積を内蔵生成の実績として流用せず、無料とも断定しない。
4. 生成された実ファイルをプレイ保存先へ`result-turn-XX-native.png`等の別名でコピーする。目視確認後、同じevent IDに`attach-image --media-kind generated --provenance "Codex built-in image_gen; API failure fallback; model undisclosed"`で登録する。認識・判定・commitは繰り返さず、行動回数や在庫を変えない。
5. 生成経路・プロンプト・参照画像・実出力・SHA-256・確認結果に加え、`preferred_image_route: codex_builtin`を同じ記録へ保存する。これはエージェントが再開時に読む記録で、game.pyが自動処理する設定ではない。そのプレイの以後の画像は内蔵生成を継続する。元APIの遅延結果が後で得られても、選択済み画像を自動で差し替えない。

内蔵生成も失敗・利用不能なら、同じイベントを画像待ちで保持して理由を伝える。勝手にAPI経路へ戻ったり、別の有料生成を追加したり、文章版として画像を省略したりしない。文章版は利用者が明示選択した場合だけwaiveする。画像の切替はH3動画の生成・承認・request ID回収の手順を変更しない。

## プロンプトの骨格

```text
High-quality realistic 3D mystery adventure game still, cinematic lighting, landscape 16:9.
The same androgynous adult survivor throughout: charcoal hooded jacket, plain gray trousers,
no identifiable face; rear view or crop at mouth level, never eyes or full face, no gore.
Future AI physically operates the materialized object(s) at the caller's direction.
The AI is disembodied and controls only the materialized tools through its emergency
terminal. No humanoid AI, robot, extra hands, or direct force on an obstacle without a tool.
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
