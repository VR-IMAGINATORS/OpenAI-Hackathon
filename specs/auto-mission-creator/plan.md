Status: approved (2026-09-14)

# 自動ミッション生成: 実装計画

2026-09-14。ハッカソン用プロトタイプ。要件は[spec.md](spec.md)、API調査は[research.md](research.md)、データ契約案は[data-model.md](data-model.md)。ユーザー指定の最上位生成を反映済み。ユーザー承認に基づき実装へ進む。

## 1. 方針と境界

TypeScriptの独立CLIをtools/auto-mission/に実装する。既存Node/tsx/Zod/dotenvを使用する。Expressのendpoint、Web UI、DB、AWS、現行scenarioの読み替えは追加しない。HTTP公開APIがないためOpenAPIは作成せず、内部契約はdata-model.mdと実装時のschemas.tsを正本にする。

生成・修正はgpt-6-astra。コントラクト生成もAstraで行う。最上位allowlistにないモデルは設定エラーにし、利用不可・予算不足時にSol等へ自動変更しない。今後の最上位モデルへの変更はallowlistと公式確認を伴う明示設定変更とする。

| 役割                 | 初期モデル                  | reasoning.effort | 出力上限token/回 |
| -------------------- | --------------------------- | ---------------- | ---------------- |
| コントラクト生成     | gpt-6-astra                 | medium           | 8,000            |
| コントラクト検証     | gpt-6-astra（独立呼び出し） | high             | 4,000            |
| ストーリー生成・修正 | gpt-6-astra                 | medium           | 12,000           |
| 身体動作・物理評価   | gpt-5.6-sol                 | medium           | 3,000            |
| 道具・回数評価       | gpt-5.6-luna                | medium           | 3,000            |
| 因果・説明評価       | gpt-5.6-terra               | medium           | 3,000            |
| 指摘検証・全体確認   | gpt-6-astra（独立呼び出し） | high             | 6,000            |

APIに存在することは公式文書で確認済み。アカウントの権限は実API試験で確認する。理由・反証を出力させるが、内部推論の全開示を要求しない。

## 2. CLIと初期設定案

追加するコマンド（package.jsonにmissionスクリプトを追加）:

```text
npm run mission -- generate --config config/auto-mission/default.json --live
npm run mission -- generate --config config/auto-mission/default.json --mock
npm run mission -- evaluate --input runs/auto-mission/<runId>/run.json --live
npm run mission -- benchmark --config config/auto-mission/default.json --mock
npm run mission -- render --input runs/auto-mission/<runId>/run.json
```

- live/mockの選択は必須（renderのみAPI不要）。成功exit 0、成立性不合格exit 1、設定/実行エラーexit 2。
- generateは1案を生成して最大2回修正。evaluateは保存済み最終案と固定条件を新runとして再評価するだけで、修正や再生成はしない。benchmarkは既知ケースを順に評価し、ケースごとのレポートと比較indexを作る。renderは保存JSONのみでHTMLを再生成。
- 初期言語は日本語。構造内にlocaleを持つが、初回プロトタイプの画面・fixture・検証は日本語を対象とする。
- 初期3ギミック、写真送信4回、1送信2枚、300秒。maxActionsはnull（上限なし・集計あり）。現行本編に合わせた例であり、上限付き設定では正整数を指定可能。難易度UIとは接続しない。
- 身近な物: 紙、ペン、ハサミ、タオル、コップ、スプーン、輪ゴム、紐。編集可能なリスト。プランナー参考例は明示指定したローカルファイルだけを読む。
- 実行結果はruns/auto-mission/<UUID>/run.jsonとreport.html。既存のruns ignoreを使用。ユーザー企画や本番scenarioへの書込先を設定できない。run IDはコード採番し、モデル由来文字列でパスを組み立てない。
- 環境変数を優先し、補助として.env.localをdotenvで読み取る。ルート.envは読まない。資格情報を設定スナップショットへ混ぜない。

## 3. 回数・時間の判定

sendで送信回数を1増やし、具現化する対象数をmaxPhotosPerSend以内に制限する。use/place/retrieve/moveは各1行動。moveは手元の物を伴って移動できるが、設置した物の回収を含めない。設置状態から持ち運ぶにはretrieveを先に必要とする。

