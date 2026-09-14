Status: approved (2026-09-13)
# ゲームコア改善 — 実装計画

## 1. 規模・方針

2026-09-13。既存のハッカソンMVP、スマホ主/PC副、単一Node+React、Lightsail Micro/scale1を維持する。grill-meの承認済み体験を実装対象とし、新しいDB・ジョブ基盤・学習サーバー・常駐GPUは導入しない。新機能はまだ実装していない。計画の承認前にタスク起票・実装へ進まない。

セキュリティとテストは既存合意を継承する。所有権、秘密非露出、二重実行、非同期の失効境界は自動検証し、Liveの会話品質・画像精度・AWS負荷は実機ゲートとする。

採用案はclient delegation + サーバー側構造化出力。音声モデルに関数名/引数が届く前提を置かない。既存のgame-ai.tsのResponses認識/判定を発展させる。履歴からの推論は状態更新権限を持たず、GameSessionが確定する。

## 2. 最初に通す技術ゲート

P0で写真1枚・障害1個・日英の小さな縦切りを作り、実Liveの委譲と後着transcriptで自動実行が成立するか確認する。UI全面改修と画像実装より先に行う。これは計画承認後の実装工程であり、現時点で成功扱いしない。

- 日英それぞれ、実行/相談/任せる/言い直し/途中の間/後着文字起こしの6種を各2回。24会話を固定例として用意する。
- fakeによる並べ替え・重複テストでは二重実行/入力なし実行/相談の消費が0件。実会話で誤消費が1件でもあれば原因を特定し再試験する。
- 対象指示の取得後、委譲が来るまで/分類完了/結果確定までを別計測。速度は実測し、架空のSLAを合格に使わない。体感はユーザー試遊で確認する。
- 固定の静穏時間で自動確定する代替には逃げない。client方式で成立しなければplanをdraftのまま修正し、Responses delegationへの変更点と体験への影響を提示する。

## 3. 会話受付・判断・確定

### 3.1 受付と履歴

新規 apps/local-server/conversation.ts の ConversationLedger に両話者の元delta、eventId、generation、start/end_ms、serverSeqを保存。文字起こしはプレイ中のメモリのみ。元断片を文字単位で再解釈して書換えない。最大10,000イベント（delta/委譲を合わせた受付上限）かつ合計64KiBの文字列で上限到達時は受付停止を案内し、勝手に古い未処理指示を削除して続行しない。

GameRuntime.eventは検証/重複除去/台帳登録/スケジュールだけを同期的に行い、HTTP 202を返す。AI推論は待たない。PlayScreenのeventQueueは202受付までの順序保証に使う。判断待ちに会話転送を塞がない。既存GameSession.appendTranscriptのeditable()/invalidate()から会話台帳を切り離し、judging中も会話を保存する。

transcriptのUIグループはspeaker/generationと時間区間で安定IDを付ける。時刻の重なり・後着に応じて同じバブルを更新可能。吹き出しの区切りは1.2秒を初期値とするが、実行判定には使用しない。写真/結果メッセージの順序は固定、元の音声断片は保持する。feedの128件/48KiBを超える場合は最古のtranscript表示グループから削除しremovedIdsで通知する。写真/結果枠を優先し、元台帳の根拠とは分離する。

### 3.2 委譲の保留と分類

新規 apps/local-server/intent-coordinator.ts の IntentCoordinator がgeneration内のdelegation IDを管理。1プレイ1分類、最大1件の再評価フラグに集約する。delta単独では新規の実行候補を作らない。Liveからの依頼と未消費のユーザー発言がある場合だけ分類する。

