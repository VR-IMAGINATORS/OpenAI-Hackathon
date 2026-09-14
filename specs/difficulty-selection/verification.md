# 検証結果（2026-09-14）

- `npm.cmd run check`: 型・シナリオJSON検証成功。
- `npm.cmd test`: 336件成功。難易度追加テスト11件を含む。
- `npm.cmd run build`: UI・サーバービルド成功。
- `opening-smoke.cjs`: 日英の難易度選択、空欄alertとフォーカス復帰、認証失敗、選択した難易度の送信、追加クリックなしの導入遷移、着信応答前のマイク/API未開始を確認。
- `core-smoke.cjs` / `mobile-smoke.cjs`: 自動行動、時計表示、接続・復帰・写真再送・明示終了の既存フロー成功。
- ブラウザはChrome headless。390×664、375×600、320×568、1280×900 CSS pxの日英表示で開始ボタンが画面内、横方向のはみ出しなし。
- スクリーンショット: `artifacts/join-difficulty-ja.png`、`artifacts/join-difficulty-en.png`（Git対象外）。日本語画像を目視確認。
- 難易度ごとの時間切れ、行動回数上限、3行動成功でhappy ending、HTTP再送競合・状態復元・プレイヤー分離を課金なしで検証。
- テストのAPI・音声・撮影はfake。実スマホSafari、実GPT-Live、実撮影、実課金、難易度の面白さは未検証。
- マルチレビューはユーザーのプロジェクト指示に従い未実施。

## 難易度ボタンで直接開始する修正

- 3つの難易度別開始ボタンへ変更し、radioと共通開始ボタンを除去。
- `opening-smoke.cjs` を `TEST_DIFFICULTY=normal/hard/nightmare` の3パターンで実行し、押したボタンに対応する難易度がプレイ作成APIへ渡ることを確認。
- 全3ボタンの日英空欄ポップアップ、フォーカス復帰、4表示サイズでの画面内表示を確認。
- `npm.cmd run check` / `npm.cmd run build`: 成功。サーバー処理の変更なし。
- `core-smoke.cjs` / `mobile-smoke.cjs`: 新しい開始ボタンと認証中の待機に合わせて更新後、成功。日英のスクリーンショットを目視確認。
- 今回も実スマホ・実APIの検証は未実施。

## ボタンの色分けと矢印の拡大

- Normalを緑、Hardをオレンジ、HELLを赤に変更。ボタン内のStart／開始の行を除去し、上部の矢印・円を拡大。
- `npm.cmd run check`、`npm.cmd run build`、`opening-smoke.cjs` 成功。日英・4表示サイズで全3ボタンが画面内に収まり、空欄ポップアップと直接開始の既存動作を確認。
- 日本語スクリーンショットを目視確認。実スマホ・実APIは未検証。
