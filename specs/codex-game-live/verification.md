# 検証結果

- TypeScript型チェック、標準JSON/シナリオ検証: 成功。
- 既存を含むtests/*.test.ts全体: 成功（模擬AI、API課金なし）。
- Vite UIビルド・サーバーTypeScriptビルド: 成功。
- Codex専用transport: model/prompt省略、v3、先着SDP、他thread隔離、連続5000音声通知、停止確認、失敗時破棄を模擬検証。
- APIキーなし設定: API transportの暗黙生成拒否、本人workerへルーティング、無関係なplayId拒否、画像生成0回、終了時破棄をHTTP統合テストで確認。
- ブラウザ: fake認証の日本語/英語・モバイル幅・APIモード。fakeWebRTCで公開指示の初期化、文字起こし→委譲の順序、確定結果を一度だけ送信、終盤マイク停止と音声終了を確認。
- 4312の一時プレビューはHOSTED_NO_ENV_FILE=1で起動、APIキーを設定せずCodex構成のサーバー起動を確認。実認証・実AI接続は行っていない。
- ゲーム本編の実アカウント完走・実音声の演技/事実整合性はユーザー実機確認待ち。独立PoCで確認済みの実音声を、統合版の成功として扱わない。

## 2026-09-18: Codex wire format correction

Real account failure identified by upstream supported-event list: the Codex route rejects public Live `session.instructions.append` / `session.thinking.append` / `session.commentary.append`.
The server now explicitly returns `protocol: codex-frameless` only for Codex. Its browser adapter converts instructions to a combined `session.update`, facts to `session.context.append`, and delegated results to `delegation.context.append` with `delegation_item_id`. Commentary uses the commentary channel. API mode preserves existing commands and events without this adapter.
Codex `input_transcript.added`, `output_transcript.added`, and `delegation.created` are normalized to the existing game contract. Transcript/delegation offsets use monotonic receipt time, not measured audio timestamps. Repeated source IDs are deduplicated.
Reference: https://github.com/openai/codex/tree/main/codex-rs/codex-api/src/endpoint/realtime_websocket (methods_frameless_bidi.rs, protocol_frameless_bidi.rs, protocol.rs).
Automated adapter and both-route connection checks passed. Actual account voice/gameplay after this correction remains unverified.

### Follow-up: instructions are immutable after initialization

Real connection rejected session.update with `Instructions cannot be updated after initialization.` This supersedes the instruction-update approach above. CodexGameVoice now passes the original server-owned live instructions as thread/realtime/start.prompt. The browser initialization list is empty; subsequent instruction reminders become session.context.append, never session.update. API-key transport remains unchanged. Confirmed against generated ThreadRealtimeStartParams and official build_realtime_session_config implementation (prompt becomes session instructions). Type check, 12 focused tests, and UI/server builds passed; real account retest pending.
