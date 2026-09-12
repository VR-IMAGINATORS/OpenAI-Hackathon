Status: approved (2026-09-12)
# mobile-playtest 実装計画

## 1. 方針
ハッカソンの面白さ検証MVP。既存React/TypeScript/ExpressとシナリオZodを継続し、DBを増やさない。PCに単一プレイを保持。最初に実音声＋写真＋1障害を接続し、続いて3障害まで拡張する。
GPT-Liveは音声会話担当。写真はvision対応Responses APIに送り、localが認識・ゲーム判断を検証する。Liveへの委譲結果は短文に整形して戻す。ブラウザやAIの台詞を状態確定の根拠にしない。

## 2. 接続と所有権
- `tools/mobile.ts` (新規) の `startMobile()` を `npm run play:mobile` から呼ぶ。build後のUIをlocal4310で提供し、cloudflaredをshell:falseで直接起動。Vite開発サーバーを公開しない。
- cloudflaredがない場合はインストール方法を案内し終了。無断ダウンロードしない。既存cloudflared設定を変更しない。PUBLIC_GAME_URL指定時は外部HTTPS URLを利用可能。
- `tools/tunnel.ts` (新規) の `startTunnel()` は出力から厳密なhttpsのtrycloudflare.comサブドメイン1つだけを取得する。localのHost/Origin許可はその完全一致に限定。ワイルドカード不可。起動失敗時は子を停止する。Ctrl+Cでlocalとtunnelを停止。
- 招待は32バイト乱数、有効5分、一度限り。URLフラグメントに置き、ページで直ちに消去してPOST /api/play/claimで交換。QRはターミナルとPC管理画面だけ。relay合言葉/トークンをQRに含めない。
- `apps/local-server/play-session.ts` (新規) の `claimInvite()` はアトミックに所有権を取得。ブラウザはHttpOnly/SameSite=Strict/Secure Cookieで認証（loopbackのHTTP開発のみSecure無し）。公開origin以外の変更リクエスト拒否。
- PC管理は別loopbackポート4312にbindしトンネルへ接続しない。管理画面で招待再発行/プレイ破棄。認証トークンをOS起動時に発行し管理cookieへ交換、Host/Origin完全一致、外部から到達する転送ヘッダを信用しない。
- relay合言葉はプレイヤーが一度入力してlocalからrelayへ渡す。relayトークンはlocalのみ保持。authMode=noneでもlocalの所有権制御は有効。

## 3. ゲームと写真
- `packages/shared/game.ts` (新規): 公開状態/認識/行動/判定Zod。詳細はdata-model.md。
- `apps/local-server/game.ts` (新規) の `GameSession` はscenario、現在障害、行動、持越物、状況、認識revision、時計、処理中actionIdを所有。`prepareProposal()` は写真・発言・状態を元にResponsesで認識短文を更新する。
- `commitAction({actionId,proposalRevision})` は所有権→状態→残時間→revision→処理中判定を同期チェックしてbusyを取得後にAPI呼出。表示済みの物/用途をimmutable snapshot化。成功した検証済み判定だけを一度適用して行動を消費。同じactionIdは同じ結果を返し、別IDの同時実行は409。失敗時は消費せずロック解除し再試行可能。
- 古い写真認識/相談/Live応答はsession generationとrevisionで破棄。写真差替え・使い方訂正で提案を無効化し、再認識完了まで実行不可。相談中に勝敗/消費/成功を確定しない。
- `apps/local-server/game-ai.ts` (新規) の `recognizeProposal()` / `judgeAction()` がJSON schemaのResponsesを呼ぶ。localがpromptを所有、relayは転送のみ。構造検証＋既存在庫ID/状態/障害遷移範囲を検証。不正出力/拒否はシステムエラー。解法は正解アイテム一覧に限定せず、物の通常の性質と状況の説明可能性で判定。
- `apps/web/src/photo.ts` (新規): スマホはカメラ撮影を優先しファイル選択も用意。画像をCanvasで最大1280pxのJPEGに変換。localでもsharpによるdecode/reencode、16MP・1枚2MiB・設定枚数上限・JPEG/PNG/WebPに限定。EXIFを保持しない。写真はメモリのみ、終了/失効で削除。ルート別body上限を設定し既存32KBを全体で緩めない。
- `apps/local-server/clock.ts` (新規) はサーバー単調時刻で残時間算出。導入後start、会話/撮影中は進む。判定処理/接続復旧はpause reason集合で停止。単一の待機合計上限60秒、超過は接続終了としてプレイ失効（ゲーム敗北と区別）。背景化のみでは停止しない。
- 3障害クリアで成功、4行動消費又は時間切れで失敗。シナリオ設定値を使用。失敗行動後も工夫の余地を保持する。緊迫イベントは今回無効の試遊JSONを追加し、本体の必須仕様は残す。

