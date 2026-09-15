# 実装タスク一覧

対象: ending-video。計画承認: 2026-09-14。

GitHub Issueを正本とし、tasks/は実装中のチェックポイント。

- [x] [01: 結末と提示済み伏線の記録](tasks/01.md) — https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/35
- [x] [02: 脚本・画像・fal生成ジョブ](tasks/02.md) — https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/36
- [x] [03: 認証付き動画配信と再生UI](tasks/03.md) — https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/37
- [x] [04: 配信設定・回帰検証・運営手順](tasks/04.md) — https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/38

ローカル実装と課金なし検証は完了。[検証記録](verification.md)に実環境で残る確認を分けて記載。公開環境へ未反映。

## 2026-09-15: 全アイテムを含む演出への修正

ユーザーの採用指示に基づく既存動作の修正。[検証記録](item-coverage-verification.md)。

- [x] 全行動と完成済み行動前参照を候補にし、序盤・失敗・消耗品を残す。
- [x] 全アイテム対応表と道具・行動・ショットの照合を同じ演出要求へ追加する。
- [x] 入力サイズを圧縮し、両端画像の確定状態と既存の生成回数を維持する。
- [x] 課金なし回帰テスト、型・設定検査、ビルド、仕様更新。
- [ ] 同じ素材で実動画を比較し、画質・アイテムと用途の認識率・追加生成時間を測定する。
