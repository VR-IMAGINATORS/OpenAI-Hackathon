Status: approved scope by user (2026-09-18); implementation details maintained by agent

# 実装計画

合意済みのローカル試遊を延長する。仕様/計画/タスクの成果物をローカルに保存し、既存作業ブランチを継続。ユーザーは実装まで承認済み。AGENTS.mdの指示に従いマルチレビューは行わない。

- packages/server/ai-config.ts: 明示的なcodex provider。キー要求/保持をしない。AiServiceはprovider専用transportがないと起動を拒否。
- OpenAITransport.createLiveSessionにサーバーだけのplayIdを渡す。CodexPlayerSessionsが同じ所有者のworkerへルーティング。
- tools/codex-poc/game-voice.ts: ephemeral音声thread、v3 SDP交換、started/closed/error確認。RPC通知を独立購読して判断処理のjournal消去と競合させない。モデル/音声/独自promptの上書きを送らない。
- hosted-runtime.ts / web/live.ts: サーバー所有の公開liveInstructionsを初期化commandとして送信。委譲・文字起こし・outboxは既存経路。初期化前にopeningや結果を送らない。
- play-codex.ts: 秘密環境変数をworkerに渡さず、サブスクtransportを注入。生成画像・結末生成を抑止、写真と結果テキストを維持。
- テスト: RPC先着通知・clear競合・所有者分離・接続失敗/停止・APIキーなしconfig・禁止API呼出ゼロ。既存型/標準JSON/テスト/ビルド、模擬ブラウザ、ユーザー実機手順。

設計点検: 判断と音声は同じ認証だが別thread。プロセス停止は両方を終了するため再ログインを要する。音声通知で判断journalが溢れないこと、画像/endingの裏APIが残らないことを優先確認。専用providerは従来API transportを一切生成しない。
