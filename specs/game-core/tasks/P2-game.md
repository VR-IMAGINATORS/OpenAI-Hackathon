# P2 — GameSession 行動トランザクション

Status: implemented (component verification), 2026-09-13

担当: apps/local-server/game.ts, game-ai.ts, tests/core-game.test.ts。

- ScenarioSnapshot を持つ core セッションで reserveAction を同期実行し、context/game/action/controller の版、音声接続、道具参照、処理中状態、残回数を確認する。写真由来道具には認識済み参照が必要。在庫は未消費なら写真なしで再利用可能。
- judgeAction はサーバー内に保存した予約 snapshot だけを判断へ渡し、事実と在庫を全件検証してから一度だけ確定する。未知の事実・値・遷移・障害外 factKeys・在庫 ID・重複変更は無消費の技術失敗。
- 技術失敗でも根拠発言は予約済みとして保持。同じ根拠/同じ ticket による上流再実行は禁止し、新規発話の再試行のみ許可する。確定済み ticket は同じ結果を返す。
- 部分進展の facts と道具状態を次回判断へ保持。終端では actionEpoch だけを進めて core Live generation を維持する。操作権変更と期限後の遅延判断は破棄。旧 v1 commit 動作は維持、core では LEGACY_ACTION_DISABLED。
- core AI の構造化出力へ factChanges / shortReason を追加し、宣言 facts・許可遷移・locale・共通/固有判断規則を渡す。写真 Buffer は複製時に保持し、完了/失効した予約の写真は解放する。

検証: `npx tsx --test tests/core-game.test.ts tests/game.test.ts` 30 件成功。`npx tsc --noEmit` 成功。実 Live / 物理的判断の品質はこのコンポーネントテストでは未検証。

制約: 根拠 serverSeq の存在、話者、executionEligible の検証は ConversationLedger / IntentCoordinator の担当。GameSession だけに偽造した根拠を渡す API は公開しない。現行シナリオは背景を含む全 factKeys を各障害に列挙しているため、その中の意味上の妥当性はモデル判断であり、現在障害の進展だけをコードで完全保証したものではない。
