# OpenAI-Hackathon

## 開発ワークフロー

[SpecWorkflow](https://github.com/edom18/SpecWorkflow) を使用します。
`.codex/config.toml` にマーケットプレイスの取得元と、このプロジェクトでの有効化を定義しています。

Codex でこのリポジトリを信頼済みプロジェクトとして開き、設定変更後は新しいセッションを開始してください。
未インストールの環境では Plugins から `spec-workflow@spec-workflow` をインストールします。
Codex CLI を使用する場合の導入コマンドは以下です。

```sh
codex plugin marketplace add edom18/SpecWorkflow
codex plugin add spec-workflow@spec-workflow
```

プラグイン本体の保存先はユーザー領域の `~/.codex/plugins/cache/` です。
プロジェクトの設定は、このリポジトリでの有効・無効を制御します。
他プロジェクトでの有効化状態やユーザー設定は変更しません。
詳細は [Codex のプロジェクト単位のプラグイン設定](https://developers.openai.com/plugins/build/plugins#enable-or-disable-a-plugin-for-a-repo) を参照してください。

導入後は `spec-workflow:doctor` で依存を確認します。Windows のフックスクリプトは Git Bash と `jq` を使用します。
フックはクライアントの対応状況と信頼設定に依存するため、スキルが使えることとフックの動作は別に確認してください。
特に、SpecWorkflow の Codex 用フックには Claude Code 用の PreToolUse による main push / PR ゲートの強制は含まれません。

基本の流れは、仕様作成 → 実装計画 → タスク分割 → 実装 → レビューです。
「SpecWorkflow で仕様を作成して」のように依頼できます。運用方針は `AGENTS.md` を参照してください。

レビュー実行台帳 `.specworkflow/review/` は Git 管理対象外です。
仕様・設計判断・教訓などの恒久記録は Git 管理します。
