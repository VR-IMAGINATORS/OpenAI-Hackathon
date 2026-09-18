# ログインPoCを試す

## 起動

Node 22.12+、`npm install` 済み、PATH上のCodex **0.154.0-alpha.6.2** が必要です。この版から生成したプロトコルと照合しています。版が違う場合は意図的に停止するため、仕様を再確認して `supportedVersion` を更新してください。通常のCodexの設定・ログインは変更しません。

```powershell
# 課金なし：ローカルApp Serverの初期化だけ
npm run poc:codex -- --check

# ログイン後、Lunaでテキスト判断を1回だけ実行
npm run poc:codex

# 認証と利用枠の確認だけ
npm run poc:codex -- --login-only

# device codeがアカウント設定で使えない場合、PC上のブラウザ方式
npm run poc:codex -- --login browser

# 写真を含めた判断（この画像がOpenAIに送信されます）
npm run poc:codex -- --image "C:\Photos\scissors.jpg" --prompt "写真の道具で紙の帯を切れますか"
```

表示された公式URLを開き、本人がログインします。device codeの待機は3分です。期限切れなら再実行してください。パスワードやトークンをCodexの会話へ貼る必要はありません。

`npm`がこのターミナルのPATHにない場合、依存インストール済みなら同じ処理を次で実行できます。

```powershell
node --import tsx tools/codex-poc.ts
```

WindowsはPATHと `%LOCALAPPDATA%\OpenAI\Codex\bin` 配下から対応版の`codex.exe`を自動検出します。Codexアプリと通常のターミナルでPATHが違っても、この配置なら起動できます。明示した`CODEX_POC_BIN`は最優先で、別実行ファイルへ自動変更しません。APIキーの設定は不要です。

検出できない場合の手動指定（PowerShell）:

```powershell
$env:CODEX_POC_BIN = 'C:\実際の配置先\codex.exe'
npm run poc:codex -- --check
```

Git Bashでは `export CODEX_POC_BIN='C:/実際の配置先/codex.exe'` を使用します。失敗時は後片付けより先に、原因コードと対処を標準出力に表示します。「破棄しました」はエラーではありません。

## 出力の見方

- `App Server初期化: OK`: ローカル通信のみ成功。ログイン成功ではありません。
- `ChatGPT認証: OK`: 専用プロセスで本人のChatGPT認証を確認。
- `利用枠`: アカウント全体の利用枠。ゲーム内クレジットとは別。丸めや反映遅延があり、前後差ゼロでも推論が無料という意味ではありません。
- `判断結果`: 成功turnの最終メッセージをJSON/Zod検証したもの。ゲームへは適用しません。
- `usage=null`: 利用量通知を取得できなかったという意味で、使用量ゼロではありません。
- 最後の破棄メッセージ: ワーカーと専用一時領域を終了・削除。毎回再ログインします。

## エラー

| コード | 対応 |
|---|---|
| CODEX_BINARY_UNAVAILABLE | Codex実行ファイル／PATHを確認 |
| CODEX_VERSION_MISMATCH | 固定版との差を確認。勝手に更新・続行しない |
| RPC_ERROR_* | 認証や機能の拒否。生エラーは資格情報保護のため表示しない。device方式で失敗するならbrowser方式を試す |
| EVENT_TIMEOUT | ログインの未完了または判断の期限切れ。終了後に再実行 |
| CHATGPT_LOGIN_REQUIRED | APIキーなど別認証。本人ChatGPT認証が必要 |
| MODEL_NOT_AVAILABLE | 指定モデルが一覧にない。必要なら本人が `--model` を指定 |
| INCLUDED_USAGE_UNAVAILABLE / USAGE_LIMIT_REACHED | 利用枠回復を待つ。自動購入や運営APIへの切替はしない |
| UNEXPECTED_SERVER_REQUEST / UNEXPECTED_TOOL_ITEM | 想定外のツール・承認要求。PoCを停止し設定を見直す |
| INVALID_DECISION_JSON / TURN_NOT_COMPLETED | 推論結果の検証失敗。成功扱いしない |

## 制約とデータ

一人が自分のPCで使う技術PoCです。ホスト型の多人数サービスではありません。プロセス設定を分けていますが、OSユーザー間の厳密なファイル隔離を提供しません。写真は最大10 MiB／25M pixelsを受け付け、EXIF除去・JPEG縮小後に専用一時領域へ置きます。

環境変数は必要なOS項目だけ渡し、OPENAI_API_KEY／CODEX_ACCESS_TOKENなどは継承しません。認証はメモリ内、threadはephemeral、通常の認証ファイルや.envは読みません。上流の保存条件はChatGPT契約に従い、ローカル削除が上流の全削除を意味するわけではありません。

1回だけ実行し、自動再試行・fallbackはありません。ただしApp Server内部の推論消費量や再接続をこのCLIが厳密にtoken上限で制御するものではありません。本人の枠を消費し、契約によりクレジット消費もあり得ます。枠取得は開始前検査であり追加費用ゼロの保証ではありません。

Ctrl+Cで終了可能。強制電源断などfinallyが動かない場合、一時フォルダ`%TEMP%\call-to-past-codex-*`が残る可能性があります。通常のCodexホームは削除しないでください。

## 検証

```powershell
node --import tsx --test tests/codex-poc.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

実績は [verification.md](verification.md) を参照。fakeの成功は本人ログイン・写真判断の実績ではありません。
