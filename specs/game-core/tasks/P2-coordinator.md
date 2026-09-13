# P2 会話台帳・意図コーディネーター

Status: implemented (2026-09-13), production integration verification belongs to P2 parent task.

- `apps/local-server/conversation.ts`: 原文両話者の台帳、UTF-8 64KiB/10,000断片、イベント重複/世代/時刻検証。相談済みまたは予約済みの根拠範囲は再実行しない。
- `apps/local-server/intent-coordinator.ts`: 非同期1worker。受信は同期受付、最大100委譲・pending4・20秒・3評価。訂正/写真/接続所有権の変化は古い推論を破棄。失敗した行動も同じ根拠から自動再試行しない。
- judging中の発言は永久に不適格。既知音声時刻と経過時間で判定中の曖昧区間を保守的に除外するため、後着の音声は再発話が必要になる場合がある。Liveの正確な発話境界の保証ではない。
- judgingフラグのみではcontextVersionを増やさない。予約callbackは分類snapshotと一致したcontextVersionを受け取る。
- テスト: `npx tsx --test tests/core-intent.test.ts`。訂正、相談、失敗/重複、後着、期限、並列上限、世代、容量、根拠、写真変更の11件。
- 実API、実音声、モバイルの成功はこの工程では検証していない。