- 分類型は wait / consult / execute。AIが指したevidenceSeqはserverSeqの既存user断片を参照し、本文と道具IDが存在することをコードで検証する。
- contextVersionはユーザー発言/写真/操作権の変更で進める。assistantの相づちで実行を永久に無効化しない。推論後に版が変われば再評価し、過去のexecuteを採用しない。
- 依頼の評価期限は受付から20秒、分類呼出は依頼あたり最大3回。委譲は最大100件/プレイ、pendingは4件までで、超過は429で拒否する。未完/未取得なら保留し、後着があれば再評価。読み取り専用の委譲漏れチェックも通常Responses予算に含める。期限切れは実行せず再発話案内。新しい独立した指示は新しい委譲で扱う。
- consultは対象ユーザー発言の範囲を処理済みにする。同じ範囲への別委譲は相談結果を再利用する。後着で範囲が拡大した場合は未消費部分と会話全体から再評価できる。
- executeの予約は対象ユーザー発言の範囲を固定する。別delegation IDでも、既に予約/消費された範囲を再利用して実行しない。モデルが別のactionIdを出して回避できる構造にしない。
- 判断中に来た指示は保存するが、実行待ちキューへ自動投入しない。現在の行動が確定した後、次の指示を改めて伝えてもらう。旧状態を前提とする指示を後から勝手に実行しない。各user断片にreceivedGameVersionとexecutionEligibleを保持し、judging中の断片はfalse。判断中に開始した分類と依頼をcommit時に失効させ、falseの根拠は後からtrueへ昇格させない。後着が既知の判定中音声区間に重なる場合もfalse。区間の由来が曖昧ならwaitとして再発話を求める。音声時刻から意味上の境界を完全保証するものではなくP0で検証する。
- 委譲漏れが疑われる場合は読取専用の意図確認/再発話案内を行えるが、固定無音時間だけでcommitしない。案内の実際の発火条件はP0で調整し、最大1回/10秒とする。

### 3.3 行動トランザクション

GameSession.reserveAction(intent, expectedContextVersion, expectedGameVersion, actionEpoch, controllerEpoch) -> ActionTicket をawait前に原子的に実行。status=playing、道具可用性、残回数、未予約の根拠発言、接続/期限を確認する。分類開始時のgameVersion/actionEpochも一致必須。ここが用途変更の受付境界。actionIdはサーバー採番。

judgeActionはsnapshotとintentを受け、成功/部分変化/在庫変化/短い理由を返す。commitAction(ticket, judgment)でticket/操作権/ゲーム版/期限/在庫ID/事実キーを検証し、回数と状態を一度だけ変更する。技術エラーは回数を増やさない。通知失敗は確定を巻き戻さず同じ結果を再配信する。

新しいstructured factsはシナリオで宣言したkeyと列挙値のみ。自然文のsituationは演出用であり、値として未知の道具/事実を追加させない。許可する変化も定義する。例えばrope=intact|loosened|cut、door=closed|open。物理的妥当性はモデル評価であり、コード検証だけで意味を完全保証したとは扱わない。

技術失敗でticketをfailedにした場合、その発言の自動再実行はしない。回数は消費せず、新しい発話の指示で再試行する。成功済み結果は配信再試行だけを許す。

### 3.4 Liveへの通知

現行GameSession.end()のgeneration++を、行動失効用actionEpochと接続用liveGenerationへ分離する。勝敗でactionEpochを進め新規実行を拒否するが、接続用generationを即時変更しない。正常勝敗/ゲーム時間切れ後は最大12秒か絶対期限まで、現在controllerのcommands/pollとoutput transcript受付のみ許可する。input transcriptは表示だけに使い、新規分類/実行はしない。汎用GameRuntime.check()のterminal拒否をpollへ流用せず、finalVoiceUntilとowner/controller/liveGenerationを照合する読取専用経路を作る。手動終了/接続失効/運営drainではこの音声猶予を設けない。

結果MessageにrelatedCommandSeq/liveGenerationを、CommandにmessageIdを保存する。新規resultのテキストと画像枠は、対応commandを接続に送信できた時点で表示する。feed先着は最大2秒だけ表示待機し、command送信失敗/切断/履歴再読/最終音声猶予切れではテキストを表示して音声未送信を案内する。commandが先着した場合はmessageIdを保持し、feedが来たら表示する。音声再生との厳密同期は要求しない。

