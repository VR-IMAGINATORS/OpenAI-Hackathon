# T02 / Issue #59 — 共通 GameHarness

状態: 実装・担当範囲の自動検証完了（2026-09-15）。全体の統合検証は親タスクで実行する。実AI・音声・実機検証は未実施。

## 読み合わせ

- 承認済み spec.md、plan.md S2、data-model.md、contracts/cli.md、Issue #59 を確認。
- 既存 GameRuntime の分類・相談精算・写真判定・行動確定は同じ状態を参照しながらLive配送と混在していた。
- 具体クラス GameHarness に進行を抽出し、配送と診断の hooks を注入。音声なしでも new GameHarness が動く。別ゲームルールや private テスト専用経路は追加していない。

## 実装

- apps/local-server/game-harness.ts: 分類、相談確定、写真受理と自律行動、行動予約・判定・確定、知識同期、会話・写真クレジット精算を共通化。
- handleRequest / handleRecognizedPhoto / beginPhotos / cancelPending / publicView を提供。publicReply、committedPublicEvents、publicState と非公開trace配送を分離。
- 公開結果の収集は呼出中だけ。同時呼出を拒否し、古いcontext、gameVersion、actionEpoch、controllerEpoch、generationとabortを検査。内部wait理由を回答として返さない。
- hosted-runtime.ts: Live、会話台帳・IntentCoordinator、発話訂正分類、通知スケジューラー、写真配送、画像・エンディングの配送を維持し、共通ハーネスへ接続。
- game.ts: 既存recognizeのスキーマ・所有物参照・世代/リビジョン検証をcommitRecognizedPhotosへ抽出。重複確定を拒否。HTTPへの認識済みJSON注入APIは追加していない。

## TextPlayAdapter接続契約

1. GameSessionのGameAI.recognizeのみを模擬の日用品認識へ差し替える。判定AIは本編と同じものを使う。
2. new GameHarness({ game, snapshot, client, model, ledger?, now?, hooks? })。
3. 発話はサーバー側でledger.appendし、harness.sync後、captureUnconsumedContextをhandleRequestへ渡す。
4. 写真相当はharness.beginPhotos(count) → game.finishPhotos(photos, ticket, true) → harness.sync(true) → handleRecognizedPhoto({ requestId, ticket })。requestIdはアダプターが生成する。
5. publicViewだけをプレイヤーへ投影する。GameSession、snapshot、knowledge store全体、traceは渡さない。
6. 呼出はプレイ内で順次。signalで取消す場合はpending actionの確定権限も取り消す。

## 検証

- npx tsc --noEmit: 成功。
- 新規 improve-game-core-harness.test.ts: 9/9成功。配送hooksの有無の同値性、相談の二重消費防止、相談前写真の自律1回、危険確認、古い文脈とepoch、同時呼出、分類中と判定中abort、wait理由の非公開、認識境界を確認。
- 最新の重点回帰: harness-actions、harness-knowledge、core-runtime、core-consult、credits、新規harnessの74/74成功。
- 抽出直後の core-media を含む重点回帰: 72/72成功。
- prettierで担当4ファイルを整形。マルチレビュー、課金通信、commit、push、AWS反映は実行していない。

## 続く工程

- S3で有限な調査経路と開示確定をcore-intent-aiとGameHarnessへ接続する。
- S4で初期概要・公開画像・時計の投影を実装する。
- S5で共通入口に日用品一覧と模擬プレイヤーを接続し、本番Runtimeとの入力→公開結果の統合比較を追加する。
