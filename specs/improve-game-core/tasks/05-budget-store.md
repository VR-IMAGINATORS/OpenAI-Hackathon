# T05 評価の予算・使用量・版別保存

Issue: #62 / Status: completed / 2026-09-15

- [x] S6・契約・既存通信を確認
- [x] 公式モデル料金を確認（2026-09-15）
- [x] 共通通信計測・事前予約
- [x] 版固定・原子的保存・再開
- [x] 課金なしの境界/回帰検証

## 実装

- ExpansionBudgetが全役割共通の費用/呼出し数/出力token/時間を予約。play/staticのscope上限を同時に適用。入力はUTF-8バイト数＋framing余裕で保守的予約する。
- MeasuredResponsesClientは本編AIResponsesClientへ、measuredFetchは既存ResponsesProviderのtransportへ注入可能。旧provider/RunRecordを変更しない。
- 未知usageは予約を保持。推論は出力内数、cacheは入力内数。cache-write内訳が不明な非cache入力は1.25倍で保守的概算する。
- API aliasとreturned snapshotは推測で同価格にしない。公式確認済み対応だけresponseAliasesで明示許可でき、既定値は空。
- 評価は64 KiB以内のtext-only/標準tier。画像・tools・previous_response_id等の別料金/不透明入力は通信前に拒否。実画像認識はT07模擬adapter対象外。
- 予約の保存が成功してから通信。raw prompt/認証headerはcall台帳へ保存しない。
- schemaVersion=1/kind=mission-expansionで旧形式と区別。conditionsに元/候補/版/コードdirty差分/config/prompt/道具一覧/model/rules/積極性digestを固定。
- playは16 MiB、runは128 MiB。immutable play snapshotを書いた後manifestを原子的差替え。旧checkpoint・孤立tempもrun容量に算入する。
- 排他writerとstale manifest拒否。再開時のrunning call/playはincompleteにし、予約と過去turnを保持。完了playだけ再利用し、再試行は別attempt。
- readOnlyはrender用の無通信/無変更読込。saveEvaluation/saveReportで評価JSONとHTMLを同じ上限内に保存。

## 検証

新規budget/storeテスト14件と旧provider回帰を実行。型・標準設定チェックも実施。最終件数は親へ報告。

実API・音声・マルチレビュー・commit/pushは未実施。費用は上限内に予約するための保守的概算で、請求額そのものではない。未知料金モデルのlive開始は不可。

## 料金出典（取得日 2026-09-15）

- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra): 入力10/cache1/出力50 USD per 1M tokens
- [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol): 入力4/cache0.4/出力20
- [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra): 入力2/cache0.2/出力12
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna): 入力0.2/cache0.02/出力1.2

各ページのcache write 1.25倍を反映。272K超入力の割増は64 KiB要求上限のため対象外。次回価格更新は別の価格snapshotとして記録する。
