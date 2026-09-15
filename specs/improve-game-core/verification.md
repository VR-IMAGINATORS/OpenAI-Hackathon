# improve-game-core 検証記録

## 2026-09-15 実装着手時

- ブランチ: `codex/improve-game-core`。
- 通常権限の `git status --short --branch`: 実行環境の初期化失敗 (`helper_unknown_error: setup refresh had errors`)。PowerShell明示も同じ。
- 正規の権限昇格による `git status`: 成功。既存の未追跡資料を保持。
- `npm test`: 760件成功、0失敗、0スキップ（実装着手時の既存回帰基準）。新機能の完了を証明する結果ではない。
- 実API・GPT-Live・実機撮影・面白さ・採用の確認: 未実施。
- マルチレビュー: ユーザー指定により未実施。

以降の変更は担当チケットの検証結果と、本書の統合結果を分けて記録する。

## 実装・模擬CLI統合結果

- T01〜T09（Issue #58〜#66）実装完了。承認済み仕様・計画を維持し、開発マルチレビューは実施していない。
- 調査会話、3段階の積極性、許可された雰囲気属性のプレイ内固定、共通GameHarness、公開情報だけの画像生成を実装。
- 拡充CLI、原資料の固定、盲検模擬プレイ、独立評価・Astra検証、設定不備だけの修正、予算・使用量・中断履歴、比較HTML、固定版採用を実装。
- 新規の実CLI mock run: `ffeead6b-25e3-4e54-aaf3-a834c3d373ef`。
- 初回: exit 0、`pilot_reported`、3 plays、367 callsで停止。
- 明示expand-continue: exit 0、`ready_for_adoption`、計9 plays、1,159 calls（追加792）。全call completed、評価complete、独立3reviews、9verifiedFindings。
- 各mock playは25turn・uncleared。合成応答の輸送・状態境界の検証であり、実AIの攻略成功や面白さを示さない。mock候補は採用不可。
- 初回と続行のcodeIdentity一致を検証。revision `127db6d8e7621e531c84691e471751a085b344d6`、dirtyDigest `755dd58531c247a0b4c4ec0fa65b325c9c95fb28f81c20a1e3a61ac0057fac92`。
- 比較HTML: `runs/mission-expansion/ffeead6b-25e3-4e54-aaf3-a834c3d373ef/report.html`（2,749,025 bytes）。元全文・拡充全文・元の解法・会話・評価・費用を保存。
- HTML表示確認: 別のmockプレビューをChrome1440px/390pxで目視。390px時はscrollWidth390px、比較欄1列358px。
- 中断評価の再開、全ターンcoverage、旧版流用拒否、mock採用拒否、排他的採用保存を自動テスト。採用成功テストは一時領域の合成fixtureのみ。
- 最初の統合試行は評価入力上限で未完了となった。可逆重複排除と全ターン分割で解消し、旧runを成功に書き換えず新規runで上記結果を確認。

## 未実施・次の段階

- 実API拡充＋初回3プレイの費用計測は未実施。仕様記載の7〜20 USDは未実測概算で支出承認ではない。実行前にhard capを合意し、3プレイ後に停止する。
- 実API9プレイ、実AI評価済み候補の採用、PC/スマホのGPT-Live・実写真・人間の面白さは未確認。`manual-playtest.md`に手順を用意。
- T10（Issue #67）は上記を含むため未完了。
- 既存未コミット資料を保持。commit/push/deployは未実施。

## 最終ゲート（新規mock9件完了後・コード固定）

- npm run check: 成功。
- npm test: 848/848成功、失敗0。
- npm run build: 成功。
- 詳細とmock予約額の参考集計: tasks/10-validation.md、tasks/10-mock-reservations.json。予約額合算は実費やlive推奨予算ではない。

## 実API初回試行（2026-09-15）