新規 live-outbox.ts の LiveOutbox に serverCommandSeq/generation/controllerEpoch/event_id を固定して格納。POST /api/play/commands/pollで未ackを返し、ブラウザが接続へ送信できた連続seqを次回ackする。500ms周期、非重複。generation/操作権変更で旧outboxを無効化。再接続は現在状態をthinkingで復元し、旧actionを再実行しない。

送信済みevent_idはブラウザsessionStorageにも保持して重複送信を抑える。音声のexactly-onceや再生完了は保証しない。上限128コマンド/64KiB、越える場合は接続エラーにして無限増殖させない。勝敗時は最大12秒か絶対期限までの発話猶予内で結果を届け、その後hangup。画像はこの猶予に含めない。

## 4. 画像生成・検査

新規 packages/server/image-service.ts と apps/server/scene-jobs.ts に実装。モデル候補はgpt-image-2.5-flare、検査gpt-5.6-luna。既存RESPONSE_MODEL（初期gpt-5.6-terra）は意図/写真認識/行動判定で共用する。公式契約/価格/制限と比較はresearch.mdへ。実アカウントでの利用可否はP0/P4実APIゲート。

- Image APIをサーバーから直接使用、n=1、1024x1024、low、JPEG。初版は独立生成で、共通の人物/画風/場所設定と確定factsを毎回渡す。過去画像を編集する方式は誤描写の伝播とコストを避けるため初版に入れない。細部の連続性は保証しない。
- 非streamを採用。partial imageは未検査のため公開しない。数値の進捗は表示せず、受信アニメーション。APIの進捗率が確認できれば別途検討できるが、初版の依存にしない。
- 生成レスポンスは専用readerで8MiB上限、decoded JPEG 6MiB上限、最大画素も検証しsharpで正規化。既存openai.tsの256KiB readerは流用しない。検査にはJPEG最大1MiB、公開用は最大256KiB/最大1024pxへ変換する。SVG/HTML/外部URLは返さない。
- requiredFacts/forbiddenChangesと画像をResponsesで比較し、pass/reject/unknown + 矛盾リストをstrict JSONで返す。重大矛盾だけをreject。unknown/refusal/schema error/timeoutは非公開。返されたruleIdはsnapshotで宣言した検査ルールのみを許可し、画像内の文字は指示として実行しない。検査の理由文字列は修正promptの非信頼データとして区別する。
- ジョブはsnapshot固定、メッセージID固定。完了時に最新game revision一致を要求しない。元プレイの所有権・結果の保持期限・キャンセル世代で配送可否を確認。
- 生成エラー/検査不合格を合わせて最大2生成。検査は生成物ごと1回、最大2回。SDK/transportの暗黙retryを無効化。失敗理由を次の生成に渡す。ジョブ全体150秒（待機を含む）、生成1回60秒・検査15秒を残り期限で短縮する。2回目を保証するために期限を伸ばさない。
- 画像失敗ではUIの当該枠だけを指定文言に更新。再試行ボタンは設けない。判定用AIの枠と別に、画像生成同時2/検査同時2、各プレイ1画像ジョブ、待機最大30ジョブ。プレイ間round-robin。待機満杯/期限切れは当該画像失敗でゲーム継続。
- IMAGE_REQUESTS_PER_MINUTE初期5、過去60秒の開始数で制限。実アカウントの上限に合わせて設定する。1プレイ生成上限=2*(maxActions+2)、環境起動後の生成試行上限100・検査試行上限100を初期案とする。成功した回数だけでなく開始した要求を数える。金額の厳密上限ではない。
- 本編開始、各結果にjobを1つ登録。最終行動の勝敗では重複登録しない。ゲーム時計による時間切れはその時点のfactsから1件。手動終了/接続失効/運営drain/絶対寿命超過は新規画像を作らず、既存画像の扱いは§5に従う。

