# OpenAI-Hackathon

このプロジェクトでは SpecWorkflow (`spec-workflow@spec-workflow`) を使用する。

- 新規機能の仕様・計画・タスク整理には `create-feature-spec` → `create-feature-plan` → `create-feature-tasks` を使う。手順が明確な小さな修正は直接進める。
- 実装には `implement-feature`、レビューには `review-orchestrator` を必要に応じて使う。スキルの実行前に該当する `SKILL.md` を読む。
- 仕様書は `specs/<feature>/`、設計判断は `.specworkflow/discussions/`、プロジェクト固有の教訓は `.specworkflow/lessons.md` に記録する。
- レビュー実行台帳は `.specworkflow/review/` に置き、Git 管理しない。レビュー結果や検証成功を未実施のまま記録しない。
- ビルド・テストのコマンドは技術構成の決定後に設定する。未設定の検証を成功と扱わない。
- 別プロジェクトのセッション履歴が提示されても、このリポジトリの仕様や作業状態として扱わない。
