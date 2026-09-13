# P3b — 日英メッセンジャー UI

Status: implemented (mock browser verification), 2026-09-13

- [x] core本編で左右の原文会話履歴を表示し、旧「どう認識したか」/実行確認パネルを外す。旧v1経路は維持。
- [x] GET feed?after= による500ms非重複更新、upserts/removedIds/resetと安定ID順序に対応。
- [x] 写真は撮影/選択→プレビュー→明示送信。通信失敗時は同一requestIdで再確認する既存経路を維持。
- [x] 検査済み画像はcookie + X-Play-Idでfetch→blob。URLは要素破棄時revoke。未検査画像や外部URLは表示しない。
- [x] 画像待ちは数値なし受信アニメーション。failed/cancelledの枠は「未来から画像の受信に失敗しました」。
- [x] messageIdで結果通知送信と表示を対応。未送信は最大2秒で文章にフォールバック。再読/切断/世代違いでは待たない。
- [x] 日英選択を新規プレイlocaleへ渡し、プレイ中は固定。復帰はstate.localeを優先。主要ボタン/会話/在庫/通信エラーを切替。
- [x] 終了後もfeedと画像の閲覧を継続し、所有権失効/保持期限は履歴を消して案内する。
- [x] 390px Chromeの模擬API/WebRTCで原文、removedIds、画像pending/failed/ready、所有者ヘッダー、blob URL、2秒fallback、終了後閲覧、写真未確認時の未送信、送信再試行、command重複抑止を検証。
- [x] 旧mobile-smokeの接続/復帰/リロード/操作権/写真/行動再確認/終了の回帰検証成功。
- [x] 統合HTTPとの実データ検証。主担当が実サーバー+Chromeで写真/原文/行動/画像まで確認（AI/メディアfake）。
- [ ] 実Live/日英音声/実機撮影/生成画像品質と面白さの確認（P7）。

対象: apps/web/src/ChatFeed.tsx, PlayScreen.tsx, JoinScreen.tsx, play-api.ts, styles.css, apps/web/tests/core-smoke.cjs。
検証: npm run check 成功。core-smoke.cjs / mobile-smoke.cjs 成功（Vite 127.0.0.1:5182、実Chrome、fake API/mediaのみ）。画面スクリーンショットを目視し横はみ出し無し。実AIへの課金呼出は行っていない。

追加確認: 英語選択→create.locale=en→英語本編→ページ再読でstate.locale=enを復元し、プレイ中の言語変更UIがないことを検証。英語390px/1280pxで横はみ出し無し。PlayScreenはstateVersionの古い応答を拒否。画像取得時はContent-LengthとBlobサイズの双方で256KiBを超える画像を拒否。スクリーンショット: artifacts/core-p2-mobile.png（終了後履歴）、artifacts/core-p3-en-restored.png（英語再読/PC）。
