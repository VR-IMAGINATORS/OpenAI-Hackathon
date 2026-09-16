# シナリオの編集

Web版の既定は `scenarios/story-catalog.json`（version 3）。モック版の6舞台・10ギミック・18構成を収録し、新しいプレイの開始時に18構成から1つを等確率で選ぶ。舞台と3つのギミック順、言語、制限時間はそのプレイ中固定する。

1. `scenarios/story-catalog.json` を編集する。
2. `npm run validate:scenario -- scenarios/story-catalog.json` で検証する。全18構成を実行用シナリオへ変換して検査する。
3. ローカルでは次に新しく開始したプレイへ反映する。進行中のプレイは変わらない。AWSでは再デプロイする。

| フィールド                 | 役割                                                      |
| -------------------------- | --------------------------------------------------------- |
| `title` / `playerBriefing` | 開始前に公開する共通の概要（日英）                        |
| `rules.totalTimeSeconds`   | 制限時間。既定300秒。難易度を調整するときの共通設定箇所   |
| `rules.initialCredits`     | 初期クレジット。既定1000。30以上100000以下の10の倍数 |
| `rules.maxPhotosPerSend`    | 1回の送信にまとめられる写真の上限。既定2枚 |
| `story`                    | AIの名前、世界観、序盤・中盤・終盤の展開方針              |
| `scenes`                   | 舞台、謎、最初の手掛かり、採用できるギミック順            |
| `gimmicks`                 | 障害の仕組み、現在の状況、突破条件、段階ヒント            |

日英の文章は `{ "ja": "日本語", "en": "English" }` の形式。日本語マスターの移植元は `.agents/skills/call-to-past/assets/masters.json`。Web実行時にスキルファイルは読み込まず、Web用カタログを使用する。

### 現在の目標の書き方

`gimmicks[].objective.ja/en` は本編の「現在の目標 / Current objective」に表示する必須の短文。対象と達成したい状態を動詞で示す。`name` はマスター由来の障害名で、目標欄には使わない。実行用シナリオの `obstacle.title` へは `objective` が渡る。目標を追加・変更するときは、採用される全構成と両言語を確認する。

| 障害名 (`name`) | 表示する目標 (`objective.ja`) | 英語 (`objective.en`) |
| --- | --- | --- |
| 椅子のロープ結び | 椅子につながるロープを外す | Free your arms from the chair |
| 曇った覗き窓 | 曇ったのぞき窓の向こうの経路を確認する | Check the route beyond the fogged window |

「切る」「拭く」など特定の解き方や道具を目標に固定せず、解き方はプレイヤーが考えられる表現にする。詳しい突破条件や代表解を含む内部の `goal`、`acceptance`、`mechanism` はそのまま表示しない。旧V2ファイルを明示指定する場合は、従来どおり `obstacles[].title.ja/en` に目標文を書く。

物語の答えは固定の正解台本として追加しない。選ばれた舞台の謎と最初の手掛かりを提示し、その後は実際の会話・道具・突破内容に沿ってAIが展開を作る。物語段階は完全突破数に合わせて進み、部分的な前進では進めない。終了時の回収と動画・結果画面は別機能の担当範囲（[連携メモ](../specs/story-integration/ending-handoff.md)）。

道具の正解リストは設けない。各ギミックの仕組みに対して提案が成立するかを判断する。ヒントは求められたときに現在の障害のものを段階的に使い、後の障害を先に明かさない。

## 制限時間と運用上限

ゲームの時間は `rules.totalTimeSeconds` で管理する。環境変数 `PLAY_TTL_SECONDS` は接続開始からのプレイ枠の寿命で、別の設定。接続待ち（`RECOVERY_GRACE_SECONDS`）、ゲーム待機枠60秒、終了処理12秒を含めて収まる必要がある。

既定のプレイ枠600秒・接続待ち60秒では、ゲーム時間は最大468秒。枠に収まらない設定は起動時・新規開始時に拒否する。進行中の時計を途中で短縮しない。環境変数の変更にはサーバー再起動が必要。開始画面ではスタンダードProプラン（300秒・1000）、ハードPlusプラン（240秒・750）、ヘル無料プラン（180秒・500）を選べる。難易度指定時は `packages/shared/difficulty.ts` のプリセットを適用し、未指定APIではシナリオ設定を使う。

会話1往復30、写真は1枚150（2枚300）。写真の説明・自動行動は写真費用に含む。手持ちの再利用は音声指示30だけで、新しい写真は不要。撮影・プレビュー・自動の状況説明・生成画像・動画・誤認の訂正は無料。処理前に予約し、AI失敗時は返却、同じ要求の再送は追加消費しない。残高30未満は受理済みの最後の応答・行動を確定後に終了し、その行動で脱出できた場合は勝利を優先する。運用API予算はゲーム内クレジットとは別に維持する。

## 既存シナリオとの互換性

旧 `rules.maxPhotoSends` / `rules.maxActions` は廃止し `rules.initialCredits` に移行する。1送信あたりの枚数上限 `rules.maxPhotosPerSend` は維持。旧キーは検証で拒否し、標準JSONは移行済み。公開状態の残量は `creditsRemaining`、初期値は `initialCredits`。確定行動数は `actionsUsed` として別に保持する。詳細は [AI利用クレジット](../specs/game-credits/spec.md)。

旧Web版は `.env.local` の `SCENARIO_PATH=scenarios/mobile-playtest.json` で明示的に選べる（version 2）。設定を省略すると6舞台になる。`npm run play:mobile` もこの指定に従う。`scenarios/default.json`（version 1）は構成の参考資料で、統合サーバーの実行対象ではない。

スキーマは `packages/shared/story-catalog.ts` と `packages/shared/scenario.ts`。参照ミス、ID重複、不正な状態値、範囲外の数値などを拒否する。構造検証の成功だけでは、実AIの物語品質、音声体験、謎の面白さを保証しない。これらは実機での試遊が必要。
