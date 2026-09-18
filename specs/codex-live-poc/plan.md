Status: implementation authorized by user investigation-and-implementation request (2026-09-18)

# 計画

既存ゲームのLive契約とApp Serverの実験的音声契約の互換性が未確定なので、先に独立PoCを作る。AGENTS.mdに従いマルチレビューは行わない。

- 調査: 公式Live/Voice/App Server資料、固定版生成型、実行ファイルのlistVoicesを照合。公開Live APIと製品内Voiceを混同しない。
- tools/codex-poc/live-probe.ts: 単一所有者のログイン、thread作成、v3/start、SDP/started通知の検証、固定speech、stop/closed確認と終了。
- tools/codex-live-poc.ts: 127.0.0.1:4311限定HTTP、SessionStore、Host/Origin/body制限。環境APIキー/.env.localは読まない。既存ゲームとは別プロセス。
- tools/codex-live-ui/: 静的ページ、getUserMedia/RTCPeerConnection/oai-events、モデル/イベント/受信バイト数の観測とポーリング。内容の保存なし。
- テスト: 認証所有者分離、明示model/version、通知先着、異常終了、60秒/放置タイムアウト、取消中startup、停止不能。ブラウザはfake認証・fakeWebRTCでUI検証。

本編移行の条件: 実接続/発話/マイク入力、モデル同定、委譲をゲーム側で扱えること、事実注入、割り込み、期限/終了、追加API費用が出ない経路と利用枠を確認。条件が未確認の間は本編の音声を切り替えない。