モデルは消費回数を直接決めない。コードがstep.kindから集計する。自然文に複数操作を隠した手順はAI評価で指摘する。身体の細かな関節動作まで別行動にはせず、物の使用・設置・回収・場所移動という単位を固定指示で定義する。これはプロトタイプの成立性評価単位であり、本編のLive行動判定へ自動で適用しない。

各手順の所要時間を理由付きで見積もり、合計がtotalTimeSecondsを超えたら失敗にする。ただし思考・写真撮影・音声・ネットワーク時間の個人差や待機停止を含む実プレイ時間の保証はしない。HTMLに「手順の見積時間、実プレイ未測定」と明示する。時間見積の過小評価もresources/physics reviewerが確認する。

## 4. パイプラインと合否

```text
設定検査・予算・保存先準備
  → Astraでコントラクト案生成
  → コード検査＋独立Astraでコントラクト検証
  → 合格なら固定してdigestを保存（失敗なら終了）
  → Astraでストーリー・構造化解法を生成
  → 機械検査
  → 通過時のみ3視点の独立評価
  → Astraが全指摘を検証し、全体も確認
  → 合否をコードで決定
  → 修正可能な不合格なら同じコントラクトでAstra修正（最大2回）
  → 必ず機械検査から全体を再検査
  → 合格または失敗と最終案を保存
```

コントラクトに事実key・値域・初期状態・順序付き達成条件を持たせる。外部の世界観/ルール/道具リストをモデル出力から上書きしない。コントラクトのAI検証は外部条件への矛盾と必須情報の欠落を確認する。後で不可能と分かった場合もコントラクトを緩めずそのrunを失敗にする。

機械検査failはそのまま修正担当へ渡す。AI評価で覆さない。無効JSON/refusal/incompleteは内容修正を試みず実行エラーとして終了する。形式上正しいが成立しない候補だけが最大2回の修正対象。

3評価者はそれぞれ固定指示・同じ候補・同じコントラクトだけを受け取る。前ラウンドの合否・指摘・修正指示・他者評価は渡さない。previous_response_idや共有conversationも使わない。judge側の実行順で入力が変わらないよう、開始前に入力digestを記録する。

検証役は全指摘にconfirmed/rejected/unresolvedを割り当てる。rejectedには対象案内の根拠参照と反証を必須とする。パス・引用・候補digest・指摘IDの対応をコードで検査する。反証の意味の正しさはLLM依存であり、既知ケースで検証する。新しいblocking指摘の追加は許可し、修正対象へ含める。機械fail、必須review欠落、unknown、未解決指摘を検証役の一言でpassへ変更できない。

最終判定はderiveVerdict(mechanical, reviews, verification)という純粋関数に集約する。passedの条件は、機械検査pass・3視点の完了・正しい版・全指摘の検証完了・有効な反証・confirmed blocking/unresolved/unknownなし。非blocking指摘もレポートへ残す。修正残数0で未達ならSTORY_REJECTED。

## 5. 予算・失敗の扱い

初期値案: 最大17 API呼び出し、出力合計100,000 token、全体10分（600秒）、1呼び出し600秒、入力1呼び出し48KiB、並列3（独立評価のみ）、通信再試行0。

17回はコントラクト生成/検証2回と、最大3候補分の生成/修正1＋独立評価3＋検証1の15回。契約エラーや機械不合格で省略された処理は課金呼び出しを行わない。出力100,000はAPIが返す推論tokenを含むoutput usageで集計し、max_output_tokensを各呼び出しへ設定する。

Budget.reserve(role)はawait前に呼び出し枠とその役割の出力上限を予約する。完了時に実使用量へ精算し、並行リクエストが合計枠を取り合って上限を超えないようにする。usage不明なら予約分を解放せず、unknownとして記録。応答の入力・出力使用量と取得時の単価表から参考費用を表示するが、トークン予算を請求額の厳密な上限とは表記しない。

時間上限は途中で止めるための上限であり、最大修正回数まで必ず完走する保証ではない。AbortControllerで全体/個別期限とSIGINTを伝播。遅れて返った処理は最終statusを変更しない。APIエラー時は兄弟レビューを停止し、既に得た成果を保存する。

