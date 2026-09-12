# 03 接続画面
spec.md F03/F04とcontracts/openapi.yaml、packages/shared/api.tsを参照。依存01、02と並行。
DoD: 公開bootstrap表示、合言葉/認証なし、接続の成功/失敗、狭幅・label・モック明示。ゲーム本編は含めない。
## 工程
- [x] 画面とCSS
- [x] ビルド
- [x] mainへの結果報告

## 実装記録
2026-09-12。apps/web/index.html、src/main.tsx、src/App.tsx、src/styles.cssを作成。
公開シナリオ・初期制限・中継状態を取得し、required時の合言葉入力、none時の省略、接続確認、成功後の入力消去、失敗表示・状態再取得を実装。通信中の送信制限、label、live region、focus、狭幅用CSS、reduced-motionを追加。開発用モックであることと音声・写真・本編の未実装を画面で明示。
主担当がビルド・型チェック・ブラウザ表示を統合確認し、成功。
統合検証結果: [検証結果](../verification.md)。2026-09-12、mainがcheck/test/build/ブラウザ/起動停止を確認。