## 4. Live と relay
- `apps/web/src/live.ts` (新規) の `LiveConnection`: ユーザー操作からマイク取得、WebRTC peer/datachannel作成、ICE完了待機、localへSDP送信、answer適用、session.started待機。公式Live契約はresearch.mdに固定する。Realtimeイベントを混在させない。
- `apps/local-server/live.ts` (新規): client delegationとlocal側の会話履歴、ゲーム結果を結び、Live用指示を生成。写真自体をLiveに送らず、Responsesの検証済み認識だけを返す。
- `apps/relay/openai.ts` (新規) の `createLiveSession()` / `createResponse()` はapi.openai.comの固定pathのみ。汎用URL/任意tool/proxyを公開しない。OPENAI_API_KEYは.env.relay.localのみ。モデルallowlistと出力/写真/音声session制限を運営が設定。
- 既存relay config/appはmockとliveを明示分岐。Live modeで資格不足ならfail closed。mock成功をLive成功に見せない。
- 認証トークンをプレイ用に更新し、有効期間は初期15分。既存diagnosticの4request上限とは別に会話/判定/セッション作成上限を設定。Live初期化は自動リトライ禁止。最大同時1session/所有トークン。上限時は429と再開案内。
- 実API試験は権限のある運営資格情報を設定してから行う。現状のメモリcounterを金額の絶対上限と扱わない。実課金制御・終了契約の調査結果を計画確定前に追加する。

## 5. UI と復帰
- `apps/web/src/App.tsx` を画面分岐、`PlayScreen.tsx` / `JoinScreen.tsx` (新規) に分割。スマホ縦画面、44px以上の操作領域、下部に撮影/実行、会話の認識短文と残資源を表示。PC管理はQR、PCプレイはファイル選択。
- 撮影・背景化で音声が切れたら接続状態表示と再開タップを提供。マイク拒否/非HTTPS/音声再生制限は理由とやり直し手順。復帰時はlocal stateを取得し、自動実行しない。
- 会話・写真・行動結果のAPI失敗はretry表示。画像/動画未追加は試遊版として明記。切断/閉じる/終了でtracksとpeerを解放する。

## 6. 検証と実装順
A: shared型、招待/所有権、写真、時計、ゲーム状態を独立テスト。
B: relay Live/Responses adapterと契約をfake upstreamで検証。local→relay実通信、secretのブラウザ非露出、timeout/429/不正出力を確認。
C: tunnel/QR、join、実音声/撮影、1障害。実権限が未提供なら機械テストだけを完了扱いし実機ゲートは未完。
D: 3障害・時計・在庫、スマホレイアウトと復帰、ドッグフーディング。
E: README/docs/development.mdと.env例、npm check/test/build、Playwrightモバイル幅、iOS Safari/Android Chromeの実機確認、携帯回線、終了時停止。
受入条件対応: spec接続=A/B/C、1障害=B/C、1プレイ=A/D、異常系=A/B/E、検証分離=E。実APIの応答時間と提案の納得感を手動記録し、機械テスト合格だけで面白さ成立としない。

## 7. 計画の状態
実装規模・モバイル優先・認証境界・試遊順はユーザー承認済み。API詳細調査と設計/セキュリティ計画レビュー後に判断点を提示する。Statusは計画承認までdraft。
## 8. Live課金と生存監視（調査反映）
relayはLive session IDを所有tokenへ紐づけ、POST /v1/live/sessions/{id}/hangupを実行できる。初期上限: 同時1、1tokenあたり作成3回、実時間10分、最後のheartbeatから30秒でhangup。heartbeatは10秒ごと、local/browserの両方の生存を要する。時計停止とは別。
hangupは終了/失効/切断/管理破棄で必ず呼び、失敗時は限定3回retryして未確認を記録。relayの異常停止時はwatchdogも停止するため絶対金額上限ではない。運営の利用監視と停止手順をREADMEに記載。
実APIを有効にするにはRELAY_MODE=liveと明示的な上限設定を必要とする。初期制限: 1tokenあたりResponses最大40回、同時1、出力最大1000tokens、各要求30秒。永続金額保証は今回のMVP範囲外。実試験前に運営の予算と利用権限を確認する。
Liveイベントはブラウザからlocalへ渡し、型/サイズ/所有権/generation/dedupeを検証。文字起こしと委譲は認識案を作る入力のみ。写真認識は別Responses要求。appendはlocalが構成し、ブラウザがdatachannelへ送る。悪意のブラウザが音声を変更できてもゲーム確定はlocalのcommitだけ。
切断後は古いLiveをhangupし新session生成、保持したlocal状態を短文で復元。API作成の自動再試行を行わずユーザー再接続操作で実施。

