# 検証 — 2026-09-18

## 確認済み

- 公式GPT-Live/ChatGPT Voice/App Serverの資料と、固定版0.154.0-alpha.6.2の生成型を照合。
- 実バイナリの未認証listVoices応答: v1=9、v2=10。新コマンドの--checkでも再確認。
- TypeScript `--noEmit`: 成功。
- Codex関連自動テスト32件: 全件成功。今回追加の6件は模擬音声上流で、所有者分離、model/version固定、通知先着、異常通知、60秒制限、20秒通信断、認証待機期限、停止不能、起動中取消、Cookie/Origin/Host/body制限を検証。
- Chrome headless UI確認: fake認証・fakeマイク・fakeWebRTC。承認→SDP交換→固定speech→受信metrics→停止、会話本文非表示、別モデル報告時の停止、390pxの画面を確認。ページ例外なし。スクリーンショット `runs/codex-live-smoke/connected-mobile.png` を目視確認。
- git diff --check: 成功。

## 未確認

このPoCでの実OpenAIログイン、GPT-Live実接続、マイク入力/音声出力、利用枠/請求、他の実アカウントでの可用性、本編の音声制御互換性。模擬データのmodel表示や1234 bytesを実モデルの結果として扱わない。

既存ゲームのAPI音声は変更していない。ローカル音声PoCの実行にはAPIキーを読み込まない。
# 追加診断（2026-09-18）

- ユーザー実機続報: 音声接続と双方向会話が成功。モデルへの質問時に `delegation.created` が発生。相槌でも発話が継続。自己申告はLiveだがプロトコル上の報告モデルは未確認。
- 固定文送信への反応は「聞こえてるよ」等で、送信文の逐語読み上げではなかった。UIを「テスト文を送信」へ修正し、期待結果を音声反応へ訂正。委譲結果の返却、ゲームの確定事実の反映、モデル同定、利用枠の扱いは未検証。

- 最新の実機結果: `{"detail":"Field session.model is not allowed for this Codex realtime session"}`（原文の項目名を囲むバッククォートのみ省略）。拒否対象をsession.modelと確定。音声開始RPCからmodelフィールドを除去し、画面・起動ログ・仕様の要求モデル表示をCodex標準へ更新。バックエンドのthread/startモデルは別指定のため維持。接続後のモデル判定と停止は維持。実接続成功は再確認待ち。

- 最新: 拒否対象が再び伏字となったため、既知語・厳密な文型による抽出を廃止。開始時エラー本文から一般的な認証情報・URL等を伏せて表示する方式へ変更。サーバー応答に診断版 `startup-detail-v2` を付加し、旧プロセスとの識別を可能にした。型チェック・関連10テスト成功。実接続の原因と成功は未確認。

- prompt除去後も `... is not allowed for ... codex realtime session` が継続。prompt仮説では未解消。次の設定変更は行わず、この検証エラー形式に限って短い項目名・セッション種別を抽出する診断へ変更。合成テストの項目名は実際の拒否対象を意味しない。

- 続報: `[redacted] is not allowed for [redacted] realtime session`。拒否対象は伏字のため未確定。候補である任意の音声promptを除去し、技術用語の許可リストへprompt/instructions/ChatGPT等を追加。実接続の再確認待ち。

- ユーザー実測: ログイン後の開始時に `VOICE_UPSTREAM_ERROR / starting/error/UNKNOWN`。音声接続成功は未確認。
- 未ログインの隔離プロセスで `thread/realtime/start` を試し、HTTP 401のerror通知を確認。認証済みユーザーの失敗とは別条件であり、同一原因と判断しない。ダミーSDP、APIキーなし、プロセス終了済み。
- 開始時エラーの技術用語を許可リストで残す診断を追加。URL・未知の語・値は伏字とし、原文をログ保存しない。
