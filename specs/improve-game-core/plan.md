Status: approved (2026-09-15)

# 調査・推理を中心にしたゲームコア — 実装計画

作成: 2026-09-15 / ブランチ: codex/improve-game-core / PR先: develop
正本: spec.md。ハッカソン向けに既存構成1件で検証する。コード実装・課金通信・新機能テストは未実施。
ユーザー指示により開発マルチレビューは省略。仕様カバレッジを自己点検し、ユーザーが計画を承認済み。

## 1. 方針と初回対象

元資料を固定して拡充し、実ゲームと共通の進行処理で模擬プレイする。既存のオリジナル生成、GPT-Live、認証、写真認識、クレジット・難易度の実装を維持する。新しい公開HTTP APIは作らない。CLIの内部契約は contracts/cli.md、データは data-model.md、調査根拠は research.md。

初回は scenarios/story-catalog.json の candidateIndex=0、scene-echo-platform（暗い倉庫）、gimmick-pressure-latch → gimmick-magnetic-rail → gimmick-thermal-leak。名称で推測せず、実データの目隠し・内扉・出口の内容を使用する。カタログ全文の原文と、この構成の共有設定・物語・ギミック・元解法を固定する。原資料の更新後も採用版を自動再コンパイルしない。

模擬用共通日用品一覧は既存8品にマジックハンド、マイナスドライバー、硬貨、歯ブラシ、洗濯ばさみを追加する。役割・正解・対応ギミックを載せず、通常の物性だけを記載する。元解法に必要な道具の欠落をシナリオ不成立と混同しない。全モデル・全遊び方に同じ一覧を渡す。

## 2. 実装順序

### S1: 固定入力と拡充データ

新規 tools/auto-mission/expansion/{schemas,source,compile}.ts に freezeSource、validatePreservation、compileExpandedScenario を実装。既存 packages/shared/story-catalog.ts の compileStoryScenario を使用し、モデルに構成選択を任せない。

生成物は追加情報と表示文の限定差し替えのみ。障害ID・順序・完了条件・遷移・元の受理条件・例示解法・物理制約・ゲームルールは固定領域としてdigest比較する。初期の情報量を減らす表示文の変更は許容するが、判定用機構は変更しない。文章の意味の矛盾は機械比較だけでは保証できず、独立評価と検証役が扱う。

packages/shared/{scenario,harness}.ts を後方互換の任意項目で拡張し、調査対象、情報種別、初期概要、補完可能な属性、公開画像情報、拡充元の識別子を扱う。既存 known/observable/hidden と前提条件を再利用する。初期概要と詳細の明示的な層を加え、詳細開示に概要を読んだという前提は付けない。全体256 KiB、各文2000文字、知識100件の既存制約内でコンパイルし、超過は生成不備として記録する。

### S2: 実ゲーム処理の共通化（挙動を先に固定）

新規 apps/local-server/game-harness.ts の GameHarness に、GameRuntime の相談確定、写真分類後の判断、行動予約・判定・確定、知識同期、会話クレジット精算を移す。GameSession、KnowledgeStore、classifyCoreIntent、classifyPhoto、composeCompanionReply を再利用する。

apps/local-server/hosted-runtime.ts は Live接続、ConversationLedger/IntentCoordinatorによる発話確定・訂正、通知と画像の提示、操作権を所有し、同じ GameHarness を呼ぶ。取り消し・危険確認・写真差し替え・epoch照合は共通入口で維持する。既存 private メソッドを外から無理に呼ぶテスト専用進行にはしない。

新規共通入口の概念:

```ts
interface GameHarness {
  handleRequest(context: IntentContext, signal?: AbortSignal): Promise<HarnessTurnResult>;
  handleRecognizedPhoto(input: RecognizedPhotoInput, signal?: AbortSignal): Promise<HarnessTurnResult>;
  cancelPending(operationId: string): void;
  publicView(): PlayerView;
}
```

上記は新規設計のシグネチャ。写真は認識までがアダプター、認識結果のバリデーション・送信消費・物体受理・自律行動以降は共通。既存 GameSession.finishPhotos/recognize の後半を commitRecognizedPhotos（新規）へ抽出する。公開HTTPは引き続き実画像を認識し、認識済みJSONをブラウザから注入できる口は設けない。模擬のGameAI.recognizeだけを置換して判定モデルまでmockにしない。

