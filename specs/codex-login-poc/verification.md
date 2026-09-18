# 検証記録（2026-09-18）

## 起動診断修正
- ユーザーから後片付けメッセージだけが見えるとの報告。提示ログだけで実原因は確定せず。不存在の実行ファイル指定時に同じ先頭表示を再現した。
- Windowsアプリ配下からの対応版自動検出を追加。明示指定は上書きしない。失敗診断をcleanupより先にstdoutへ表示。
- PATHを空にした実プロセスでも、アプリ配下のCodexを検出し`--check`初期化に成功。
- 不存在のCODEX_POC_BINでは対処付きエラー→一時領域削除→exit 1を確認。
- 修正後のPoCテスト13/13、TypeScript検証に成功。実ログイン・推論は再実行していない。

## 実施済み
- codex-cli 0.154.0-alpha.6.2 のローカル型生成とprotocol照合。
- `node --import tsx tools/codex-poc.ts --check`: 実App Serverの初期化と専用領域削除が成功。
- `node --import tsx --test tests/codex-poc.test.ts`: 10/10成功（fake、上流課金なし）。
- `node --import tsx --test tests/*.test.ts`: 978/978成功（課金なし）。
- `node node_modules/typescript/bin/tsc --noEmit`: 成功。
- `node --import tsx tools/validate-scenario.ts`: 成功。
- 新規TSとpackage.jsonにPrettier適用。`git diff --check`成功。

## 実ログイン
専用App Serverからdevice code発行に成功。本人操作を案内したが、3分以内にログイン完了通知が届かずEVENT_TIMEOUTで終了した。専用プロセス・一時領域の破棄を確認。実推論は開始していない。ワンタイムコード・認証URLのクエリ・メール・資格情報はこの記録へ保存しない。

## 未確認
2026-09-18ユーザー提供ログにより、本人のChatGPT認証（prolite）とLunaの実テキスト判断（4,677ms、3,247 tokens）、写真付き判断（4,874ms、3,721 tokens）成功を確認。写真ありの応答は青い持ち手のハサミを認識した内容。元画像はエージェントでは未閲覧であり画像理解の正確さは独立検証していない。利用率表示の前後差は消費ゼロを意味しない。コード・メール・資格情報は転載しない。

スマホ・多人数・既存ゲーム統合はこのPoCの対象外。音声付きゲーム内の遅延・品質は別途確認が必要。

ビルドは未実施（ゲーム/UIの変更なし、CLIはtsx実行）。npmがエージェントのPATHにないため上記の同等Nodeコマンドを使用した。
