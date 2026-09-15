# データモデルと寿命

## AuthSession（プレイ枠ではない）
32byte乱数tokenをHttpOnly Cookie `play_session` に保存し、サーバーはSHA256 digestをキーにMapで保持。fields: expiresAt（セッション発行・更新から30分、固定）、activePlayId|null、lastCreateRequestId/result（冪等応答用）。上限1000件/環境、期限掃除あり。再認証は有効cookieがあれば同じ所有者を延長し、別枠を発行しない。認証期限は進行中プレイの強制終了条件にせず、そのプレイの絶対期限まではauthorizeを許可する。
再起動でAuthSessionも消える。cookieがあるのにMapにない場合はSESSION_EXPIRED。画面は更新・期限切れの可能性を案内し、再認証→最初から。再起動による失効だけを断定しない。

## PlayRuntime（所有者ごとに1件）
- id: UUID、ownerDigest、createdAt、deadline（単調時計で+600000ms、不変）。表示用expiresAtはUTC。
- game: 既存GameSession。scenario snapshot、photos、transcript、proposal、revision、pending action等はすべてこのインスタンス内。
- lifecycle: connecting | active | recovering | closing | terminal | quarantined。
- clientId: タブがメモリだけに持つUUID。初回取得のみに設定。controllerEpoch: 整数。leaseUntil: 最後の正当heartbeat+30秒。新ページは新clientIdとなる。
- recoveryDeadline: 初期接続中はcreatedAt+60秒。切断通知時は最初の通知時刻+60秒、heartbeat欠落ではlastHeartbeat+60秒。重複通知・connectingへの変化では延長しない。
- lastHeartbeat、voiceState、generation、seenEventIds（最大10000）、transcriptTimer、endingTimer、recognitionQueuedなどはruntime単位。
- live: pendingCreate、providerId（serverのみ）、generation、closingPromise、closeAttempts、unknownCreateフラグ、最後のリクエストID/SDP応答キャッシュ。
- budget: liveAttempts（初期上限3）、responseAttempts（40）、responseBusy。再接続・制御権移動で初期化しない。

## EnvironmentState（プロセスごと1件）
Auth Map、Play Map、provider reservations、admission=open|draining、bootId、version、limits、利用回数。
capacity=5。connecting/active/recovering/closing/quarantinedを占有に数える。枠判定とMap追加は同じ同期処理で行いawaitしない。provider Live予約は作成前から終了確認まで保持し、再接続は旧接続終了後のみ。通常、play枠とLive枠は対応するがLiveがないconnectingもplay枠を使う。
terminalの簡略結果は2分だけ保持し、写真・発言・SDP・イベントを即破棄する。所有者は結果保持中でも、終了確認済みなら新プレイへ移れる。旧playIdのイベントは新プレイへ届かない。quarantinedは予約と最低限の内部情報のみ保持し、全体5枠なので無限増加しない。

## 時計の優先順位
1. 明示終了、全体deadline10分、運営drainは即ゲームを終了する。
2. 切断deadlineは最大60秒（初期接続・briefingにも適用）。activeへ正常復帰したら解除する。
3. 既存GameClockは本編開始後のゲーム残時間と累計待機60秒を維持。AI待ち・音声回復でこの累計を消費するため、それが先に尽きれば切断deadline前でも失効する。「60秒必ず待つ」と表示しない。spec R06の最大値の解釈。
4. 勝敗後の既存音声演出（server最大12秒、browser最大10秒）も上記期限内。絶対期限を超えて延長しない。

## タブ操作権
POST /api/play/controlでclientIdを照合。異なるclientIdが有効lease内なら409 CONTROL_BUSY。ユーザーが「この画面で再接続」を選んだ場合だけtakeover=trueでepoch増加、旧音声終了と新制御権を確保する（寿命・枠を増やさない）。lease切れならtakeover不要で取得可能。認証cookieだけではmutation不可。X-Play-Id、X-Client-Id、X-Control-Epochを全mutationで照合する。初回POST /api/playsはclientIdをbodyで受ける。
ページリロード直後はGET状態のみ取得可能。期限内に明示再接続して操作権を移す。再接続に必要なユーザー操作はモバイル音声制約にも合う。game generationとcontrollerEpochは別概念として、古い操作・非同期結果の適用を防ぐ。

## 状態遷移
authenticated(no slot) → connecting(reserve) → active(briefing/playing/judging) ↔ recovering → closing → terminal。
作成結果不明またはhangup3回失敗はquarantined。初期接続を行わないまま60秒経過・マイク拒否はLive未作成なら安全に解放。ブラウザのtimeoutだけを未作成の根拠にしない。
全ての外部await後、runtime同一性、非終端、generation、controllerEpoch、該当revisionを再検証する。staleなLive作成完了は結果をUIへ渡さずhangup対象にする。予約回数は失敗しても戻さない。

レビュー反映: 写真requestId台帳はPlayRuntime内に最大100件保持し、inputDigest/statusを記録する。同じIDと同じ画像は再課金せず処理を共有する。異なる入力のID再利用は409。旧epochに属する要求は制御権移動後に適用不可。
