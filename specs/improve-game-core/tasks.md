# 実装タスク一覧

計画・評価契約はユーザー承認済み（2026-09-15）。T01〜T09実装完了、T10の模擬CLI 3→6統合は成功。check・850テスト・build成功。実APIの初回3プレイと評価は完了したが品質未合格。ユーザー試遊で内扉の説明の分かりづらさを確認。残り6プレイと実機確認項目の完了は未達。PR先はdevelop。マルチレビューは実施しない。

正本: spec.md、plan.md、data-model.md、contracts/cli.md、../../.specworkflow/eval/contracts/improve-game-core.json。型・列挙値は正本を参照しIssueで再定義しない。

- [x] [T01 原資料の固定と拡充データスキーマ](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/58) — 依存: なし
- [x] [T02 本編と模擬プレイの共通ハーネス抽出](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/59) — 依存: なし
- [x] [T03 調査会話・積極性・無害な補完](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/60) — 依存: #58, #59
- [x] [T04 公開画像情報と調査中の時計](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/61) — 依存: #58, #60
- [x] [T05 評価の予算・使用量・版別保存](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/62) — 依存: #58
- [x] [T06 既存ストーリー拡充モードと静的検証](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/63) — 依存: #58, #62
- [x] [T07 共通ハーネスの盲検テキスト模擬プレイ](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/64) — 依存: #59, #60, #62, #63
- [x] [T08 独立評価・反証・設定不備だけの修正](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/65) — 依存: #63, #64
- [x] [T09 元全文との比較HTMLと固定版の採用](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/66) — 依存: #61, #65
- [ ] [T10 統合検証・初回実測・実機確認](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/67) — 依存: #61, #66

## 実行記録（2026-09-15）

- 既存ブランチ `codex/improve-game-core` を確認。未追跡の仕様・原資料・引き継ぎ・レポートを保持。
- 通常権限の `git status` は起動前の `helper_unknown_error: setup refresh had errors` で失敗。PowerShell明示でも同様。正規の権限昇格で確認成功。
- GitHub Issue #58/#59 の完了条件を確認。ローカル `tasks/` に担当ごとの工程と検証を記録し、完了条件を満たすまで完了扱いにしない。