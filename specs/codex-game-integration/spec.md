Status: approved direction by user (2026-09-18, proceed after successful text/photo PoC)
# Codexによるローカルゲーム判断

以下は初期の端末認証版の仕様。2026-09-18以降、ログインと認証寿命は `../codex-player-login/spec.md` に移行し、ゲーム画面のプレイヤー単位の認証に置き換える。判断とAPIの境界は継続する。

1. `play:codex`で既存ゲームをloopback限定、同時1プレイで起動する。起動端末で本人がChatGPTログインし、同じ本人がローカルブラウザで試す。公開・スマホ・他者参加は対象外。
2. AiService.respondGame経路（写真認識・意図分類・相談・行動判断）だけCodexへ差し替え、既存の入力検証・回数・同時数・期限・ゲーム状態検証を維持する。
3. 通常起動のAPI経路は変更しない。GPT-Live、画像生成/検査、エンディングメディアはAPIのまま。既存.env.localのAPI設定は必要。
4. GAME_MODELを引き継ぎ、対象モデルをCodex一覧で確認。勝手にLunaへ置換しない。instructions/schema/写真を変換し、1判断1thread、JSON結果を既存パーサーへ返す。
5. 専用認証は起動中のメモリ内。中断はturn停止を確認、確認不能時はワーカー失効。曖昧な失敗や枠切れをAPI fallback/自動再試行しない。既存のJSON修復再試行は上限内で維持。
6. 連続判断で写真・通知・threadを解放。アプリ終了でワーカーと専用領域も削除。本文・写真・認証情報を計測ログに出さない。
7. 無課金テストと実ゲームの音声・テンポ検証は別記録。token上限のAPIとの同等性は未確認であり、回数・期限による限定的な試遊と位置付ける。
