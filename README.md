# Call to the Past — 未来からの着信

身近な物の写真と、音声で伝える意外な使い方で、未来の自分を脱出へ導くAIゲーム。
プレイヤーの発想をAIが理解し、状況に合う攻略として物語へ反映することが体験の核です。

**現在はWeb版の開発基盤です。ゲーム本編・GPT-Live音声・実画像/動画生成は未実装です。**
APIキーなしで、画面→ローカルサーバー→中継サーバーのモック通信を確認できます。

## 起動

Node.js22.12以上とnpmを用意し、このリポジトリのルートで実行します。

```sh
npm ci
npm run dev:all
```

[開発画面](http://127.0.0.1:5173) を開き、合言葉 **local-demo-only** で「接続を確認」。
これは公開された開発専用の合言葉で、実APIへの通信や課金はありません。Ctrl+Cで3プロセスを停止します。

運営の中継へ接続するときは .env.local.example を .env.local にコピーしてRELAY_URLを設定し、`npm run dev`。
審査員はプロバイダーのAPIキーを用意しません。運営が別途共有する合言葉を使います。
詳細は [起動・運用手順](docs/development.md)。

## 構成と作業場所

| 場所 | 担当 |
|---|---|
| apps/web/ | React/Viteの画面 |
| apps/local-server/ | 審査員側。設定読込、今後のゲーム進行/prompt/状態管理 |
| apps/relay/ | 運営側。認証・利用制限・通信。現在はモック診断のみ |
| packages/shared/ | 通信型とシナリオ検証 |
| scenarios/ | プランナーが編集するJSON |
| specs/web-foundation/ | Web版の合意・仕様・計画・タスク・検証 |
| .agents/skills/call-to-past/ | 既存Codex試作。ドッグフーディング用の参考 |

[構成と境界](docs/architecture.md) / [シナリオ編集](docs/planner-guide.md) / [ゲームの合意事項](specs/web-foundation/game-direction.md)。

## ゲームの初期方針

- GPT-Live音声で相談し、AIの理解した使い方を短文表示。「これで実行」で確定。
- 3障害・最大4行動・1回2枚・全体5分。JSONで調整。
- 道具は状態を持ち越し。失敗後も別の工夫を試せる。
- 結果を音声で先に伝え、画像を非同期表示。成否通知後にエンディング動画を生成。
- 動画は成功/失敗の両方。現時点で必須だが、時間不足時の削除候補。

## 検証

```sh
npm run check
npm test
npm run build
```

[実施結果と未実施項目](specs/web-foundation/verification.md)を参照してください。モックの成功は実AI接続や面白さの検証を意味しません。

## ハッカソン提出

| 提出物 | 現在 |
|---|---|
| GitHubソース | local/UI/relayコードを含める。秘密は除外 |
| 動作するゲームデモ | 未完成。現在はモック通信のみ |
| プロジェクトの説明 | 本READMEと合意事項 |
| 応募部門 | 未確定 |
| OpenAI活用説明 | GPT-Live会話を必須に計画。判定/画像/動画のモデルと実績は後続で追記 |

ゲームロジックは審査員のローカルで実行し、運営サーバーは認証・利用制限・API中継を担当する設計です。
外部依存の審査規定適合は未確認。審査後に中継を停止するため、運営の利用枠によるAIプレイも終了します。
第三者のキャラクター/アセット/音楽は権利を確認したものだけ使用します。

## 開発ワークフロー

[SpecWorkflow](https://github.com/edom18/SpecWorkflow)を使用します。仕様→計画→タスク→実装→レビュー。
[AGENTS.md](AGENTS.md)が共通指示の正本で、[CLAUDE.md](CLAUDE.md)も同じ方針を参照します。
レビュー実行台帳 .specworkflow/review/ はGit対象外、仕様・設計判断は記録します。

旧試作の利用方法は [旧スキル](.agents/skills/call-to-past/SKILL.md)、[旧仕様/検証](specs/call-to-past/verification.md)。
旧試作のルールやテスト結果を、Web版の確定事項・実績として扱いません。

次の開発は [後続の進め方](specs/web-foundation/next-steps.md) を参照してください。

## ドッグフーディング用のCodex試作

このリポジトリをCodexで開くと、`.agents/skills/call-to-past/` がプロジェクト用スキルとして検出されます。ユーザー領域へのコピーは不要です。表示されない場合は新しいセッションを開始してください。

```text
$call-to-past を使って、新しいゲームを日本語で始めてください。
```

実行スクリプトと素材は、読み込んだ `SKILL.md` のあるフォルダを基準に参照します。プレイ記録は作業フォルダ内の `runs/call-to-past/` へ保存するため、通常はリポジトリルートから実行します。[CLI手順](.agents/skills/call-to-past/references/cli.md)も参照してください。

試作のテスト（リポジトリルート、ネットワーク・有料生成なし。Windowsでは `py` も使用可能）:

```powershell
python -X utf8 -m unittest discover -s .agents/skills/call-to-past/tests -v
```
