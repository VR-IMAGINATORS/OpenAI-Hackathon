# T09 元全文の比較HTMLと固定版採用

Issue: #66 / Status: completed

- [x] 承認済みS7/S8・比較全文要件を確認
- [x] 原文/拡充本文とギミック・解法を同じ粒度で比較
- [x] 会話・補完・評価・費用・版・途中状態を表示
- [x] オフライン描画、HTMLエスケープ、レスポンシブ確認
- [x] live評価済み指定版だけ採用し、新規出力を排他的作成
- [x] T07/T08接続後、未完了・不正digest・mock採用拒否の検証

T08評価型確定前はreport描画の独立部分を実装し、採用可否は統合検証まで未完了。

新規5件成功。合成構造fixtureによる採用成功/改ざん/既存ファイル拒否は一時領域のみ。desktop1440px、mobile390pxでChrome描画目視。mobile viewport/scrollWidthとも390px、1列358pxを確認。実AI評価済み採用は未実施。CLI統合はT06担当進行中。

T08の全turn coverageと引用再検証guardへ接続し、採用fixture5/5再成功。最終CLI通しはT10で確認。
