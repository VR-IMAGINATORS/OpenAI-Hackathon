# データ

- 設定: `creativity: { enabled: boolean, successProbability: number }`。確率は0以上1以下。設定省略時は無効。
- AIの判定補助: `kind`（ordinary/stretch/invalid）、`approach`（道具の種類・作用・対象を含む短い正規化した方法）、`equivalentAttemptId`（同じ状況で過去に評価した案のID又はnull）、`effect`（edge/leverage/reach/weight/friction/absorb/light/precision/other）。いずれも内部データ。
- 台帳: 障害と実際のfact値から作るscope、道具名/状態と用途から作る一致キー、短いapproach、サーバー発行ID、固定した分類と許容結果。写真の再送や在庫への具現化で変わるIDを一致キーにしない。
- 過去案入力はID/approachのみ。抽選結果をAIへ渡さない。最大100案、追い出しなし。上限は既存のAI利用制限と併用し、技術的失敗として処理する。
- 公開結果/APIは既存形式。追加の台帳・乱数・私的な成立理由を公開状態へ含めない。