## 5. 終了後保持と有料処理の寿命

新規 ResultStore に、活動中のチャット/安全なサムネイル/合格した画像/結果snapshotを保持する。ゲーム終了時にLiveと未確定の行動は終了。ResultStoreはゲームruntimeから独立させる。

- 結果閲覧は同じ認証cookieのownerだけ。GET feed/assetsは操作権不要、書込み/Live command取得は操作権必須。GETで認証や期限を延長しない。cookie有効期間内でもサーバー認証TTLが切れる境界は、同一ownerのResultEntryが残る間だけ読取ルート限定でauthorizeResultを許可する。新規開始・書込には通常authorizeを要求する。SessionStore.sweepはこの短期owner参照が消えてから削除する。
- 終了後最大5分、終了済み結果最大10プレイ、各プレイ8MiB、全体128MiB。上限では最も古い終了済み結果を先に削除し、そのジョブもキャンセル。活動中の結果は追い出さず、画像追加が収まらなければ画像失敗で継続する。利用者には最大保持時間であり容量で早期削除されることを案内する。
- 手動終了/接続失効は未開始ジョブをキャンセル、開始済みは残りジョブ期限以内だけ受信。正常勝敗/ゲーム時間切れは既存ジョブを期限内で継続。絶対寿命超過も未開始を中止し、開始済みのみ元の期限まで受信する。再プレイを始めても旧画像は旧playIdのfeedにのみ追加する。
- 運営drain/サーバー終了は全画像ジョブと上流HTTPをabort、待機を破棄し結果をfailedにする。再起動は結果も失われる。画像のためにデプロイを150秒待たせない。
- AiServiceに会話予算とは別のMediaPermitを追加。期限は個別jobDeadline、playのretiredだけで一律拒否しない。retireはLive/会話を停止し、既登録permitのみ期限内で利用できる。retired後にブラウザから新permitを発行できない。SceneJobとMediaPermitに同じcancellationEpochを持ち、evict/明示取消/期限到達で両方失効。生成・検査・再生成の各有料呼出の直前に、epoch/期限/個別上限/環境上限を原子的に検証して予算とbusyを予約する。失効後は待機から開始しない。開始済み試行の回数は返却しない。
- AiService.forgetはLive/会話/mediaの実処理が解放済みになってから内部記録を削除する。timeout時に外部処理が完了したと決めつけて並列枠を解放しない。Abortでネットワークが終了してもprovider側の生成/課金停止を保証しない。
- drain status.remainingにmediaの実行/中止待ちを含める。transportはAbortSignalを受け、読み取り停止が確定するまでbusyを保持。未知の状態でreadyToDeployを返さない。通常の5プレイ枠はLive終了確認で解放し、画像枠を別計数する。

## 6. 設定と日英

scenario v2を導入し、プレイヤー向けtitle/briefing/obstacle title等はja/en両必須。ゲーム内部のgoal/constraintsとfacts keyは共通。既存v1は検証/旧テスト用のadapterで読めるが、今回の本編起動では両言語のv2を要求する。scenarios/mobile-playtest.jsonをv2へ移行し、他の例/validate-scenarioの扱いを明記する。

プロンプト生成時は、instructions16,000文字/input全体16,000文字/出力1,000tokenという既存transport制限を守る。分類入力は現在facts/在庫/写真情報と、未消費根拠を含む直近履歴を優先し、過去の処理済み会話だけを切り詰める。未処理指示自体が収まらない場合は自動確定せず短い指示を求める。写真は同時2枚、検査は1枚とする。

