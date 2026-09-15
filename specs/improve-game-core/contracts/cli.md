# CLI・内部コントラクト（設計案）

Status: approved (2026-09-15)

新規公開HTTP/GraphQLはないためOpenAPIは作成しない。既存Webは既存認証・APIを使用する。以下は実装予定であり、現在まだ実行できない。

```text
npm run mission -- expand --config config/auto-mission/expand-default.json --mock
npm run mission -- expand --config config/auto-mission/expand-default.json --live --max-cost-usd <上限>
npm run mission -- expand-continue --input runs/mission-expansion/<run>/manifest.json --live --max-cost-usd <追加上限>
npm run mission -- expand-retry --input <manifest> --play <playId> --live --max-cost-usd <追加上限>
npm run mission -- expand-pilot --input <新版manifest> --live --max-cost-usd <上限>
npm run mission -- expand-render --input <manifest>
npm run mission -- expand-adopt --input <manifest> --revision <番号>
```

- expand: 明示設定のsourcePath/candidateIndexで固定、生成・静的評価・最大3プレイ・診断と費用レポートで停止。設定不備の修正版を生成した場合でも新版プレイは自動開始しない。
- expand-continue: 同じ候補と条件の完了済み初回3件のみ受理。残り6件と最終評価を実行。料金上限は追加実行の上限で、累積も表示。未完了があればretryが先。
- expand-retry: 未完了playを別attemptとして再実行。過去の課金を差し引いたことにしない。候補を変更しない。
- expand-pilot: 修正版を3件から検証する。旧版結果を流用しない。
- expand-render: 保存物だけでHTML再生成、APIもキーも不要。
- expand-adopt: ready_for_adoptionのlive評価と指定revision/digestを検証。新規固定シナリオと採用記録を排他的作成。原資料・既存設定・AWSを変更しない。mock成果はテスト一時領域のみで扱い、live採用不可。
- 既存generate/evaluate/benchmark/renderは変更しない。新旧のmanifestをschemaVersionで区別する。
- 未知引数、重複、live/mock同時指定、上限欠如、不正な番号、digest不一致は通信前に拒否。パスはCLIで指定した既存入力のみ。生成文が命令やパスを指定しても無視する。
- 終了コード: 0=指定段階完了（pilot_reportedも含む。全評価成功とは別）、1=成立性不備、2=設定/通信/予算/未完了。人間向け表示に段階と次操作を必ず示す。

## 共通進行の入力境界

TextPlayAdapterはplayer outputを検証してGameHarness.handleRequest/handleRecognizedPhotoへ送る。会話のevidenceSeqとcontextVersionはアダプターが生成するサーバー所有値で、モデルに自由指定させない。モデルはask{text}またはsend_items{catalogIds,usage|null}のみ返す。catalogIdsは最大2、存在・重複・送信上限を検証。usageなしでも本編と同じ自律判断を行う。危険確認に対する次の返答も通常のaskとして共通経路へ通す。

結果はpublicReply/committedPublicEvents/publicStateをプレイヤーへ、診断を評価記録へ分離する。GameRuntimeの音声側はLiveOutboxと通知スケジューラーを維持し、同じ確定結果から発話・画像を配送する。


## 生成前の保存（T06実装補足）

候補が確定する前は同じrunディレクトリのdraft.jsonを使用する。kind=mission-expansion-draft、candidateDigest=nullであり、plays・評価済み状態・採用を持てない。通信予約をcall台帳へ保存した後に生成を開始し、候補が固定されたときだけcandidate.jsonと通常manifest.jsonを一度作る。旧manifestの形式は変えない。

expand-renderのinputにはmanifest.jsonに加えてdraft.jsonを指定できる。候補なし・生成失敗・実行中の通信をそのまま表示し、読み取りで状態を成功へ変えない。生成中断の復旧は未知通信をincompleteにし予約額を保持する。途中生成の自動再試行はしない。

### 評価中断からの明示再開

同一候補・同一条件の初回3件が完了し、未完了playがない場合、expand-continueは欠けた評価またはAPI失敗でincompleteの評価を再実行してから残り6件へ進む。9件完了後の評価失敗は評価だけ再実行し、完了playは再実行しない。設定不備が確認された場合は既存の修正候補作成・明示pilot停止に従う。旧評価はevaluation-history-<UUID>.jsonに保持し、通信台帳は削除しない。追加上限と開始/完了状態はexecutions.jsonへ独立記録する。
