# 検証

- TypeScript型、標準シナリオJSON検証、全tests/*.test.ts、Vite/UI・サーバービルド: 成功。
- 模擬App Server: PNG生成結果の先着イベント→JPEG変換→Codexによる模擬検査→既存画像欄ready→認証付き画像取得を確認。導入説明後の公開ゲートはテスト内で模擬解除し、実音声成功とは扱わない。
- 未対応、利用枠不足、不正base64、キャンセル→turn/interrupt、スレッド後処理を検証。生成済みスレッドの通常失敗では音声workerを破棄しない。
- 実CLI未認証: thread/realtime/listVoicesのdefaultV2=marin、modelProvider/capabilities/readのimageGeneration=trueを確認。
- 本人の接続ではmarinが拒否され、対応一覧にあるjuniperへ修正。変更後の聴感と実画像生成・モデル側の道具選択・画像品質: 未確認。

再試行手順: npm run play:codexで再起動→画面再読み込み→本人ログイン→音声接続。Codex画像: starting/completedと検査後の画像表示を確認。失敗時は画像欄とCodex画像/scene_image_failedの安全なコードを共有する。画像生成モデルはCodex側制御で、API側のFlareモデルを使ったという意味ではない。
