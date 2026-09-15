# 実装タスク一覧

計画とGitHub登録承認: 2026-09-15。実装を統合済み。533件の自動テストとcheck/build成功。実音声・PC/スマホ確認を要するT01/T06/T08は未完了。マルチレビューは実施しない。

- [ ] [T01 音声活動の計測と実機成立性の確認](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/49) — 依存: なし
- [x] [T02 ハーネス契約と設定・シナリオ移行](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/50) — 依存: なし
- [x] [T03 知識・開示・推測の管理](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/51) — 依存: T02
- [x] [T04 自律行動と確定前訂正・再試行](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/52) — 依存: T02
- [x] [T05 写真自律実行と自然な会話の統合](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/53) — 依存: T03,T04
- [ ] [T06 音声活動APIと期限付き警告配送](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/54) — 依存: T01,T02
- [x] [T07 競合・情報境界・回帰の自動検証](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/55) — 依存: T05,T06
- [ ] [T08 日英・PC・スマホの体験検証と開発資料](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/56) — 依存: T07
