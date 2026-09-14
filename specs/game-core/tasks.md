# Game core 実装タスク

Status: P3–P6 integrated; automated and browser verification passed; real API/device gates pending (2026-09-13)

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

承認の経緯は[設計判断](../../.specworkflow/discussions/2026-09-13-game-core-plan.md)を参照。P0の検証ハーネス・実Live用画面を実装済み。実Liveゲートは未完了。工程記録は[tasks/P0.md](tasks/P0.md)、確認手順は[verification.md](verification.md)。

### 2026-09-13 続行時の扱い

日本語の基本3ケース確認後、ユーザーが作業続行を指示。P1の設定・共有契約を先行実装し、技術的な検証は完了。P0の残り実機ゲートを省略・成功扱いせず、依存を満たした全面完了のチェックは保留する。工程は[tasks/P1.md](tasks/P1.md)。

### P2 本編統合

ユーザーの続行指示を受け、本編への意図分類・行動予約・結果通知を統合。全140件の自動テストとChromeのfake検証を通過。実Liveで本編のテンポと終端音声を確認するゲートは保留。工程は[tasks/P2.md](tasks/P2.md)。

### P3〜P6 本編体験の統合

ユーザーが「履歴・画像も実装してからまとめて検証」を指定したため、実機ゲートを成功扱いせず実装を先行。メッセンジャーUI、所有者限定feed/assets、画像生成→重大矛盾検査、終了後保持、日英選択、配布設定と手順を統合。

全172テスト、変更コードのPrettier check、ビルド、Chrome模擬検証を通過。実HTTPサーバーとChromeの写真→自動実行→検査済み画像も接続確認（有料API/マイクだけfake）。実Live本編・生成精度・スマホ撮影・AWS5人の確認は未実施。P0/P4/P7の実機を含む全面完了チェックは保留する。

工程: [P3a](tasks/P3a-store.md)、[P3b](tasks/P3b.md)、[P4](tasks/P4.md)、[P5/P6](tasks/P5-P6.md)。試遊は[動作確認手順](../../docs/game-core.md)。

## 2026-09-14 ハーネス改善
- [x] H1: [委譲の回復](tasks/H1.md)
- [x] H2: [相談回答とLive指示](tasks/H2.md)
- [x] H3: [統合と時間通知](tasks/H3.md)