- ユーザーは上限10 USD、初回3プレイ、OpenAI Responses APIへのシナリオ・解法・道具設定・模擬会話・評価情報送信を明示承認。
- Windowsのnpm経由ではオプションが欠落し、通信前にINVALID_OR_DUPLICATE_ARGUMENT。Nodeから同じCLI引数で実行した。
- 実行: `node --import tsx tools/auto-mission.ts expand --config config/auto-mission/expand-default.json --live --max-cost-usd 10`。
- run: `9bcf5e0a-944d-4df3-a005-9bbfc8bd90f0`。生成API1回はcompleted、生成案の静的検証はGENERATION_REJECTED、exit 1。初回3プレイは0件、残り6件も未実施。
- 原因: knowledgeAdditions[3] connection-background、[4] recording-backgroundがkind=knownだが、prerequisitesあり/revealMode=on_request。Known information must be initially availableを保存済み生成案の再検証で再現。ゲーム実装の検証を緩めて通過させていない。
- gpt-6-astra returned同名、input 15,238 tokens、output 10,674 tokens（内reasoning305）、cached input0。duration161,637ms。
- 台帳の保守計上額0.724175 USD（conservative-cache-write、送信前予約1.4048625 USD）。これはAPI請求書の確定額ではない。承認上限10 USD以内。
- 比較HTMLと拒否案は `runs/mission-expansion/9bcf5e0a-944d-4df3-a005-9bbfc8bd90f0/report.html`、`generation-diagnostic.json` に保存。
- CLI契約の途中生成自動再試行なしに従い停止。実AIプレイ・独立評価・採用・音声/写真実機・面白さは未検証。T10未完了。
## 生成指示修正と再試行（2026-09-15）

- ユーザーの続行承認を受け、knownはprerequisites=[]かつautomatic、条件付き/質問時情報はobservable/hiddenと明記。検証器は変更せず、関連18テスト成功。
- run `e291d4fa-926d-4039-a547-7e6c0cee5657`、上限9.27 USD。既知情報の矛盾は解消したが、sourcePointer `/compiledOriginal/story/phases/opening` が原カタログに存在せずGENERATION_REJECTED、プレイ0件。
- 生成usage: input15,338/output11,148/cached0/reasoning445、179,891ms。保守計上0.749125 USD、前回との累計1.4733 USD。
- sourcePointerは入力で供給した検証済みpointers.scene/pointers.gimmicksから使用し、expandedPointerは生成案の実在フィールドを参照するよう明記。関連18テスト再成功。
- 新規run `441df6b6-4abe-419c-9ac5-7df500dbf8c0` を上限8.52 USDで実行。既実行分との合計上限9.9933 USD。古い生成案や課金記録は保持。初回3件以外のプレイを許可したものではない。
### 最新再試行の結果

- run `441df6b6-4abe-419c-9ac5-7df500dbf8c0` はREQUEST_TIMEOUT、180,006msで未完了停止。生成案未確定、プレイ0件。
- API usage不明、estimatedCostUsd=null。予約1.4172625 USDを保持し、課金ゼロとは扱わない。
- 既知usageの保守計上1.4733 USD＋未知通信予約1.4172625 USD＝累積予算使用扱い2.8905625 USD。承認済み10 USDに対して残枠7.1094375 USDだが、実請求額の確定値ではない。
- 生成プロンプト修正済み。関連18テストとgit diff --check成功。今回の実生成成立・3プレイ・評価は未完了。API待機期限は変更していない。
- 最新レポート: `runs/mission-expansion/441df6b6-4abe-419c-9ac5-7df500dbf8c0/report.html`。
## タイムアウト10分への変更（2026-09-15）

- ユーザー指示により拡充CLIの各requestTimeoutMsを180,000から600,000へ変更。上位scopeの3分制限が残って打ち切られないようstatic/play/pilot/remainingの全適用scopeを更新。各scopeの全体期限・費用・入力・トークン上限は保持。
- budget/generationの既存24テスト成功。git diff --check成功。
- run `3335d4b8-f630-4604-9d1c-30b404dfba0e`、今回上限7.10 USDで再実行。既計上＋未知通信予約2.8905625 USDとの合計上限9.9905625 USD。
- この生成はシナリオ拡張のテキスト生成であり、画像生成ではない。
### 10分設定での結果