新規 config/game-core.json を共通ルール、scenariosのcore節を固有ルールとする。共通: consultation/execute/waitの例、Live委譲指針、ヒント段階、診断表示可否。固有: facts/遷移、判定の厳しさ、画像必須/禁止facts、共通人物/画風。型はpackages/shared/core-config.tsでstrict schema化。API key/モデルallowlist/費用上限/期限/並列数は運営envで管理し、プランナーの自然文で上書きさせない。

ScenarioCatalog.current()は新規プレイ作成時に設定ファイルを再読込し、最大256KiB/ファイル、schemaと参照整合性、maxActionsの画像予算を検証してimmutable snapshot+SHA256 digestを生成する。無効なら新規開始をCONFIG_INVALIDで拒否し、進行中snapshotは維持。ローカルはJSONを保存して次のプレイから反映、AWSはリポジトリ更新→デプロイで反映（再配置時の中断は既存方針）。任意ファイルパスをHTTPから指定させない。

POST /api/playsにlocale: ja|enを必須追加。同一requestIdでlocaleを変えた再送は409。bootstrapにsupportedLocalesと両言語の安全な概要を返す。UI辞書はapps/web/src/i18n.ts、サーバーは安定error codeを返し表示側で訳す。API messageは診断補助でUIの正本にしない。動的AIテキストはsnapshotのlocaleを渡す。認識原文だけは翻訳しない。

開発用traceはENABLE_GAME_TRACE=1かつNODE_ENV!=productionの場合のみ。同じownerがGET /api/play/traceで短い解釈/理由/ルールversion/処理時間を閲覧可能、128件/64KiBリング・プレイ終了で即破棄。写真/全文prompt/秘密は含めない。本番は404、ログは従来どおり本文を出さない。AWS上の詳細診断を常設する機能は作らない。

### 運営env（初期案）

|変数|初期値/制約|
|---|---|
|IMAGE_MODEL|gpt-image-2.5-flareのみを起動時allowlistへ|
|IMAGE_INSPECTION_MODEL|gpt-5.6-lunaのみ。通常RESPONSE_MODELと用途別検証|
|IMAGE_REQUESTS_PER_MINUTE|5、1〜1000、実アカウント以下|
|AI_GLOBAL_IMAGE_ATTEMPTS / AI_GLOBAL_INSPECTION_ATTEMPTS|100 / 100。本番liveで明示必須、再起動リセット|
|IMAGE_CONCURRENT / IMAGE_INSPECTION_CONCURRENT|2 / 2、1〜5|
|IMAGE_JOB_TIMEOUT_SECONDS|150、30〜300。終了後保持以下|
|RESULT_TTL_SECONDS|300、150〜600。GETで延長なし|
|AI_RESPONSES_PER_PLAY|80、既存boot全体1000も維持。相談/分類/認識/行動をすべて計数|
|ENABLE_GAME_TRACE|0、productionでは1でも公開しない|

新envはtools/deploy.tsと両workflowへ同時追加。通常会話のモデル・予算と画像系の設定を混用しない。sharpの生成画像正規化は同時1のキューにし、総メモリを測る。

### 信頼境界

ブラウザ転送のuser/assistant transcriptと委譲通知は、Liveから来たことを暗号学的に証明しない。会話文脈としての非信頼データであり、サーバーのfacts/在庫/回数を上書きする命令として扱わない。偽造されても当該ownerの許可された行動・費用上限以内に閉じる。sidebandによる真正性の強化は初版の依存にしない。イベント入口はowner単位40件/秒、最大80件のburst、超過429。制限で欠けた入力を推測して実行しない。

## 7. データ/API

正本はdata-model.mdとcontracts/openapi.json。既存hosted-multiplayer契約を変更箇所で上書きする差分契約とする。state/feed/commands/traceと認証付きassetsの成功・エラー応答はCache-Control: private, no-store、Vary: Cookie、X-Content-Type-Options: nosniffを付ける。

