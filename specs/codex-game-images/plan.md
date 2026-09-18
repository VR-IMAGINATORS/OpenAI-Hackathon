Status: approved (2026-09-18 user authorized subscription implementation)

# 実装計画

既存ローカルPoCの範囲を拡張する。AGENTSの指定に従いマルチレビューは行わない。

- tools/codex-poc/game-voice.ts: voice=juniperを開始時に指定。
- tools/codex-poc/image-responder.ts（新規）: 専用のephemeral thread/turnで組み込み画像生成。画像イベントを消費し、バイト数と画像寸法を制限してJPEGに変換。キャンセルはturn/interrupt、終了不明時はworker破棄。
- player-sessions.ts: createImage/createResponseのplayIdを本人のEntryに解決。画像検査のみ既存構造化判断を再利用。生成と判断に別スレッド。
- OpenAITransport: createImage/createResponseに省略可能なplayIdを追加。AiService.mediaCallから所有者を渡す。API実装は既存の引数をそのまま使う。
- apps/server/app.ts: codex専用の画像省略分岐を除去。SceneJobsの検査・予算・公開経路を再利用。
- 設定/UI/docs: サブスク画像の利用と失敗を明示。動画の省略は維持。

安全性: 認証・写真・生成画像をログに出さない。出力の文字列をパスとして無条件に読まない。スレッドとturnの一致を確認。シェル等の不要ツールは無効のまま。画像生成モデルと形式はCodex側制御なのでAPIモデル設定を流用して同一と表示しない。

検証: 所有者分離、画像イベント取り込み・サイズ制限、失敗・キャンセル、キーなし生成→検査→表示、APIの既存テスト。実アカウントはユーザーログイン後に別途確認。
新規ブラウザAPI・永続データモデルは不要。既存SceneImageSlotを再利用。
