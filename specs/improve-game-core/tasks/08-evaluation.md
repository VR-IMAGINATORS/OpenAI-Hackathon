# T08 独立評価・検証・修正

Issue: #65 / Status: implemented (CLI統合はT09/T10で確認)

- [x] Sol/Luna/Terraへ同一候補・同一の決定的会話分割を入力し、peerを混入しない
- [x] 各評価役自身の分割結果だけを統合し、分割ごとの根拠・評価・coverageを保存
- [x] Astraが指摘と未クリアplayを設定不備/実装不具合/見落とし/不明に分類し反証を保存
- [x] JSON pointer/turn ID実在、必要3モデル、全turn coverage、指摘の検証漏れを再検証
- [x] 面白さ4観点1–5|null、根拠と提案を保存。低点や全勝を修正・採用条件にしない
- [x] 確認済み設定不備のみ最大2修正。新run/revisionを保存しawaiting_pilotで明示停止
- [x] API失敗、証拠不正、評価欠落、サイズ超過をincompleteにする

## 検証

`node --import tsx --test tests/improve-game-core-evaluation.test.ts`: 8件成功。
実資料の元設定＋mock候補を使い、同一入力・欠落/不正引用・役割の失敗・未クリア見落とし・複数分割の全turn coverage・実ファイル上の2回修正と停止を検証。実API通信は未実施。mockの面白さは未評価null。

## 64 KiB境界

rawCatalogText全体や元文章の重複を通信しない。compiledOriginalと元referenceSolutionsの参照パスを維持して投影し、候補は全文を渡す。構造化出力の繰返しschemaはJSON Schema参照で重複を除く。元設定やpublicStateBefore/Afterの同一長文・objectは可逆sharedValues/$refで一度だけ渡し、復元deepEqualを検証した。1playの会話をターン境界で決定的に分割し、各モデルは同一分割を見る。分割結果に見つかった指摘は統合時に消さない。
Astraは各指摘とその引用play全文を決定的な窓に分けて検証し、Astra自身の部分検証のみを統合する。各窓の結果とcoverageも保存・検証する。候補＋1turn、統合結果、引用playの1turn、修正入力が制限を超える場合は内容を切り捨てずincompleteで停止する。API上限は変更していない。大きな生成候補での実API完走を保証しない。


## 実模擬記録での統合確認

保存済みの実GameHarness模擬25turn×3を再利用し評価のみmock再実行。レビュー役は各15窓＋自身の統合、Astraは未クリアplayごと5窓＋統合。評価66 calls、最大入力65,442 bytes、completeかつ全turn coverageと根拠再検証成功。元保存物は変更しない。CLI全9件・実APIは別工程。