## 9. 認識更新と公開準備の具体順
音声deltaは受信時にinputRevisionを増やして既存proposalを無効化する。800msの入力休止で認識を要求するが、これは認識表示更新のトリガーだけでユーザーの意思確定と扱わない。delegationでも同じinputRevisionを使い、写真/音声/委譲で同一入力の認識を二重実行しない。API実行中に新入力が来たら最新1件だけ待機し、古い応答を破棄。認識待ちは操作不能の待機として時計を止めるが会話中のバックグラウンド認識は止めない。ボタン有効条件は写真処理完了、proposal.inputRevision==current inputRevision、status=playing、非busy。
公開準備: loopback local/adminを起動→cloudflared起動→URL厳密検証→local設定へIPCで完全一致Host/Originを登録→公開health疎通確認→招待QR発行。公開URLが未確定の間はQRを出さない。設定用HTTP endpointは設けない。PUBLIC_GAME_URLの場合も同じ許可登録と疎通確認を通す。トンネル終了時はQRを無効化してlocalも停止する。
API操作のHTTP応答が届かない再送は同じactionId。AI失敗の明示再試行だけ新actionId。時間切れと処理開始は同じ同期更新内で判定し、既に終端なら判定要求を発行しない。

## 10. relayの課金要求予約
Live作成/Responsesとも、認証→token所有権→globalとtoken予算→同期アトミック予約（同時枠/試行回数）→upstream awaitの順。失敗/timeout/不正応答でも試行回数は返却しない。作成中も同時Live枠を占有。Live作成結果不明の場合は当該tokenの新規作成を停止し、運営の確認まで再作成しない。Responsesはfinallyで同時枠のみ解放。
relayのglobal枠はtoken再発行でリセットしない。起動時必須設定: 全体Live作成数、全体Responses試行数、global同時数。発行APIにもglobal認証試行枠を適用。再起動で枠が戻るMVP制約を運営に明示し、予算監視を代替したと扱わない。
公開localの旧/api/connectionとbootstrapからはmock診断だけを許可し、live modeでは旧connectionを404にする。live作成はplay_owner取得後の/api/play/liveだけ。公開bootstrapはAIを呼ばず、モードと参加状態のみ返す。

## 11. 判定後の競合防止
commitのAPI応答適用直前にsession id/generation/pending actionId/非終端を再照合する。reset/expire/endはgenerationを増加してpendingを無効化し、可能ならAbortControllerで要求を中止する。中止で課金枠は返却しない。遅延判定は状態・在庫・行動・音声へ一切適用しない。invalidated actionIdへの再送は410。テストに判定中reset/失効/終了を必須追加。

## 12. 音声切断と終了確認
heartbeatは{generation,voiceState:connecting|connected|disconnected|failed|closed}。ブラウザのconnectionstatechange直後にも送信する。localは所有権/generation照合後、playing中のdisconnected/failedでrecovery pause、connectedで同pause解除。connectingは再接続待ちとして同じ待機予算を消費。closedはendへ。HTTPS heartbeatが30秒途絶してもrecoveryへ移り、待機予算超過でexpire。時計停止要求はプレイヤー申告なので最大60秒の合計予算を越えさせない。HTTPSが継続するWebRTCだけの切断をテストする。
relayはhangup確認が済むまでtoken/global同時Live枠を保持し、新規作成を拒否。3回のhangupが失敗しても枠を解放せず運営確認待ちにする。新session接続は旧session終了確認後だけ。実時間deadlineは停止/再接続で延長しない。

## 13. 計画レビュー記録（2026-09-12）
software-design-reviewer観点: 判定await後の失効競合→§11とdata-modelへ反映。HTTPS正常/WebRTC切断の通知不足→§12とheartbeat契約へ反映。
security-reviewer観点: 有料要求の並行予約→§10へ反映。hangup未確認中の再作成→§12へ反映。
親担当がspec全要件と§6の対応を確認。これは設計文書レビューでありコードレビュー・実API・実機成功を意味しない。eval-workflow未導入、脅威モデルなし。

## 14. 判断ブリーフ
1. 音声はGPT-Live、写真と判定はResponsesで分担。同一相手との会話としてUIをつなぐ。直接画像をLiveへ渡す仕様は存在しないため採用不可。
2. 同時1プレイ、リロード/短い切断は所有cookieで復帰。再接続待ちは合計60秒まで。超過/サーバ再起動ではやり直し。永続復元を追加すれば実装が増える。
3. 実音声接続の上限10分、tokenあたりLive作成3回・Responses40回を初期値にし運営設定で調整。絶対金額保証ではない。実APIの利用権限と予算は実試験前に確認。
既存合意のモバイル主/QR/1障害→3障害/メディア後続はそのまま進める。API内部型・競合処理・テスト詳細は本文を参照。
