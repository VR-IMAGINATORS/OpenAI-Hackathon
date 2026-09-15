# データ契約

- `Scenario.rules.initialCredits`: 20〜100000の整数、20の倍数。旧 `maxPhotoSends` は拒否。
- `PublicGameState.creditsRemaining`: 初期値から確定消費と未確定予約を引いた利用可能残高。
- `PublicGameState.initialCredits`: プレイ作成時に固定した初期値。
- `PublicGameState.lastCreditCharge`: null、または `{ sequence, kind: 'conversation' | 'photo', amount }`。本編の一時通知に使い、リザルトの内訳には使わない。
- `GameCredits`: 操作IDごとの予約/確定状態。同じIDの確定は一度だけ。失敗時の未確定予約だけ返却。
- 会話のIDはgenerationと最後のevidenceSeq。処理済みの発言prefixを記録して委譲救済・再送の追加消費を防ぐ。画像のIDは写真受領チケットで、HTTPの同requestIdは既存Promiseへ接続する。
- `IntentDecision` の相談は `responseKind: 'answer' | 'correction'` を分類AIから受け取る。訂正は直前の聞き間違い等の修正に限定し、新規質問・指示を無料扱いしない。金額はAIから受け取らない。
- `GameEndReason` に `credits_exhausted` を追加。状態は既存の `lost`、評価は既存の解除数による判定を使う。
