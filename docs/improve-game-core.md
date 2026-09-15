# シナリオ拡充と調査ゲームコア

実装仕様は `specs/improve-game-core/`。通常のゲーム・既存generate/evaluate/benchmark/renderは従来どおり使用する。

## 調査の設定

`config/game-core.json` の `companionInitiative`:

- `observations`: 観察事実を中心に回答（標準）。
- `hypotheses`: 既知情報に基づく仮説も提示。
- `suggestions`: 道具や用途の提案も提示。

明示的なヒント依頼は別に扱う。拡充版の `investigation` は初期概要、情報層、補完許可値、公開画像描写、原資料識別子を持つ。補完は同一プレイ内で固定され、設定ファイルへ自動保存されない。

## Web音声とテキスト模擬の共通処理

Webとテキスト模擬は同じ `GameHarness` で調査・情報開示・行動確定・クレジット精算を行う。調査回答は公開事実・不確実性・必要な確認をまとめた資料とし、WebではGPT-Liveが会話履歴と積極性設定に合わせて発話を組み立てる。行動結果の追加 `companion_reply` 呼び出しは行わない。資料を分割する場合も、全体の後に一度だけ発話を依頼する。

テキスト模擬の `publicReply` は同じ公開結果の文章であり、Liveの発話や読み方の再現ではない。音声上の雑談はLiveへ委ねるため、雑談受付だけのターンには模擬の回答原稿を生成しない。統合前の評価実績は当時のコードに対する記録であり、現行の発話品質の証拠として流用しない。

拡充版の画像は公開描写に加え、確定行動の使い方・道具状態・公開結果を描画へ渡す。未開示の内部状態値や検査モデルの非公開説明を生成プロンプトへ戻さない。

## 課金なしで一連の操作を試す

```powershell
npm run mission -- expand --config config/auto-mission/expand-default.json --mock
npm run mission -- expand-continue --input runs/mission-expansion/<run>/manifest.json --mock
npm run mission -- expand-render --input runs/mission-expansion/<run>/manifest.json
```

最初のコマンドは3モデル各1プレイで停止する。続行コマンドで未実行の6組を実行する。mockは共通処理の輸送・状態境界を確認するための合成応答であり、実AIの成立性や面白さの評価ではない。mock候補は採用できない。

## 実API

費用上限を合意してから実行する。キーは運営の環境変数または `.env.local` だけで管理し、ブラウザやレポートへ渡さない。ルート `.env` は読まない。

```powershell
npm run mission -- expand --config config/auto-mission/expand-default.json --live --max-cost-usd <初回上限>
npm run mission -- expand-continue --input runs/mission-expansion/<run>/manifest.json --live --max-cost-usd <追加上限>
```

各明示実行の上限と結果は `executions.json` に保存する。初回3件の使用量と残り予測を確認してから続行する。使用量不明の通信は予約額を保持する。2026-09-15のユーザー指定により、拡充CLIの1リクエスト待機上限は10分（各処理の全体期限が先ならそこで停止）。入力の大きさ、API時間、呼び出し数、トークンにも別の上限があり、費用内でも未完了で止まる場合がある。

モデル・プロンプト・コード・候補版・道具一覧などの固定条件が変わった場合、旧結果は流用しない。評価は各モデルに同じ会話範囲を渡し、相互の意見を隠す。入力上限に収まるよう重複値を参照化・会話を分割するが、文章を黙って切り捨てない。

## 中断・修正版

```powershell
npm run mission -- expand-retry --input <manifest.json> --play <playId> --live --max-cost-usd <追加上限>
npm run mission -- expand-pilot --input <修正版manifest.json> --live --max-cost-usd <追加上限>
npm run mission -- expand-render --input <draft.json>
```

途中のプレイを成功扱いで再開せず、新しいattemptとして最初から再試行する。3プレイ完了後に評価だけ中断した場合はexpand-continueで不足評価を再実行してから残り6組へ進む。9プレイ完了後の評価中断も同じコマンドで評価だけを再試行し、完了済みプレイは再実行しない。中断した評価と追加予算は履歴として保持する。確認済みの設定不備だけを最大2回まで修正し、新しいrevisionで止める。新版の3プレイは明示的に実行する。実装不具合・原因不明・面白さの低点を理由に、自動でゲームコードや設定を変更しない。

## 比較と採用

`report.html` は元全文・拡充全文・ギミックと解法・会話・評価・費用を含むプランナー向け資料。公開Web配下には配置しない。保存物だけで再描画できる。

```powershell
npm run mission -- expand-adopt --input <manifest.json> --revision <番号>
```

liveの9プレイと必要評価が完了し、確認済み不備がなく、指定版と証跡が一致した場合だけ採用できる。全プレイヤーのクリアや面白さ平均点は条件ではない。`scenarios/expanded/<candidate>-r<revision>.json` と採用記録を新規作成し、既存ファイルは上書きしない。起動設定で固定シナリオを選ぶ操作とAWS反映は自動では行わない。

終了コード: `0` は指定段階の完了（3件での停止を含む）、`1` は成立性不備、`2` は設定・通信・予算・未完了。段階と実施範囲を合わせて確認する。

## 別途必要な確認

`specs/improve-game-core/manual-playtest.md` にPC Chrome・スマホの手順を記載。実音声、実機写真、時間設定、人間の面白さはテキスト模擬では保証しない。実行実績は `specs/improve-game-core/verification.md` に記録する。

評価入力枠は原文と実拡張案の容量に合わせて128 KiB、生成・各プレイは64 KiB。評価は引き続き全ターンを分割して扱い、入力バイト数に基づく費用予約と全体上限を適用する。

## 拡充候補を共有して遊ぶ

今回の候補はリポジトリに同梱。手順は [拡充版の試遊](expanded-playtest.md) を参照。起動コマンドは npm run play:expanded。