設定エラー・利用不可・APIエラー・予算超過はストーリー欠陥と分ける。下位モデルへの代替、失敗後の別案自動生成、無制限再試行は行わない。

benchmarkはケースごとに上限を適用し、コマンド全体にもmaxApiCalls/maxOutputTokensTotal/deadlineSecondsを共有する。ケースの数だけ予算が暗黙に増えないよう、live benchmarkは全体上限付きの設定を要求する。まずmockで制御を検証し、実APIは少数ケースから実行する。

### 初回計測の目的（2026-09-14更新）

ユーザー指定により、2〜3分は応答時間の目標、10分は最初の計測でのタイムアウトとする。時間制限を満たすために未検証案を合格にしたり、必要な評価を省いたりしない。全体期限は準備・生成・評価・修正を含め開始時に一度だけ設定し、ラウンドが変わってもリセットしない。個別呼び出し期限は600秒と全体の残り時間の小さい方。

計測項目:

- ユーザー入力を受けてから最終判定までの実経過時間。
- コントラクト生成/検証、ストーリー生成、機械検査、3視点の各評価、指摘検証、修正、保存/レポートの開始・終了・所要時間。
- 初回合格と修正後合格を分けた時間、修正回数、実際のモデル・reasoning設定、入力/出力使用量。
- API待機を含む呼び出し時間、並列評価の区間時間、スキップ/中断/失敗の理由。並列呼び出し時間を足して全体時間と呼ばない。
- 目標180秒以内の合格、180秒超の合格、600秒でのタイムアウトを区別。少数試行の数値を代表的なp95や保証値として表示しない。

HTMLに段階別の時間表と全体の実経過時間を出す。遅延段階を見てから、一括生成・出力短縮・指摘検証の条件付き実行等の構成短縮案を比較する。直前に提示した一括生成案はコントラクト固定の順序も変えるため、このタイムアウト変更だけで採用済みとは扱わない。まず現計画を計測の基準として保持する。

## 6. モジュールと実装順序

| 段階 | 新規/変更ファイルと主要責務                                                                                                   | 依存   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1   | tools/auto-mission/schemas.ts、config.ts、config/auto-mission/default.json。parseConfig、役割allowlist、Zod型、入力snapshot   | なし   |
| M2   | tools/auto-mission/simulate.ts、verdict.ts。validateContract、simulateWitness、deriveVerdict。状態遷移/参照/回数/指摘の網羅性 | M1     |
| M3   | tools/auto-mission/provider.ts、budget.ts、prompts/\*.md。Responses adapter、reserve、独立した指示と入力。transport注入可能   | M1     |
| M4   | tools/auto-mission/pipeline.ts、store.ts。runGeneration、evaluateSaved、最大2回修正、版固定、停止と途中成果保存               | M2,M3  |
| M5   | tools/auto-mission/report.ts、cli.ts、tools/auto-mission.ts、package.jsonのmission。renderReport、CLI引数/終了コード          | M4     |
| M6   | tests/auto-mission-\*.test.ts、tests/fixtures/auto-mission/、tools/auto-mission/benchmark.ts、docs/auto-mission-creator.md    | M2〜M5 |

変更は独立CLIとドキュメントを中心にし、既存ゲーム用APIの出力上限/タイムアウトを変更しない。schemas.tsからprovider用JSON Schemaを作り、unsupportedなoneOf等が混入していないか検査する。実装中に構造上の矛盾が見つかった場合は本計画を修正して再提示する。

内部境界:

```ts
simulateWitness(contract: MissionContract, candidate: MissionCandidate): MechanicalResult;
deriveVerdict(checks: MechanicalResult, reviews: Review[], verification: Verification): Verdict;
runGeneration(config: MissionConfig, deps: RunDependencies): Promise<RunRecord>;
evaluateSaved(record: RunRecord, deps: RunDependencies): Promise<RunRecord>;
renderReport(record: RunRecord): string;
```

API呼び出しを行うのはproviderだけ。結果・時間・UUIDを注入でき、通常のnpm testは課金なしで実行する。

## 7. 保存・表示・安全性