### S3: 調査会話と積極性

新規 apps/local-server/investigation.ts の selectInvestigation、resolveConsultation を追加。core-intent-ai.ts の相談→開示選択→全分類やり直しを、相談の種別判定→条件に合う候補選択→公開文脈で回答、という有限の経路に整理する。行動の判定と混ぜて再実行しない。初期概要は決定的に構築する。

KnowledgeStore.eligibleRevealCandidates/applyReveals を拡張。広い依頼は現在調査可能な対象と概要、具体的な質問は該当詳細を直接選ぶ。選択器には本文・解法を渡さず、対象ID、質問の意味を表すcue、情報層だけを渡す。明示ヒントと通常観察を型で区別し、ID命名の正規表現だけに依存しない。選択後に gameVersion、knowledgeVersion、contextVersion、epoch を再検証し、古ければ開示も課金も確定しない。

packages/shared/core-config.ts に companionInitiative（observations / hypotheses / suggestions、既定observations）を追加。発話指示は新規 config/prompts/investigation/*.md からロードし、1プレイ内では固定。story.ts の初期文と結果通知も同じ積極性・公開情報に従う。現在の「写真を送って使い方を教えて」だけの誘導を、対象を調べながら突破口を探せる設定文へ変更する。明示ヒント依頼では段階ヒントを許可し、単なる調査をヒント扱いしない。

無害な補完は承認済み属性の allowlist で限定する。候補生成時に各属性の攻略非関連性を評価し、ランタイムでは値の生成だけを許可。未定義の材質・通路・道具・能力、色の謎に関係する色、関連不明の属性は補完不可。同じ属性の値はプレイ内で固定し、正式な事実と推測・補完を別領域に保存。Liveには補完許可範囲と確定した補完値だけを渡し、独自に攻略情報を追加させない。プロンプトだけで完全な逸脱防止を保証せず、実音声も別途確認する。

### S4: 公開情報と画像・時間

新規 apps/local-server/public-scene.ts の buildPublicScene を storyOpeningBriefing、結果通知、packages/server/image-service.ts の scenePrompt/sceneRules で共有する。拡充版では初期公開情報と現在確定した状態の描写だけを画像へ渡す。core.facts.visualDescription の全状態の文章、setting.location、story.openingClueから秘密が紛れ込む経路も点検する。生成指示への秘密混入を防ぎ、既存の生成画像事後検査を維持する。検査用の秘密情報をフィードバック経由で次回生成へ戻さない。

調査回答ではsceneイベントを出さない。初期と行動結果の画像・エンディングは維持。実ゲームのGameClockは相談中も進め、既存の判定/認識等のpauseは維持する。評価側は別の注入時計を固定し、API経過時間で本編の残り時間や待機猶予を減らさない。評価のAPIタイムアウトは独立した実時間時計で動く。

### S5: 模擬プレイ

新規 tools/auto-mission/expansion/{play-adapter,player,matrix}.ts。TextPlayAdapter はS2のGameHarnessを使用。プレイヤーの出力を ask / send_items に限定し、送信数、個数、所持、クレジット、終端を本編で検証する。PlayerViewには公開説明、開示済み会話、利用可能な日用品/所持物のみをallowlistで投影。生成物全文、メカニズム、候補選択cue、他のプレイや評価を含めない。

3モデルは現行役割設定を踏まえSol/Terra/Luna、3遊び方は丁寧な調査/大ざっぱな質問/早期試行。最初はSol×調査、Terra×大ざっぱ、Luna×早期試行。残り6は全組合せの差集合を重複なく実行する。各プレイで状態を作り直し、既定の積極性と固定した難易度・モデル・プロンプト・道具一覧digestを記録する。初回は元構成のrulesをそのまま使う。難易度を変えたら別評価条件にする。

1ターンはプレイヤー依頼とゲーム回答で25上限。API失敗を回答に数えて正常完了にしない。自律使用が写真受信で起きた場合、その結果まで同じターンに含める。成功・通常のゲーム失敗・25ターン未クリア・インフラ等の評価未完了を分ける。テキスト回答はLiveの声・委譲検出を模倣せず、その差をレポートへ明記する。

### S6: 予算・保存・再開

新規 expansion/{budget,store,usage}.ts。既存Budgetの事前予約方式を参考に、生成/プレイヤー/本編分類/選択/判定/発話/評価/検証/修正の全通信を同じ台帳で計測する。ゲーム側AIResponsesClientも共通の計測transportで包む。既存providerを巨大な役割unionへ無理に変更せず、低レベル通信とusage抽出を再利用できるよう抽出する。旧RunRecordと旧コマンドは引き続き読める。

初期安全上限（設定可能、所要時間の目標ではない）:

| 対象 | 上限案 |
| --- | --- |
| 1リクエスト | 180秒、入力64 KiB、出力は役割ごとに予約 |
| 拡充＋静的評価 | 600秒、12 calls、出力60000 tokens |
| 1プレイ | 25ターン、200 calls、出力100000 tokens、1200秒 |
| 3プレイの1実行 | 4500秒、650 calls、出力350000 tokens |
| 残り6の1実行 | 9000秒、1250 calls、出力650000 tokens |
| 修正 | 最大2回、各新版に再び3プレイの区切り |

APIの上限は課金許容量ではない。live実行時は利用者が --max-cost-usd を明示する。料金表と要求最大出力、入力サイズから保守的な予約額を算定し、超過前に停止。入力見積は検証したtokenizerまたはUTF-8バイト数による保守的上限を用い、単純な文字数/4で過小予約しない。usage不明は予約を保持し、未知料金のモデルはlive開始不可。料金は実装時に公式資料で再確認し日付付き設定にする。推論tokensをoutputに二重加算しない。残り6はモデル別の初回実測に基づく参考予測を示し、保証とは呼ばない。

run.jsonの単一巨大ログではなく、manifest、source、candidate、play別JSON、call台帳、評価、HTMLを保存。playは16 MiB、run全体128 MiBを上限。毎ターン原子的checkpointし、不完全なJSONを成功記録にしない。未知の実行中callは再開時に未完了へ確定し、課金ゼロや成功に戻さない。初回は完了済みplay単位のみ再利用し、途中playを再試行するときは別attempt IDで新規状態から開始する。候補・ルール・モデル・プロンプト・コード版のdigest不一致で継続拒否。

### S7: 独立評価・修正・採用

新規 expansion/{evaluate,verify,repair,adopt}.ts と対応prompts。Sol/Luna/Terraに同一版と会話を渡し、互いの意見や過去版の評価は見せない。成立性は固定解法・整合・開示到達性、面白さは仕様の4観点で各1〜5点、根拠が足りなければ未評価。JSON pointer/turn IDを検証して引用のない断定を採用しない。

Astraの検証は confirmed_scenario_defect / harness_defect / player_miss / inconclusive に分類し反証を残す。confirmed_scenario_defect のみ修正入力に採る。元解法に関する既知の本編不具合は生成文の水増しで回避しない。必須モデルのAPI失敗はevaluation incomplete。全プレイヤー成功や面白さの平均点は合格条件にしない。

3プレイ時点で必ず費用レポートを出して停止する。設定不備が確認された場合は上限内で修正版を生成できるが、新版のプレイ開始は次の明示的CLI実行へ渡す。9プレイ完了と必要評価・検証の完了、未解決の成立性不備なしで ready_for_adoption。harness_defect/inconclusiveは採用待ちにしない。人間のadoptコマンドが対象版を再検証し、新規 scenarios/expanded/<id>-r<n>.json と採用記録を書き出す。既存ファイルは上書きしない。

ScenarioCatalogは通常の固定V2読込を利用。採用済み固定ファイルを運用設定のscenarioPathで明示選択して起動する。CLIは本番環境変数やAWSを変更しない。通常のカタログは従来どおり残す。レポートを読んだだけでは採用にならない。

### S8: 比較レポートと利用手順

新規 expansion/{report.ts,report.css} の renderExpansionReport。ダークHTML、左に元・右に拡充後、モバイルは同じ項目ごとに上下。元全文、拡充全文、選択構成と共有設定、ギミック/元解法、追加/変更/維持を同じ粒度で示す。長い本文を省略せず折り畳みで収録する。

下段に開示条件、補完履歴、プレイ別会話、観点別評価と根拠/反証、使用モデル/条件/usage/料金日付、3件時点の限界、残り予測、候補版と採用状態。成功・失敗・未完了すべて描画可能。原資料と拡充案は内容から抽出した値を表示し、比較文のLLM要約だけに依存しない。全テキストをescapeし外部JS・外部通信を不要にする。HTMLはプランナー向けの答えを含み、Webの静的公開領域へ置かない。

## 3. セキュリティと互換性

既存認証・プレイ所有権を維持。新規操作はローカルCLIのみ。秘密は既存.env.local/環境変数からサーバーで扱い、ルート.envを読まない。生成JSONのファイルパス/命令を実行しない。CLI入力以外からパスを決めず、生成IDをパスへ未検証連結しない。既存ユーザー会話の永続保存は追加せず、評価の合成会話だけを明示保存する。

既存クレジットは今回新設するものではなく、既存動作として共通ハーネスで維持する。旧設定の積極性既定値はobservations。拡充メタデータなしのV2/V3も起動可能にする。コード・シナリオを本番へ自動反映しない。

## 4. 検証と仕様カバレッジ

| 仕様 | 実装段階 | 主な検証 |
| --- | --- | --- |
| G01–G04 | S1,S3 | 広い質問/直接質問/言い換え/否定されたヒント/積極性3段階 |
| G05 | S2,S3 | 調査前の正解写真、自律1回、取消し、次障害へ勝手に進めない |
| G06–G08 | S1,S3,S5 | 危険な補完拒否、曖昧属性拒否、プレイ内一致・別プレイ分離 |
| G09–G10 | S4 | 秘密文字列のprompt非混入、調査で画像なし、実時計と評価時計分離 |
| E01–E06 | S1,S7 | 原文digest、固定構成、元解法維持、選択版だけ採用 |
| P01–P03 | S2,S5 | 本編と同一入力で状態/消費/回答の同値性、秘密のplayer非混入 |
| P04–P09 | S5,S6 | 3→6の差集合、25ターン、課金/時間停止、積極性固定 |
| V01–V04 | S7 | 開示経路欠落/実装不具合/見落とし/不明を区別 |
| V05–V09 | S6,S7 | peer非混入、反証、面白さで自動修正しない、新版再評価 |
| R01–R08 | S6,S8 | 両全文とギミック/解法、途中版/旧版表示、XSS、usage不明 |

A01–A17は上表の対応要件をまとめた受け入れ条件として同じテストと実機記録へ対応づける。新規tests/improve-game-core-{source,harness,knowledge,simulation,budget,evaluation,report,adoption}.test.tsで異常系と境界を重点確認。既存harness-actions/knowledge、core-runtime/consult/media、story-catalog/runtime、credits、auto-mission-*を回帰対象にする。

実装後にnpm run check、npm test、npm run build。mockで輸送と状態境界を検証してから実APIで拡充＋初回3プレイを計測する。実API費用上限は実行前に提示する。9プレイ未実施なら未完了と報告。採用後はPC Chromeとスマホで音声・写真、初期説明、調査、先回り抑制、訂正、警告、画像を手動確認する。面白さは人間の感想と対照し、模擬評価だけで成功宣言しない。

## 5. 計画の判断点と次工程

1. 初回対象は暗い倉庫の最初の構成。変更は可能だが、道具一覧・試遊記録・費用条件も一緒に固定し直す。
2. 先に共通ハーネスへ整理し、本編と模擬を同じ処理で検証する。UIだけ先に変えるより変更範囲は広いが、評価専用の別ゲームになるのを避ける。
3. 3プレイで停止し、修正版も新しい実行として区切る。全9件と自動修正を無制限に連続実行しない。
4. 採用は固定完成シナリオを書き出し、起動設定で選択する。複数候補のランダム採用管理画面は今回含めない。

上記の計画を承認後、必要なTask Contractを実装前に起票・提示し、create-feature-tasksへ進む。今回はユーザーの指示によりマルチレビューを実行しない。コード未着手、実API未実行。


## 2026-09-15 補足: 生成効率の方針

ユーザー確認により、逐語的不変ではなく原文再利用を基本とする。大枠とギミックを保ち、必要な原文変更は許容。今後の生成出力は追加設定と必要な差分を中心とし、閲覧用全文は保存した原文から組み立てる。現行expandedStoryの全文再生成とレポート表示は、この方針への対応が未実装。現行候補・旧評価を変更済みとは扱わない。評価費用の削減は、生成文短縮だけと混同せず別途計測する。
