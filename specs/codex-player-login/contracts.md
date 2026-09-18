# APIとデータ

全APIは既存Host/Origin制限、no-store、play_session認可の内側。bodyは空object、所有者IDをクライアントから受け取らない。

- GET /api/codex/status: 所有者の状態のみ。未Cookieは401。
- POST /api/codex/login: セッション専用の認証開始。重複は現在状態を返す。
- POST /api/codex/logout: 未プレイの認証取消/破棄。プレイ結合中は409。
- bootstrap.ai.playerLogin: 有効時だけcodex。通常APIモードは省略。
- POST /api/plays: Codex有効時は認証済み必須。playId結合は内部処理。

状態: disconnected、starting、pending、ready、failed。pendingだけverificationUrl/userCodeを返す。期限expiresAtは表示用epoch ms。readyはmodelのみ返しメール/トークンは返さない。世代オブジェクト同一性で遅延完了による古い接続の復活を防ぐ。