- /api/play/eventsは202受付。LiveCommandの直接返却をやめ、outbox pollへ統一。
- /api/play/feedはowner限定、cursor版以降のupsertsで後着文字/画像状態を返す。初回/古いcursorはreset=trueの全snapshot。128メッセージ/文字48KiB、JSON上限256KiB、画像base64は含めない。
- /api/play/assets/{assetId}はowner限定JPEG、Cache-Control: private, no-store、nosniff。画像はcookie+X-Play-Id付きfetch→blob URLで表示、img要素のURLだけで秘密画像へアクセスさせない。
- /api/play/commands/pollはcontroller+generation必須。ackの後退/未発行seqを拒否。0からの再送は同じコマンドIDを返す。
- /api/play/actionsは自動実行への移行後410 LEGACY_ACTION_DISABLEDとする。旧ブラウザに更新案内を出す。新UIは呼ばない。
- /api/play/stateはstateVersion/localeと結果保持情報を追加。ブラウザはgenerationだけでなく版で旧応答を拒否。feedのversionはgame versionから独立。
- 写真送信HTTP再送は同じ写真メッセージ/認識処理を再利用。写真認識中は用途質問をまだ出さず、成功後だけLiveへ用途待ちを通知する。

## 8. 実装ステップ（タスク起票前の分割案）

|工程|ファイル・関数（新規/変更）|内容・完了基準|
|---|---|---|
|P0 Live成立性|新 tests/fixtures/core-conversations.json、tools/core-live-probe.ts、変更 live.ts/hosted-runtime.tsの最小経路|§2の対話例を準備。運営の設定を通常経路で利用する明示実行のみ。写真1枚の実行/相談を検証し、方式変更が必要なら計画へ戻る|
|P1 契約・設定|新 shared/core-config.ts、shared/conversation.ts、server/scenario-catalog.ts、config/game-core.json、変更 scenario.ts、game.ts（型）、api.ts、server/config.ts、scenarios/mobile-playtest.json、tools/validate-scenario.ts|v2/locale/facts/履歴型、immutable snapshot、設定不正拒否、既存v1 adapter|
|P2 会話ハーネス|新 local-server/conversation.ts、intent-coordinator.ts、live-outbox.ts、変更 hosted-runtime.ts event/action、game-ai.ts recognize/judge、game.ts reserveAction/commitAction、live.ts instructions|非blocking受付、相談/指示/待機、二重実行拒否、後着/訂正、部分進展、再利用、actionEpoch/liveGeneration分離|
|P3 HTTP・UI|新 server/result-store.ts、web/src/ConversationView.tsx、PhotoComposer.tsx、i18n.ts、変更 app.ts、play-api.ts、PlayScreen.tsx、JoinScreen.tsx、App.tsx、styles.css/既存CSS|feed/commands/assets/locale、仮メッセンジャーUI、認識原文、非入力欄、写真、動的結果。既存導入は新本編と矛盾する説明のみ最小修正|
|P4 画像|新 packages/server/image-service.ts、apps/server/scene-jobs.ts、変更 openai.ts（画像用transport追加）、ai-service.ts（MediaPermit）、ai-config.ts|専用reader、生成・検査・fair queue・rate/費用上限・最大2生成。実画像で検査精度を測る|
|P5 寿命・運用|変更 play-registry.ts end/sweep、session-store.ts（保持中アクセス確認）、app.ts drain/status/dispose、hosted-runtime.ts close/dispose、ai-service.ts retire/forget/shutdown|終了後保持、owner/再プレイ分離、画像待ちでLive延長なし、drain/timeoutでbusy会計整合|
|P6 設定配布・文書|変更 Dockerfile（configをcopy）、.dockerignore（learningを除外）、tools/deploy.ts env組立、deploy-dev.yml/deploy-judging.yml、.env.local.example、README、docs/architecture.md・development.md・hosting.md、AGENTS.md必要箇所|新上限とモデル/設定を本番へ運ぶ、既存秘密非露出、旧実行ボタン説明を同期。learningはコミットしない|
|P7 検証|新 tests/core-*.test.ts、変更 apps/web/tests/mobile-smoke.cjs、specs/game-core/verification.md|下記自動/実機ゲートとspec coverageを記録。未実施を成功にしない|