- run `3335d4b8-f630-4604-9d1c-30b404dfba0e` のシナリオ拡張は184,956ms（約185秒）で応答。静的保存検証を通過し、candidate/manifestを保存。3分制限を超えた応答が取得できた。
- generator usage: input15,441/output11,018/cached15,438/reasoning286。保守計上0.5663755 USD。
- 最初のexpansion_player通信が約315msでTRANSPORT_OR_CHECKPOINT_FAILURE。usage不明、予約0.047545 USDを保持。CLIはPILOT_INCOMPLETEで停止。完了play0、incomplete play1。タイムアウトとは別の失敗で、現行ログだけではHTTP詳細を特定できない。
- 以前の既知計上＋未知予約2.8905625に今回0.5663755＋未知予約0.047545を加え、累積予算使用扱い3.504483 USD。10 USD枠の残り6.495517 USD。請求額の確定値ではない。
- シナリオ拡張の実応答・静的検証は成功。実AIプレイ3件・独立評価・採用は未完了。
## プレイヤー送信形式修正と初回3件（2026-09-15）

- 再試行でHTTP400 invalid_request_error / invalid_json_schema / text.format.schemaを確認。プレイヤー出力のZod discriminatedUnionがoneOfを出力していたことが原因。エラー本文・認証情報・送信本文は診断ログへ出さず、ステータス/種別/paramとoneOf言及の真偽だけで確認。
- playerEnvelopeを通常unionにしてanyOfを出力し、共通strictOutputSchemaを適用。送信形状の回帰assertを追加。関連19テスト、npm run check成功。
- 旧runの診断再試行1callはusage不明予約0.047545 USDを追加保持。新規再開前の累積予算使用扱い3.552028 USD。
- 候補の再生成・改変はせず、コード版変更に対応する新規run `9a12b4d0-d5c6-452c-a0fe-90ea042a1eeb` を作成。parentRunIdに元run3335d4b8…を保存、restart-provenance.jsonに理由・同一候補・旧費用を記録。旧プレイの成功流用なし。
- 今回上限6.44 USDで初回3プレイ実行。Sol/investigationが6turn cleared、Terra/broadが5turn cleared、Luna/earlyが5turn cleared。全61calls completed、usage不明0、input144,278/output9,665。実APIによるテキスト模擬のみ。
- 再開分の保守計上0.42792025 USD。全試行の既知計上＋未知予約の累積3.97994825 USD、承認10 USD枠の残り6.02005175 USD。確定請求額ではない。
- その後の独立評価はEVALUATION_SINGLE_TURN_INPUT_LIMITでAPI送信前に停止。reviews0、verifiedFindings0、evaluation.status=incomplete。プレイ3件の成功を評価合格・採用可能とは扱わない。残り6プレイ未実施。
- 最新レポート: `runs/mission-expansion/9a12b4d0-d5c6-452c-a0fe-90ea042a1eeb/report.html`。
## 全体評価・累計20 USDへの拡大（2026-09-15）

- ユーザーから全体評価の続行と累計20 USDを承認。旧計上＋予約3.97994825 USDを保持し、新規3→6と評価の合計枠を16.02 USDとする準備をした。
- 実候補の評価入力は原文＋候補だけで75,586 bytes。64 KiBでは1turn以前に収まらないため、pilot/remainingの評価入力枠を128 KiBに変更。static/playは64 KiBを維持。verifyも予算と同じ上限を参照。会話分割・全turn coverage・引用検証は保持。
- 課金なしの保存実データ再評価はcomplete、13call、最大106,930 bytes。これはmock通信の容量検証であり、実AI評価成功ではない。
- 大きい候補の回帰テストを追加。全849テストとcheck成功。実データを削除・要約して上限へ合わせていない。
- 新規実API実行は自動承認レビューで2回拒否され、プロセス起動なし・追加通信なし。以前の宛先/データ送信承認を再提示したが、審査側はアシスタントによる過去承認の引用をユーザー自身の具体的承認とは受理しなかった。未解決のブロックはOpenAI API宛て送信の再確認。
## 実評価の参照修正（2026-09-15）

