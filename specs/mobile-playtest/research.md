# API調査 2026-09-12

## Decision
GPT-Live gpt-live-1のWebRTC + client delegation。写真はvision対応Responses、localにゲームpromptと状態を置く。Liveへの画像直接入力やRealtime置換は行わない。
Rationale: 公式はLiveの音声会話とbackendの推論を分けている。承認済みのlocal判定/運営relayの境界に合う。
Alternatives: Live responses delegationはbackendの自動処理がlocal状態確定と重複しやすい。汎用relayやブラウザへのAPIキー配布は採用しない。

## 公式契約
POST https://api.openai.com/v1/live/sessions
入力: {session:{model:"gpt-live-1",instructions:string,delegation:{type:"client"},store:false},transport:{type:"webrtc",sdp:string}}
応答201: {session:{id:string},transport:{type:"webrtc",sdp:string}}
ブラウザはoai-events data channel作成→ICE収集→SDP交換→session.started待機。session.startは送らない。
session.input_transcript.delta / session.output_transcript.delta: event_id,delta,start_ms,end_ms。空白挿入せず連結。正式な発話終了を推測しない。
session.delegation.created: event_id,offset_ms,delegation:{id,type:"delegation",target:"client"}。依頼本文は含まない。履歴と状態からlocalが推論する。
session.thinking.append / session.commentary.append: event_id,delegation_id（該当IDまたはnull）,content文字列（500tokens以内）。前者は事実更新、後者は発話を促す。appendedの受付は音声再生完了ではない。
session.close→session.closed、最終usage確認後にpeer/tracks破棄。session.usage.updated.usage.secondsは累積。
POST /v1/live/sessions/{session_id}/hangupでrelayから強制終了。最大duration設定は確認できず独自watchdogを使用する。
sideband wss://api.openai.com/v1/live/sessions/{session_id}/attachは可能だが本MVPでは採用しない。ブラウザ経由イベントは非信頼入力として検証し、ゲームの確定権限を与えない。

## トンネル
Cloudflare Quick TunnelのランダムHTTPS URL。独自ドメイン不要、試遊用、SLAなし、SSE非対応、200同時HTTP要求上限。ブラウザ→localはJSON request/responseでSSEを使わない。音声WebRTCは別経路。ngrok等のHTTPS URLも設定可能にし提供者固有APIをゲームに埋めない。

## 未実測と対応
実Live利用権限/予算/実端末は未検証。資格設定まで課金しない。API契約をfake upstreamと独立検証し、実API未検証を別記録する。Responsesは画像入力+厳密JSON schemaを利用、モデルは運営の許可リストで設定。初期候補gpt-5.6-terraの契約を実装時に公式schemaで再確認。

## 出典
- https://developers.openai.com/api/docs/guides/voice-webrtc?api=live
- https://developers.openai.com/api/docs/guides/live-delegation
- https://developers.openai.com/api/docs/guides/live-conversations
- https://developers.openai.com/api/docs/guides/voice-server-controls
- https://developers.openai.com/api/reference/typescript/resources/live/subresources/sessions/methods/hangup
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