P0→P1→P2の順。P3/P4はP1契約を共有して並行可能。P5でライフサイクルを統合し、P6/P7で配信。P0の実API実測が未達なら、fake部分の作業は進められても本番自動実行の完成扱いはしない。

## 9. 検証

- npm run check / npm test / npm run build / npm run format:checkを変更に合わせ実行。既存65件等の過去実績を今回の成功件数として転記しない。
- Coordinator: delegation前後のdelta並べ替え、推論中訂正、consult後の後着、同一発言の別委譲、途中発言、分類上限、再接続で一度だけ実行。judging中の文字がHTTP待ちで塞がれないことを統合テスト。
- Game: unknown facts/在庫ID/禁止能力、技術エラー無消費、部分進展、道具再利用、予約境界、判定中の終了/操作権変更、結果通知再送。
- Media: 初回/再生成/検査不能/拒否/429/oversize/abort/期限境界、開始数/IPM/queue公平性、ゲーム終了後のpermit、逆順画像、retention eviction、drain中の実busy。
- HTTP: 認証なし/別owner、asset横取り、trace production404、cursor reset、ack世代/範囲不正、locale再送不一致、JSON無効設定、旧actions拒否。
- UI: 390px/PC、日英長文、メッセージ左右、カメラ復帰/写真プレビュー/送信、会話と画像並行、スクロール位置、終了後受信、画像失敗、言語固定。音声認識は原文でassert。
- 実画像セット: 扉/拘束/道具の重大矛盾を最低各3枚+整合画像9枚。合格/拒否/unknownを人間ラベルと比較し、検出漏れと誤拒否を分けて報告。全自動保証とはしない。軽量検査で重大矛盾を見落とす場合はモデル/ルールを調整し、承認なく検査を外さない。
- AWS実機: 日英スマホ通し、5人同時のLive遅延/画像待ち/検査失敗率/CPU/メモリ/API使用量、Live終了と結果保持、更新drainを別記録。課金実測前に明示試験回数と運営上限を確認する。

## 10. 要件対応

G01–G05→P1/P3/P7、G06–G11→P0/P2/P3/P7、G12–G17→P1/P2/P5/P7、G18–G24→P1/P4/P7、G25→P3/P5/P7、G26–G29→P1/P2/P4/P5/P6/P7。自動実行の実機成立性、画像実精度、同時5人は実装だけでは満たさない。

## 11. 承認された判断ブリーフ

1. 最初にLive自動実行の縦切り検証を行い、成立性を確認してからUI/画像を仕上げる。
2. 画像は低品質設定+軽量クラウド検査から始める。外見の細部の連続性は要求しない。encoder-onlyの導入は実測後。
3. 画像ジョブ150秒、終了後結果最大5分（容量時早期削除）。会話は待たせないが、API上限時は画像が届かない場合がある。
4. 設定はローカルJSON保存→新規プレイ、AWSではデプロイ反映。詳細判定traceはローカル開発のみ。

2026-09-13にユーザーがこの4点と計画全体を承認。実装ファイルの命名・通常の入力検証等は担当側で進めてよい判断とする。

## 12. 計画レビュー記録

2026-09-13、software-design-reviewer/security-reviewerの計画モードで並列点検。実装レビューではない。

