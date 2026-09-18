Status: approved scope from 2026-09-18 user instruction; implementation details selected within that scope
# 実装計画

1. `tools/codex-poc/rpc.ts`: 上限付きJSONLパーサー、RPC pending、短期通知履歴、早着通知待機、safe error。サーバー要求は拒否し当該接続を失効。
2. `tools/codex-poc/probe.ts`: account/login/start→account/read→rateLimits→model/list→thread/start→turn/start→item/turn完了。結果をZod検証。
3. `tools/codex-poc.ts`: CLI引数、専用一時CODEX_HOME、限定環境、ephemeral認証、専用cwd、ツール制限、画像正規化、cleanup。--checkは上流ログインせずhandshakeのみ。
4. `tests/codex-poc.test.ts`: fake transportで順序・境界・認証方式・結果選別・枠切れを確認。
5. 実Codexのhandshake、利用者のログイン、1回の推論を順に確認し、verification.mdと手順へ結果を記録。

R1/R5/R6→1,3、R2/R3/R4→2、R7→4,5。既存の未コミット資料は変更しない。ハッカソン中のマルチレビュー禁止を優先しレビューエージェントは起動しない。承認済み資料の独立PoCを具体化するため追加の仕様承認は要求しない。外部issueはこの局所PoCでは作らず進捗をローカルに記録する。