- run bb0c2e50-2740-451b-b91c-81ce59cae328: 初回3件6/18/6turn cleared、118calls、保守計上1.02995942 USD。評価はINVALID_TURN_REFERENCEで未完了。
- 原因となり得る実装不整合として、本文のturn.idと評価ヘルパーのindex文字列の相違を修正。idを優先し、実IDを引用する回帰テスト追加。
- run3365ffb6-13d5-4692-965f-a65e1beb7cc9: 初回3件6/6/8turn cleared、初回79calls/0.87400357 USD。評価はINVALID_POINTER_REFERENCE。保存した実応答に存在しない /compiledOriginal/originalSections/gimmicks を確認。同条件の評価だけ再試行し1call/0.0732338 USD追加、同様の誤引用で未完了。
- 評価返答スキーマでsource/candidateそれぞれ実在する参照先だけをenumで指定。実在全件と誤パス排除を回帰検証。正常所見を不備一覧へ入れない旨も評価指示に追記。関連10テストとcheck成功。
- これまでの既知計上＋未知通信予約の累計5.95714504 USD。
- run abb49ad6-ef59-4aca-aba8-0f13814b3660 を新規実装・プロンプト条件で開始。同一候補、旧条件・旧課金保持。今回14.04 USD枠、累計20 USD未満。完了結果は後段に追記する。
## 実評価完了・未合格（2026-09-15）

- 最終run abb49ad6-ef59-4aca-aba8-0f13814b3660: 初回3件は6/6/6turn cleared。97callすべてcompleted、usage不明0。
- 独立3モデルレビュー12callとAstra検証16callが完了。evaluation.status=complete / failure=null。harness_defect9件・inconclusive4件（重複含む）によりstage=incomplete、残り6件へ自動進行せず。採用・デプロイなし。
- 費用: 3プレイ0.45386292、独立評価0.96243589、Astra検証5.5084175、今回合計6.92471631 USD。旧分を合わせ12.88186135 USDの予算使用扱い（既知usage保守計上11.36950885＋未知通信予約1.5123525）。20 USD枠内、残7.11813865。
- シナリオ内容・モデル別点数・指摘実例・原カタログ/抜粋の相違による評価誤判定の注意を live-evaluation-result.md に整理。
- 残6＋9件最終評価の費用は未実測。全体が合格したとは報告しない。
- 最終npm test 850/850成功、fail0/skip0。build/check成功。未コミット資料保持、commit/pushなし。
## 拡充候補のユーザー試遊（2026-09-15）

- 最終runの候補をローカル試遊用にコンパイルし、SCENARIO_PATH指定でliveサーバーを起動。health/bootstrapと画面配信を確認。候補の正式採用やデプロイは行っていない。
- ユーザーが試遊し、目隠し解除後の内扉のクリア条件が分かりづらいと報告。格子付き操作窓と通路の位置関係、および奥の引き輪を手前へ引く操作の伝わりやすさが未解決。今回のコミットではシナリオ文面や判定条件を変更していない。
- この報告だけで音声・写真・スマートフォンの全確認項目を合格扱いにはしない。

## 通常起動・main公開への切り替え（2026-09-15）

- ユーザー依頼で拡充版r1をSCENARIO_PATH未指定時の既定に変更。共通ハーネスとともにmain公開の対象にする。旧カタログの明示指定は維持。
- 開発・本番設定の両方で拡充背景が読み込まれる回帰テストを追加。写真クレジットのfake transportを調査会話形式に対応。
- 867/867テスト、型検査、全シナリオ検証、build成功。Windowsのcore.autocrlfによるCRLFを許容したformat:check成功。実音声・実機検証および候補品質未合格の状態は別扱い。