|指摘|反映先|確認|
|---|---|---|
|勝敗で最終音声通知の世代が失効する|§3.4のactionEpoch/liveGeneration分離、finalVoiceUntil専用poll|主担当が契約と照合して修正確認。設計担当の再確認はモデルcapacityエラーで未実施|
|judging中の指示が判定後に実行され得る|§3.2/3.3のeligibility/gameVersion/actionEpoch、曖昧な後着は再発話|主担当が予約/失効契約を確認。意味上の区間精度はP0で検証|
|音声通知と結果テキストの相関なし|§3.4の相互IDと表示開始/fallback、OpenAPI Message/Command|主担当がAPIとの一致を確認|
|取消後の画像検査/再生成が開始され得る|§5の取消世代・各有料呼出前の原子的予約|セキュリティ担当の再確認で解消|
|会話/診断JSONのcache禁止が不足|§7とOpenAPI、成功/エラー双方no-store|セキュリティ担当の再確認で解消|

脅威モデルは現リポジトリに未作成。初回作成は別スキルで扱う。上記以外の未解消レビュー指摘なし。ただし実API/実機成立性は未検証であり、計画の承認・実装検証を代替しない。

### 個別要件の対応確認

|仕様|実装工程|確認観点|
|---|---|---|
|G01|P3|左右バブル・通話インジケーター|
|G02|P3|カメラ・サムネイル・非入力欄・送信|
|G03|P1/P2/P3|元delta・後着・表示と実行の分離|
|G04|P2/P3|message-command相関と画像後着|
|G05|P1/P3|ja/en選択・固定・認識原文|
|G06|P0/P2/P3|写真後用途質問・承認待ちなし|
|G07|P0/P2|委譲はトリガー、静穏時間は実行根拠にしない|
|G08|P0/P2|相談/任せる/未完/未取得|
|G09|P2|予約前の訂正と予約後の不変性|
|G10|P2/P3|判定1件・会話受付継続|
|G11|P1/P2|ヒント段階・ユーザー主導|
|G12|P1/P2|成立性と十分性、特殊能力禁止|
|G13|P1/P2|factsによる部分進展|
|G14|P2/P3|音声のみ再利用・在庫可用性|
|G15|P2|サーバー確定・根拠発言の重複拒否|
|G16|P2/P5|技術失敗無消費・配信再試行|
|G17|P2/P5|既存時計、画像だけでは停止しない|
|G18|P4|開始/結果/勝敗重複排除|
|G19|P1/P4|確定snapshot・共通人物|
|G20|P3/P4/P5|過去message固定・新playへ混入禁止|
|G21|P3/P4|%なしanimation|
|G22|P4/P7|重大矛盾検査・unknown非公開|
|G23|P4/P5|生成2/検査2/期限/全体予算|
|G24|P3/P4|指定文言・英訳・ゲーム継続|
|G25|P3/P5|Live終了・有限結果閲覧|
|G26|P1/P2/P4|共通/シナリオ設定|
|G27|P1/P6|新play snapshot・AWS反映|
|G28|P2/P3/P6|ローカルtrace・本番非露出|
|G29|P4/P5/P6|owner・許可モデル・入力/容量制限|

## 2026-09-14 追加実装計画（ユーザー承認済み）

- H1: intent-coordinator.tsで期限通知と読み取り専用の委譲漏れ監視。分類を既存単一workerへ集約。再委譲依頼はnull ID、実行は実際の委譲のみ。世代/状態/操作権/消費証拠の再検証を維持。監視は定期tick、各文脈一度、最大1回/10秒、期限20秒。
- H2: core-intent-ai.ts、共有conversation型、Liveプロンプトで相談回答を分類reasonから分離。現在の公開状態のみを回答根拠にし、実行/結果はサーバー通知が正本。
- H3: hosted-runtime.tsでH1/H2を統合。結果と次の状況を別通知。残り時間はcore-config設定で60秒未満の一度通知。instructions.appendを通知契約に追加。終了・再接続・判定中に古い通知/結果を復活させない。
- 検証: 委譲漏れで実行0、相談/訂正/期限/重複/世代変更、確定後の状況通知、時計停止/閾値/再接続/終了、全テストとビルド。音声品質は別途実機確認。
- 新しいHTTP endpointや外部サービスは追加しない。既存API予算と所有者制御を使用。
