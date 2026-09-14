# 検証記録（2026-09-14）

- `npm.cmd run check`: 型・標準JSON検証成功。
- `npm.cmd test`: 372/372成功（課金なし）。
- `npm.cmd run build`: Web・サーバービルド成功。
- Chrome / Playwright: `opening-smoke.cjs`、`mobile-smoke.cjs`、`core-smoke.cjs` 成功。API・WebRTC・マイクを模擬。

`tests/difficulty.test.ts` で難易度別の時間と送信数、HELLの2送信から再利用で3障害突破、送信0回後も追加行動を許可して時間切れまで継続することを確認。`tests/photo-send-limit.test.ts` で実HTTP・画像デコードを通した不正画像/空バッチ/2枚一括の計数、最終送信の重複排除、超過送信の409/PHOTO_SEND_LIMIT、操作権移動と状態復元を確認。既存テストで消費済み道具の拒否・判定失敗・終了分類も回帰確認。

画面では日英の各難易度ボタン、空の合言葉ポップアップ、390×664・375×600の入口収まり、320px幅のHUDを確認。0回でも本編表示を維持し、カメラ・ライブラリ・新規送信ボタンを無効化して継続案内を表示。0回のまま目標更新・再読込できる。画像記録: `artifacts/join-difficulty-ja.png`、`artifacts/join-difficulty-en.png`、`artifacts/hud-small-en-mobile.png`（Git対象外）。

実AIの判断・自然な音声案内・実機撮影・難易度の面白さは未検証。使い回せる道具なら突破できる仕組みであり、どんな道具でも突破できることは保証しない。旧スキーマの移行方法は `docs/planner-guide.md` を参照。別作業の導入会話変更が同じ作業ツリーにあり、その変更は本コミットに含めない。
