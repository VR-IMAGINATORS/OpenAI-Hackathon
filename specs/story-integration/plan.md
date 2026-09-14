# 6舞台取り込みの実装計画

Status: implementation authorized (2026-09-14)

合意済みspecに対して「実装できた？きりがいいところでコミットしてね」と実装・コミットの依頼を受領。以下の通常の実装判断はこの依頼の範囲で進める。本文を逐条承認されたことや、独立レビュー済みであることは意味しない。AGENTS.mdに従いマルチレビューを実施しない。技術スタック・認証・公開構成・実APIの追加選定は行わない。

## 実装方針

作業フォルダは `artifacts/story-integration` の独立worktree、ブランチは `codex/story-integration`。別AIの未コミット変更をコピーして取り込まない。新規のcatalogを既存ScenarioV2へ変換してGameSessionへ渡すため、既存音声・写真・画像・状態管理を使い続ける。

### P1: マスターと型

- 新規 `packages/shared/story-schema.ts`: 物語の共通型。`StoryContext` は `aiName / world / mystery / openingClue` の日英文字列と `phases: { opening, middle, final }` の日英文字列を持つ。
- 変更 `packages/shared/scenario.ts`: V2へ任意の `story: StoryContext`、各障害へ任意の `mechanism`（日英）、`hints`（日英配列）、`completionFact: { key, value }` を追加。旧V1/V2を保持する。機構・ヒントは公開概要に出さない。
- 新規 `packages/shared/story-catalog.ts`: version 3のカタログを厳密に検証し、`parseStoryCatalog(raw)` と `compileStoryScenario(catalog, candidateIndex): ScenarioV2` を公開。全18候補はscene順・sequence順に数える。`storyCandidateCount(catalog)` で候補数を返す。
- 新規 `scenarios/story-catalog.json`: 元マスターv2の6舞台・10障害・18構成。元IDを維持し、日英の観察・機構・段階ヒントと、共通の300秒/4行動/2写真を格納。storyの共通設定・初期の謎・人物/空間を取り込む。
- 各選出障害について固有factを持ち、`blocked → partial → cleared` または `blocked → cleared` を許可する。完全解除の必須factと画像条件を明示する。部分進展の具体的内容は確定situationを併用する。

### P2: 選出と時間設定

- `ScenarioCatalog.current(locale)` はV2単体とV3カタログを受け付ける。V3はサーバーのrandomInt（テストでは注入）で候補を選び、コンパイル後にsnapshotを固定する。開始済みプレイは変わらない。
- `ScenarioCatalog.preview(locale)` を追加し、bootstrap用の共通概要を返す。概要取得で抽選せず、舞台や初期の謎を先出ししない。
- `apps/server/config.ts` と `tools/mobile.ts` の既定を `scenarios/story-catalog.json` にする。明示SCENARIO_PATHの旧V2を維持する。
- `tools/validate-scenario.ts` はV3の全候補もコンパイル検証する。
- 採用ゲーム時間と停止待ち60秒、接続猶予・終了猶予を運用のPLAY_TTL_SECONDS内に収める設定検証を加える。既存の小さいTTLを使うテスト用手製configには新規のゲーム設定検証を強制しない。

### P3: 物語の進行と成立性

- 新規 `apps/local-server/story.ts`: StoryContextから短い導入、現在段階の語り、現在障害の観察を構成する。公開物語文脈は現在舞台・提示した初期の謎・現在段階のみ。後続障害や解法を含めない。
- `live.ts`、`hosted-runtime.ts`: 開始時に選出舞台の導入と初期の謎を実際の表示へ載せる。完全解除0/1/2による語りを更新し、結果後は現在障害を知らせる。固定台詞で語りを完成させず、既存Liveの指示で短い自然な展開・反応を生成する。新しい有料API種別を追加しない。
- `core-intent-ai.ts`: 相談には世界設定と現在の公開物語文脈を渡す。現在障害のヒントは要求時だけ段階的に扱い、将来の障害は渡さない。
- `game-ai.ts`: 現在障害の機構・ヒント・完了条件を判定へ渡す。判定に不要な舞台の謎は渡さず、判定結果の語りは確定前の事実を増やさない。
- `game.ts`: `completionFact` を持つ新シナリオではsuccessと確定factの一致を検査し、未来の障害を変更させない。旧V2の既存テスト・運用との互換を維持する。
- `packages/server/image-service.ts`: 新シナリオでは公開済みの障害までを描画根拠にし、画像の舞台と人物の設定を一致させる。初回画像で後続の装置を先出ししない。
- 別担当の終了判定・StoryEvidenceLedgerには既存の表示/音声通知を通して接続できるようにする。EndingPacket/動画/リザルトの重複実装はしない。統合時の必要差分をhandoffへ残す。

## 検証と完了単位

P1は元マスターとの全ID・18順序・代表物性の対応、日英・不正ID・不正遷移・後続公開防止を検証。P2は抽選固定、bootstrap非抽選、設定変更、新旧カタログ、時間上限を検証。P3は模擬AI入力・10障害の部分進展と完了条件、公開描写、現在段階、音声の既存フローを検証する。

全体で `npm run check`、`npm test`、`npm run build` と変更箇所のformatを確認する。実API・実音声・スマホ・生成画像の意味・面白さは未検証として区別する。P1/P2/P3がまとまり検証後、対象パスだけstageしてコミットする。push・PR・公開更新は今回行わない。

## 自己点検とカバレッジ

- AC01→P1、AC02/AC06→P2、AC03/AC04/AC05/AC10→P3。
- AC07/AC08/AC09は別担当の終了機能との統合条件。こちらは現在舞台・公開描写・確定factを提供し、依存が未統合なら未検証として明示する。
- 隠し障害の画像漏れ、最後の成功とfactの不一致、bootstrapでの再抽選、設定変更による開始済みプレイ変化を具体的な検査対象にした。
- 既存認証・所有権・秘密の扱い・画像費用上限を引き継ぐ。外部の新API契約は追加しないため、別のOpenAPI文書は作らない。

外部issue投稿は依頼されていないため、タスクはローカルの作業記録にする。新しいスコープ判断が必要ならチャットで確認し、通常の実装判断だけで再承認を求めない。
