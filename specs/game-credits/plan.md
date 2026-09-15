# 実装計画

Status: approved (2026-09-15; conversation-approved behavior and explicit implementation request)

## 方針

1. `packages/shared/credits.ts` に料金、`apps/local-server/credits.ts` に予約・確定・返却台帳を追加。`GameSession` が所有し、枯渇の終了判定は受理済み処理の完了後にする。C1/C3/C4。
2. `difficulty.ts`、`scenario.ts`、標準シナリオJSONと `ScenarioCatalog.current` を `initialCredits` に移行。公開状態は `creditsRemaining` / `initialCredits` / 最後の消費通知を持つ。C1/C2。
3. `GameRuntime.photos/processPhoto` で写真処理全体の予約を管理。consultとexecuteはgeneration/evidenceSeqで一度だけ精算。雑談を分類対象にし、認識訂正と処理失敗は消費しない。再接続は未確定予約のみ解除。C3/C4。
4. `JoinScreen` / `GameResourceCounters` / `PlayScreen` をクレジット表示と写真費用に応じた操作可否へ移行。残20%の警告と指定の終了通知を加える。`EndingVideo` と結果評価は変更しない。C5/C6。
5. 既存の写真・難易度テストを新仕様へ更新し、課金境界と最後の一手を追加検証。`npm run check` / `npm test` / `npm run build`、可能なら既存ブラウザスモークを実行。C7。

## データ・安全性

予約額も公開残高から除く。操作IDが同じ要求は一度しか引かず、失敗は返却する。料金と初期残高はサーバー設定で固定し、ブラウザから指定しない。既存認証・API予算・写真容量上限は継承する。APIエンドポイントは増やさず公開stateだけ更新するため、別のOpenAPIファイルは作らない。

## カバレッジ確認

C1/C2は設定・ゲーム状態、C3/C4は台帳とRuntime、C5は本編UI、C6は既存ending回帰、C7は検証・コミットで対応。マルチレビューと外部issue起票は今回のローカル実装に含めない。
