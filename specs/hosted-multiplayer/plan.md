Status: approved (2026-09-13)
# AWS公開と複数人試遊 実装計画

## 1. 方針と境界
ハッカソンMVP。React/Express/TypeScript、GPT-Live WebRTCとResponses、既存GameSessionとプロンプト文面を維持。ゲームに関する永続DBを追加しない。新しいapps/serverがHTTPとWeb配信を所有し、apps/local-serverのゲームモジュールを利用する。apps/relayのHTTP転送を廃止し、provider adapterと課金要求予約を内部サービスへ移す。
Node単一プロセス・Lightsail Micro scale1/環境を固定。cluster/複数replica/自動水平スケール禁止。写真変換は短い専用同時実行制限を設ける。元提案と合意はspec.mdを参照。技術調査はresearch.md、公開APIはcontracts/openapi.yaml、状態はdata-model.md。

## 2. 構成と実装単位
| 単位 | 新規/変更ファイル | 実装内容 |
| --- | --- | --- |
| P1 provider | 新規packages/server/openai.ts、ai-service.ts、ai-config.ts | apps/relay/openai.tsのschemas/transportを移設。AiServiceがcreateLive(owner,runtime,request)/respond(owner,runtime,request)/closeLive(runtime)/shutdownを提供。上流固定URL、モデル/サイズ上限、全体/プレイ予算を再利用 |
| P2 所有権 | 新規apps/server/session-store.ts、play-registry.ts、control.ts | AuthSession、PlayRuntime、EnvironmentState。認証・枠・操作権・失効・終端結果・予約保持を管理 |
| P3 ゲーム統合 | 変更apps/local-server/play-router.ts、game-ai.ts、game.ts、live.ts | createPlayRouterをcreatePlayRuntime({scenario,ai,clock,onEnd})と薄いroute handlerへ分離。relayUrl/token/health経由モデル取得を削除。AI設定を直接注入。ゲーム判定・プロンプト文面は維持。所有権/世代確認はゲーム入出力で実施 |
| P4 HTTP | 新規apps/server/app.ts、config.ts、index.ts、ops.ts、logging.ts | 単一Express、auth/play/ops/static/health、起動・shutdown・watchdog、redacted構造ログ |
| P5 UI | 変更apps/web/src/App.tsx、JoinScreen.tsx、PlayScreen.tsx、live.ts、play-api.ts、packages/shared/api.ts | 合言葉→開始→枠確保→Live。招待fragmentを除去。再読み込み/操作権移動/満員/再プレイ/失効案内。すべてのplay mutationにIDとepoch |
| P6 ローカル | 変更tools/mobile.ts、tools/dev.ts、package.json、設定例 | 1アプリ＋tunnel、共通URLのQR、別admin4312なし。Vite HMRはローカル開発専用。実機起動ではビルド済みUIを同じHTTPから配信 |
| P7 AWS | 新規Dockerfile、.dockerignore、tools/deploy.ts、infra/lightsail/*.json、.github/workflows/deploy-dev.yml、deploy-judging.yml | multi-stage image、Micro、OIDC、環境Secrets、drain→image deploy→health確認、環境単位直列化 |
| P8 検証/docs | 新規tests/hosted-*.test.ts、docs/hosting.md、変更README.md、AGENTS.md、docs/development.md、既存tests/browser smoke | 下記検証と新構成の起動/運用/廃止手順。旧仕様は履歴として保持し、現在の正本へのリンクを追加 |

P1/P2の型→P3/P4→P5/P6→P7/P8の順に統合する。P1/P2は独立作業可能だが契約はこの文書群を共有する。タスクチケットは計画承認後に作る。
旧apps/relay、apps/local-server/app.ts/index.ts/admin.ts/play-session.ts/config.tsは依存移行完了後に削除。旧mock専用FoundationScreenとapi/connectionも現行入口から除去。mockは新AiServiceへfake transportを注入するモードとして継続。旧dev:relay/start:relay/dev:localは廃止しREADME/テストと同期する。ゲーム機能の削除はしない。

## 3. セッションと接続の順序
1. POST /api/authで合言葉をhash+timingSafeEqualで照合、AuthSession発行（有効30分、最大1000、開始枠なし）。CookieはHttpOnly/Path=/、HTTPSではSecure、SameSite=Strict。直接localhost HTTPだけSecureなし。
2. 開始ボタンからgetUserMedia→SDP準備。拒否時は枠を取らない。POST /api/plays {requestId,clientId}で認証→admission→既存プレイ→容量→原子的予約→GameSession生成。ここから10分を計測。HTTP再送は同じrequestIdを使う。
3. /api/play/liveはruntime操作権を照合、旧Live終了確認→予算/同時枠を同期予約→upstream await。失敗は回数を戻さない。応答欠落の再送は同じrequestId/SDPで、同一作成をjoinまたは保存済みanswerを返す。異なるSDPでID再利用は409。
4. 接続正常heartbeatでactive。音声開始前もGameSession.status=briefing。既存openingCommandを一度送る。別タブ引継ぎ・reloadでは再導入しない（runtime側openingIssuedを追加、既存UI refとsessionStorageだけに依存しない）。
5. GET状態、写真、イベント、行動は常に所有者のruntimeへdispatch。利用者が送るIDは検索補助であり認可根拠にしない。リロードは状態取得後、必要時「この画面で再接続」で制御権移動。
6. 正常終了で結果を保持、写真/会話は即破棄しLive終了。終了確認後に枠を解放。再プレイは新ID/新deadline/予算を取得するが環境予算は戻らない。

同期予約の不変条件:
```text
authenticate -> validate ownership/schema -> check deadlines/admission/limits
-> synchronously reserve player/provider slots and attempts -> await provider
-> verify same runtime + controlEpoch + generation + revision -> apply
```
P3でGameAIのRelayCall(path,body)をAIResponsesClient.respond(body)へ変更し、モデルはconfigから注入。相互HTTP・relay tokenは不要。上流のbodyをブラウザから丸ごと受け付けない。

## 4. 時計・失効・占有
data-model.mdの優先順位を適用。切断猶予は最大60秒、既存累計待機予算の残りが少なければ先に失効する。ゲームルール維持のため累計待機計算は変更しない。この解釈は最終ブリーフで説明し、2026-09-13にユーザー承認済み。
heartbeatは10秒ごと＋WebRTC状態変更直後。通知なし30秒でrecovering、期限はlastHeartbeat+60秒であり検出時+60秒にしない。明示disconnected時はその初回時刻+60秒。初期connectingは作成から60秒。connectedへ復帰しても絶対deadlineは不変。
写真画面へ遷移した事実だけでは失効させない。WebRTC/heartbeatが切れた場合に同じルール。別タブからの状態取得だけで生存期限は延長しない。closedイベントをunmountの自動終了と同一視しない（リロード復帰を壊さない）。明示終了だけ/api/play/end、通信消失はwatchdogで処理。
勝敗の結果発話は既存の短い猶予内かつ全体deadline以内。quarantinedの枠を期限だけで解放しない。Uiでは終了確認中/運営確認が必要を表示。

## 5. API制限・写真・エラー
環境設定MAX_PLAYERS=5、PLAY_TTL_SECONDS=600、RECOVERY_GRACE_SECONDS=60。AI_MODE=mock|live（AWSはlive明示）。LIVE_MODEL=gpt-live-1、RESPONSE_MODELは既存設定の値を移行。モデルallowlistと設定不足fail-closedを維持。
AI_LIVE_ATTEMPTS_PER_PLAY=3、AI_RESPONSES_PER_PLAY=40、AI_RESPONSE_CONCURRENT_PER_PLAY=1、AI_RESPONSE_CONCURRENT_GLOBAL=5、AI_LIVE_CONCURRENT_GLOBAL=MAX_PLAYERS。AI_GLOBAL_LIVE_ATTEMPTSとAI_GLOBAL_RESPONSE_ATTEMPTSはlive必須設定（例50/1000、運営が実予算に合わせる）。回数上限は環境/プロセス単位、認証し直しても戻らず、デプロイ・再起動では戻る。金額上限ではない。
上流HTTP timeout30秒、JSON応答256KiB、max_output_tokens<=1000、写真2MiB/枚・最大16MP・再エンコード・metadata除去等は既存を維持。画像処理sharp.concurrency(1)、画像処理同時1、待機最大4、待機5秒で503 PHOTO_BUSY（未変換入力の保持は最大5件）。待機タイマーもリクエスト中止/失効時に解放。写真decode待ちで人の撮影時間を巻き戻さない。
一般エラーはcode+短い日本語だけを返す。401認証なし、403Origin/所有権、409満員/操作権/世代、410失効、429予算/試行、503draining/一時処理混雑、502上流失敗を区別。結果不明の行動は既存actionIdで再確認し、新ID自動再送しない。

## 6. 秘密・認証・ログ
- ルート.envは読み書きしない。新統合サーバーは.env.localを読む。.env.local.exampleへOPENAI_API_KEY等の空欄例を追加。既存.env.relay.localからの移行方法だけを文書化し、ユーザーの実値を自動コピーしない。AWSはprocess.envのみ。
- AWSのOPENAI_API_KEY、APP_PASSPHRASE、OPS_TOKENはGitHub Environment Secretsからdeploy時に設定envへ注入。Docker build ARG/ENV、public/VITE_変数、repo、artifactに秘密を含めない。デプロイ閲覧権限でenvが見えるのでIAM閲覧者も限定する。
- 認証試行はglobal100/分（設定可）。IPを本人性としない、同じ審査ネットワーク5人を拒否しない。Map上限1000で長時間の資源占有を制限。プロキシ越しの任意X-Forwarded-Forを信用しない。
- PUBLIC_APP_URLの完全一致Origin検証、Host許可は明示設定。全ブラウザmutationはOrigin必須、Cookieだけで第三者サイトから操作不可。CORS wildcardやtrust proxy=trueを導入しない。proxy終端でもSecure cookieは設定URLから決定する。
- /api/ops/*はブラウザ用認証と別のOPS_TOKEN Bearer、固定長hash比較、body上限。Cookie認証や合言葉で管理操作不可。Originを持つブラウザから拒否する。通常プレイ情報や一覧は返さない。
- logging.tsは許可フィールド（event、非秘密の相関ID、version、durationMs、errorCode、attempts/count）だけを構成。request body/headers/URL query/raw error/provider responseを渡さない。写真、transcript、prompt、SDP、cookie、キーはstdout含め禁止。

## 7. 終了とデプロイ切替
AiService.closeLiveは同一promiseを共有、上限3回で終了確認。不明は予約保持。上流要求abortは課金/Live終了の確認とはみなさない。SIGTERMでは新規受付停止→進行中createを回収→判明したLiveを並列hangup→HTTP終了。shutdownの最大待ち時間とLightsailの実停止猶予は公開前に検証する。
deploy.tsは管理認証で/api/ops/drainを要求し新規プレイ/API作成を停止。全gameを失効して既知Liveを終了し、pending create/unknown create/未終了Liveが0となったらreadyToDeploy=true。最大120秒で解消しなければデプロイ中止し、枠を強制解放しない。
drainの認証はOPS_TOKEN（deploy environment secret）、requestIdで冪等、現在version/bootIdを返す。poll GET /api/ops/drainは同token必須。旧新が重なる更新でも旧runtimeを先にdrain済みにする。deployment失敗時は旧版が残るため、運営が旧version/bootIdを確認して/api/ops/resumeを実行できる（正常drain完了、未確認Live0のみ）。自動無条件resumeはしない。
停止前のHTTPdrainはプラットフォームのSIGTERM猶予に依存しない。強制kill/プラットフォーム障害ではメモリのLive IDも失われ、OpenAIへの終了や絶対金額上限は保証できない。ブラウザは復帰不能を検出したらpeer/tracksを閉じる。外部watchdog/Live ID永続化は追加しないMVP制約として判断ブリーフで説明し、2026-09-13にユーザー承認済み。実APIの上流独立期限/回収手段は実公開前に調べ、実証できない保証を記載しない。

## 8. AWS・CI/CD
- ap-northeast-1を初期設定案とする。service name/account/regionは運営のセットアップで入力、値を推測しない。Micro scale1のdev、必要時judgingを別作成。起動時の許可Originは各標準HTTPS URLから設定。
- Docker multi-stage: npm ci→check/build→production runtime（Node22.12以上の固定image digest、非root、1プロセス）。Linux sharpの依存をimage内npm ciで取得し、Windows node_modulesをコピーしない。.dockerignoreは.git、.env*、node_modules、artifacts、proposal、specs、runs等を除外。シナリオはruntimeへコピー。
- built assetsとserver JSを同一imageへ。0.0.0.0:$PORT（既定4310）、public endpoint HTTP4310。/healthzは外部API・合言葉・満員に依存しない200。healthcheck interval10s/timeout5s/healthy2/unhealthy3。/healthzにはversion/bootIdだけ（secretなし）。
- 開発workflowはpush main（直接pushも含む）→npm ci/format:check/test/build→固定SHA image build/push→drain→deploy。GitHub Environment=development、concurrency環境単位/cancel-in-progress:falseで配信中断を避ける。PR由来の未承認コードへSecretsを渡さない。
- 審査workflowはworkflow_dispatchで40桁commit SHA入力、main履歴に含まれる既存commitを検証、同一テストを通し固定SHAでbuild。Environment=judging、開発とrole/Secretsを分離。初期作成時のみdrain対象なし。バージョンはSHAで追跡、実image識別子も記録（同SHA再buildは同digest保証でない）。
- GitHub OIDCでAWS短期credential。audとこのrepo/environmentの実subを制限（現在のGitHub subject形式をセットアップ時確認）。長期AWSキー不要。actionsは検証したcommit SHAで固定、permissions contents:read/id-token:write。
- Lightsail内蔵registryへSHA付きlabelでpush、返されたimage名を使う。deployment JSONはshell連結せずJSON serializerで生成し一時ファイルから渡す。CLIの全結果や環境変数をログに出さずversion/stateのみ抽出。一時JSONはalways cleanup、artifact/cache禁止。
- IAM: 通常deploy roleに対象serviceへのRegisterContainerImage/CreateContainerServiceDeployment。リソース非対応のregistry login/Get系のみ必要なactionに限定してResource=*。初期service作成/削除/IAM変更は別の運営手順。実CLIが必要とするactionは初回検証し権限単位で追加。
- active deploymentのimage一致と標準URLのversionを確認して完了。失敗/不明は成功表示せず運営へ復旧手順。旧/新併存と通常HTTP timeoutはAWSで実測する。現在の同期APIを維持し、30秒程度の遅延時もactionId再確認で二重実行しないことを試験する。制約で成立しなければ非同期job化を別の設計判断として差し戻す。

## 9. 検証計画と完了条件
| 要件 | 自動検証 | 実環境ゲート |
| --- | --- | --- |
| R01,R13 | fake transportで内部呼出、raw proxy不在、allowlist/回数予約/並行制御、旧relay HTTP依存なし | 1プロセスでLive/写真/行動 |
| R02,R03,R04 | 5独立cookieで確保/6人目拒否、await前予約、認証・閲覧だけ課金なし、同requestId再送 | 5実クライアントとMicro負荷 |
| R05 | 2タブ所有権、takeover旧epoch拒否、reload同playId、期限/予算不変、他人play ID 403 | iOS/Android撮影復帰・再読み込み |
| R06,R07 | fake時計: briefing/playing/connecting/recovery/10分、heartbeat欠落、late create/judge、close不明/再認証/再起動 | 切断・終了・更新後に実音声停止 |
| R08 | tunnel URL/QR、admin別portなし、mock1server smoke | スマホHTTPS撮影/音声 |
| R09,R10,R11 | Docker Linux smoke、workflow入力/環境分離/secret成果物非露出、drain中止/復旧のfake AWS契約 | dev自動、judging手動、失敗deploy、scale1・旧新切替 |
| R12 | sentinel秘密・写真・発言・SDPを入力してstdout/stderr/HTTPエラーに非出力 | AWS/Actionsログも標本確認 |
| R14 | 検証記録を実行結果ごとに更新 | 未実施は未実施と記す |

負荷: 独立5プレイで写真変換とfake上流遅延を重ね、メモリ/CPU/応答時間/エラー/他人混入を記録。MicroでOOM/再起動なし、health安定、イベントループ停止によりheartbeatが誤失効しないこと。実API同時5人は利用権限/レート上限と予算を確認してから実施。Nano縮小は同じ負荷条件を再試験後に判断する。
既存54テストの意図を維持し、relay/招待専用テストは新内部service/認証へ移植。npm run format:check、npm test、npm run buildとbrowser smokeを実行。単なるコード整形テストを追加しない。

## 10. 公開と廃止の運用
公開手順はdocs/hosting.mdへ: AWSアカウント/role/OIDC/Secrets/初期service→デプロイ→合言葉確認→試遊→審査別環境。キー値や合言葉をREADME/コマンドログに載せない。
期間終了: 自動workflowの配信を止める→drain成功確認→対象serviceのaccount/region/nameを確認して削除（dev/judging）→不要なimage/log/service残存確認→不要な専用OpenAIキーとGitHub Secrets/roleを整理。削除は運営の明示手順であり、この計画作成では実行しない。共用の資格は勝手に失効させない。
Micro基本料金は1環境10USD/月、2環境20USD/月。時間課金・月上限、停止中も課金。API・税・転送超過・CI利用等は別。試遊期間だけ作り、Nano検証は安定動作を優先する。

## 11. 計画の状態
製品方針はgrill-meで承認済み。設計/セキュリティレビューの指摘を反映し、2026-09-13に判断ブリーフをユーザーが承認した。累計待機予算の優先、音声終了未確認時の配信中止、強制停止時の外部Live終了保証の制約を含めて確定。コード実装・AWS作成・課金API試験は未実施。脅威モデル/eval-workflowなし。設定の実値と負荷/更新試験は公開前ゲートで解消する。

## 12. レビュー反映（2026-09-13）
- 管理APIのsecurityはPath Itemではなくdrain POST/GET・resume POSTの各Operationへ指定する。
- 審査workflow自体はrefs/heads/mainからのみ実行する。GitHub Environmentのdeployment branch policyはdevelopment/judgingともmainのみ許可し、workflowのifだけに依存しない。対象SHAのテスト/buildは秘密なしjob、deployスクリプトは保護されたmainのものを使う。対象SHAのコードをSecrets/OIDC付きjobで実行しない。入力SHAは環境変数から引数として処理し、shell式へ直接展開しない。
- 写真送信はrequestIdを追加。同play/epochで同requestId・同画像の再送は進行中処理をjoinまたは最新の公開状態を返し再認識しない。同IDで内容違いは409。再送用にraw画像を二重保持せず入力hashと処理状態だけを保持する。写真差替えは新requestId。期限/世代/操作権が変わった旧応答を適用しない。写真リクエスト記録はplay内上限100、超過429。初回要求が明示的に失敗した場合だけ、新IDで再試行を許す。
- 追加テスト: 管理drain POST/GET・resume POSTはプレイヤーcookieだけでは拒否、OPS_TOKENだけで認可。非main workflow refからjudging Environment/OIDC資格へ到達不可。写真応答欠落→同ID再送で認識要求1回、同ID別写真409、上限/失効/他所有者/旧epochを検証。
- 計画レビュー実施: software-design/securityの両観点で全文を確認。管理security階層、judging実行ref制限、写真再送冪等性の3件を契約/計画/データモデルへ反映。R01〜R14を§9へ照合済み。これは文書レビューであり、実装・AWS・実APIの検証成功ではない。
