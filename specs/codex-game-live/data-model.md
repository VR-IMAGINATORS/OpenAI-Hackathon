# データと所有権

- AiConfig.provider: api / codex。省略は既存API構成。mockとは別軸。codexではapiKeyを保持しない。
- CodexPlayerSessions.Entry: owner digestから既存playIdへbind。専用worker、判断responder、最大1つの音声adapterを所有。
- CodexGameVoice: ランダムproviderId、専用threadId、started/SDP/error/closedを保持。会話内容は保持しない。
- /api/play/live: 既存requestId・SDP・cookie・playId・controller epochを維持。追加応答initializationはサーバー生成の公開LiveCommand配列。初期化を送るまでopeningとoutboxを送らない。
- 委譲と判断: /api/play/events →既存ledger/intent/harness→Codex responder→既存outbox→browser data channel。JSON schemaとサーバーの事実をゲーム状態の正本とする。
- 終了: 音声closed通知を信頼し、未確認を確認済みに変換しない。ゲーム終了後は旧プレイの処理を止め、同じ所有者の認証を10分保持。ログアウト・保持期限・サーバー停止・終了未確認で専用認証を破棄。再プレイでは新しい音声threadを使う。
