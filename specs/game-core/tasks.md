# Game core 実装タスク

Status: ready (2026-09-13)

[承認済み計画](plan.md)に基づくGitHub Issue一覧。チェックは実装と各Issueの検証ゲートが完了してから更新する。

## 実行順序

- [ ] **P0** [Live自動実行の縦切り検証](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/21) — 依存: なし
- [ ] **P1** [シナリオ・会話・設定の共通契約を実装](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/22) — 依存: P0
- [ ] **P2** [音声の意図判定と一度だけの行動確定を実装](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/23) — 依存: P1
- [ ] **P3a** [会話履歴と結果画像のHTTP契約を実装](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/24) — 依存: P1, P2
- [ ] **P3b** [日英メッセンジャー風の本編画面を実装](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/25) — 依存: P1
- [ ] **P4** [非同期の状況画像生成と表示前検査を実装](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/26) — 依存: P1
- [ ] **P5** [終了後の結果閲覧と音声・画像の寿命を統合](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/27) — 依存: P2, P3a, P4
- [ ] **P6** [ゲームコアの運営設定と配布手順を同期](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/28) — 依存: P1, P2, P3a, P3b, P4, P5
- [ ] **P7** [ゲームコアの実機・同時プレイ検証を完了](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/29) — 依存: P2, P3a, P3b, P4, P5, P6

## 検証ゲートと並行作業

- P0で実Liveの自動実行方式を検証してからP1以降へ進む。fakeテストだけで通過としない。
- P1完了後、P2・P3b・P4は独立して着手可能。P3bは契約mockで進め、P3a完成後のHTTP統合確認を完了条件とする。
- P3aはP2に依存する。P5で音声・画像・結果保持の寿命を統合する。
- P6で配布設定を揃え、P7で実機・AWS同時プレイ・面白さを確認する。実API、実スマホ、AWSの未実施項目は残件として扱う。

## 共通ファイルの担当境界

- packages/sharedの共通型はP1を基点とし、HTTP型の変更はP3aで正本と同期する。
- apps/server/app.tsはP3aのHTTP境界を先に確定し、P5で終了時の連携を追加する。
- apps/local-server/hosted-runtime.tsはP2が行動確定を担当し、P5が終了後の寿命を統合する。
- packages/server/ai-service.tsはP4の画像枠とP5の取消・停止を順に統合する。
- P7は各Issue担当の単体テストを重複作成せず、境界をまたぐ統合と実機の確認に集中する。

## 記録

承認の経緯は[設計判断](../../.specworkflow/discussions/2026-09-13-game-core-plan.md)を参照。現時点では実装・実Live検証とも未完了。
