Status: approved direction; scoped implementation of user's request
# 実装計画

- tools/codex-pocの既存RPC/ログインを再利用。worker.tsで継続利用できる専用プロセスを管理する。
- tools/codex-poc/game-responder.tsで既存gameResponseRequest→写真一時ファイル・指示・outputSchema→Responses互換最終JSON。AbortSignalと停止確認を追加。
- packages/server/ai-service.tsに任意のgameResponderを注入。respondGameの予算確保後に呼ぶ。apps/server/app.tsは注入を通すだけとし既定動作は維持。
- tools/play-codex.tsでloopback/一人/ライブモードの前提を固定し、ログイン後に既存HTTPを起動。通常のサーバー起動に認証モードを混入させない。
- fake RPCによる指示/画像/schema変換、複数turn、取消・失敗・fallbackなし、既存予算の維持をテスト。型/標準JSON/全テスト/UI・server buildを確認。

PoCの承認範囲を具体化。公開機能やBYOK画面は追加しない。ハッカソンの方針に従いマルチレビューは行わない。利用者による前段PoCの成功をverificationへ出典付きで記録し、本統合の成功とは区別する。