- run.jsonを各段階で原子的に保存。rawのプロバイダ応答は秘密ヘッダーや余分なmetadataを丸ごと保存せず、検証済みの内容、refusal/エラー種別、usage、response model等に限定する。
- HTMLは自己完結した静的レポート。テキストをescapeし、生成文のHTML/Markdownを実行しない。外部CDN/画像/自動通信なし。長い履歴はdetailsで畳む。
- レポート先頭に合否・失敗理由・モデル・mock/liveを表示し、最終案、解法、状態の推移、評価、反証、修正履歴、使用量へ続く。
- 生成データは不信な入力として検証。外部URLやtool executionをモデルへ与えない。API URLは公式固定、redirect拒否、入力/応答サイズ制限、秘密キー非表示。
- 保存先の失敗は端末へSTORAGE_ERRORを表示。ディスクに書けないのに「保存済み」と報告しない。
- 公開endpointや所有者認証の変更はない。既存の脅威モデルファイルはなし。必要なら別途create-threat-modelで正式な台帳を作成するが、本計画では新しい公開サービスを作らない。

## 8. テストと実APIゲート

M1/M2: 不正設定、最上位要件違反、契約改変、未知の値/場所/道具、未回収道具、消費済み再利用、回数不足、達成順序、終端条件、誤った時間合計。

M3/M4: 3評価の入力独立、過去履歴の非共有、修正2回上限、機械fail非棄却、unknown/欠落で不合格、棄却の反証不足、重複指摘ID、古いdigest、予算予約競合、usage不明、拒否/不完全出力/timeout/中断、部分保存、モデル自動代替なし。

M5/M6: CLI mock一巡と保存案再評価、失敗時HTML、危険なタグのescape、秘密非露出、既存結果の非上書き、renderのAPI不要。正常1件＋異常4件（回数不足、使い切り再利用、拘束による不可能、配置説明不足）を初期fixtureとする。正解ラベルと期待問題は評価者の入力に含めない。

実APIゲートは利用権確認を含むAstra生成1案、正常例と既知異常例の評価。結果をHTMLで人間が確認するが、合否処理に承認待ちを入れない。誤合格/誤不合格は報告し、精度改善の判断材料にする。実APIで未確認の状態を完了扱いしない。通常のnpm run check/test/buildで既存機能への回帰も確認する。

## 9. 仕様カバレッジ・自己点検

| 要件       | 計画箇所                            |
| ---------- | ----------------------------------- |
| AMC-01〜05 | §1〜2、M1の設定とsnapshot           |
| AMC-06〜08 | §4、M1/M2/M4の固定コントラクト      |
| AMC-09〜14 | §3〜4、data-model.md、M2の状態追跡  |
| AMC-15〜16 | §3〜4、M2の機械検査                 |
| AMC-17〜23 | §4、M3/M4の独立評価・指摘検証・合議 |
| AMC-24〜29 | §1〜2、§5/7、M3/M4                  |
| AMC-30〜33 | §2/7、M4/M5                         |
| AMC-34〜37 | §8、M6                              |

自分で仕様と全要件を照合し、送信回数と行動数の混同、コントラクト検証前の生成、検証役による機械failの上書き、benchmarkでの予算増殖を避ける記述にした。マルチレビューはユーザー指示により未実施。開発レビューと機能内の独立評価を混同しない。

## 10. 承認時に確認する点と次工程

- 最上位生成はAstra固定、検証役もAstra、3評価はSol/Terra/Luna。予算は最大17呼び出し/10分、出力100,000 token。実費・所要時間は未実測。
- 現行ルールと合わせて行動上限はnullを初期値にし、上限付きケースも検証。必要動作は構造化して集計し、難易度設定で制限できる。
- 時間内の成立は見積り検査まで。実プレイでの撮影・思考を含む保証は後のゲーム統合時に検証。

承認後、.specworkflow/eval/contracts/auto-mission-creator.jsonにTask Contractを作成し、create-feature-tasksでM1〜M6を具体的なチケットにする。Task Contractの必須条件は、最上位生成・固定条件不変・決定的検査・独立3評価と反証・失敗と上限・HTML/JSON保存・既知ケース検証・既存ゲーム非変更。実API品質はmanual、制御の保証はdeterministicとして分ける。実装と実API計測へ進行済み。初回計測に基づく個別600秒・生成mediumへの設定更新と結果はmeasurement.md、進行状況はtasks.mdへ記録する。
