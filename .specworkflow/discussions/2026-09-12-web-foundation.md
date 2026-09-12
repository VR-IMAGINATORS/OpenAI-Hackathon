# Web版の土台に関する決定

2026-09-12。proposal/game-system/game-system.mdからgrill-me Q1〜Q32。

- 詳細合意はspecs/web-foundation/game-direction.md。既存Codex試作は参考で、Web版の確定仕様としない。
- ゲームロジック/JSON/prompt/状態は審査員ローカル。運営は認証/利用制限/秘密キーを使うAPI中継。中継コードも提出。外部依存の審査規定適合は未確認。
- 合言葉は既定有効、運営設定で解除可能。privateリポジトリだけでは中継を保護できない。審査後は停止。
- Q32の「そうですね、それで進めてください。」でREADME/AGENTS/CLAUDE、合意記録、画面・ローカル・中継の最小構成を承認。
- 技術は企画資料で委任済み。まずモックHTTP経路を検証。ゲーム本編・実AI・公開運用の完了とは区別する。
- 新仕様はspecs/web-foundation/。旧試作の検証結果を新仕様の実績に流用しない。
