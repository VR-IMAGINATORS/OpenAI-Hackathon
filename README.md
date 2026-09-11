# OpenAI-Hackathon

## Call to the Past

Codexの会話で写真を送り、1週間後の自分を助ける脱出ゲームの試作スキルです。3つの障害を1つずつ攻略し、最大4行動。1回の写真は2枚までで、持越品だけなら写真なしでも挑めます。

- スキル: [skills/call-to-past/SKILL.md](skills/call-to-past/SKILL.md)
- 仕様と進捗: [specs/call-to-past/tasks.md](specs/call-to-past/tasks.md)
- 検証結果と制約: [specs/call-to-past/verification.md](specs/call-to-past/verification.md)

インストール後、新しいCodexセッションで次のように呼び出します。

```text
$call-to-past を使って、新しいゲームを日本語で始めてください。
```

写真と「どう使うか」を送ると未来AIが判定し、各ターンの画像を生成します。最後の15秒動画はH3を使用し、素材と見積を提示して承認を得てから送信します。動画API料金とは別にCodexの利用枠を使います。写真コピー・生成物・履歴は`runs/call-to-past/`へ保存し、自動削除しません。

ハッピー・ノーマル・バッドのどの動画も、開始と終了で人物の動作・構図・場所や明るさが大きく変わるよう設計します。確定した結果に合う移動や行動でつなぎます。

Python3.10+とPillowが必要です。H3 Max Turbo I2Vの実行コードは`call-to-past`へ同梱済みで、別途`h3-video`をインストールする必要はありません。動画生成にはfal_client、ffmpeg/ffprobe、FAL_KEYを使います。内蔵画像ツールはFlareの明示指定に対応していません。判定にはSol highサブエージェントを使用します。

開発用テスト（ネットワーク・有料生成なし）:

```powershell
python -X utf8 -m unittest discover -s skills/call-to-past/tests -v
```

模擬テストの成功は、実写真・実生成の通し確認やゲームの面白さを保証しません。現状は上記の検証結果を参照してください。

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
