# 技術調査 — game-core

2026-09-13。公式資料と既存コードを確認。Live担当・画像担当の2サブエージェントによる独立調査を統合。実APIの呼び出し、モデル精度/速度/課金、Micro負荷の実測は未実施。

## 調査項目と処置

|不明点|Decision|Rationale|Alternatives considered|
|---|---|---|---|
|Liveの関数呼び出し|既存client delegationを継続し、Responses strict JSONで意図を分類|ゲーム状態と画像検査を自前で管理できる|Responses delegationは文脈管理を軽減できるが現行を置換。P0失敗時の再設計候補|
|発話終了と委譲|委譲と履歴を組み合わせ、無音タイマーで実行しない|公式transcriptには確定turn終了がない|Realtime VADの設定をLiveへ流用しない|
|後着と訂正|HTTP即ack、独立分類worker、contextVersion/evidenceで照合|現状eventQueue→await recognizeで後続文字を塞ぐ|WebSocket基盤新設は不要。既存HTTPとpollを利用|
|画像生成|Image API gpt-image-2.5-flare、1024角low JPEG、n=1|初版の費用/待ち時間を抑える候補|sunburst/前画像編集は精度比較後。初版では独立snapshot生成|
|進捗|%なし受信animation|partial_imagesは途中画像であって完了率ではない。検査前に公開しない|偽の%を出さない。streamの複雑さを初版に入れない|
|検査|Responses gpt-5.6-luna、画像+制約、strict JSON|可変の関係/禁止事項を設定で扱いやすい|encoder-only/CLIPはラベル/閾値・評価と実行基盤が別途必要。精度の優劣は未実測|
|終了後の画像|ResultStoreとMediaPermitをゲーム/Liveから分離|既存retireが全AIを拒否するため専用寿命が必要|Liveを長く繋ぐ方法は使わない。DB/S3導入も見送り|
|設定反映|新規play時にJSON検証→immutable snapshot|プランナー調整と進行中の一貫性を両立|既存playへのhot updateは不採用。AWSはデプロイで反映|
|診断|ローカル開発限定の短命trace|本番の本文ログ禁止を維持|永続分析、公開管理画面は対象外|

## 公式契約の確認

client delegationにはtask本文/関数引数はなく、metadataとoffset_msが来る。両話者のtranscriptを保持してアプリが文脈を組む。transcript到着間隔は発話の無音区間ではない。append受付は音声再生完了ではなく、割り込みもbackendの自動取消ではない。

- https://developers.openai.com/api/docs/guides/live-delegation
- https://developers.openai.com/api/docs/guides/live-conversations
- https://developers.openai.com/api/docs/guides/live-prompting

画像生成はImage APIのgenerationsを利用する。出力はbase64から検証してJPEGへ正規化する。モデル利用に組織確認等が必要な場合があり、実プロジェクトで利用可能とは未確認。画像モデルの公式Tier1は5 IPM、Tier2は20 IPM。runtimeのrateは実契約に合わせる。

- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/docs/models/gpt-image-2.5-flare
- https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst
- https://developers.openai.com/api/docs/models/gpt-5.6-luna
- https://github.com/openai/CLIP

## 費用・待機の見積方法

公式Standard価格の調査値は、Flare画像出力30 USD/100万token、テキスト入力5 USD/100万token、画像入力8 USD/100万token。Luna入力0.20 USD/100万token、出力1.20 USD/100万token。価格は実装時にも公式価格ページで再確認する。

1画像の固定単価を旧モデルから流用しない。初回評価で画像usage+検査usageを測り、1playの生成/再試行数を掛ける。maxActions=4なら最大6job、12生成、12検査を予算として予約。通常の4行動終了は開始1+結果4=5job。5人の保守上限は30job/60生成/60検査。5 IPMでは60生成に少なくとも約12分相当のrate枠を要し、全画像が150秒以内に届く保証はできない。

初期案は低費用設定・150秒job・2並行・5 IPM・boot生成100/検査100。これは実測された適正値ではなく調整の出発点。低いtierでは失敗枠が増える見込みを判断ブリーフへ出す。予算はメモリの回数上限であり金額上限ではない。API利用権限や高tierへの変更を自動で行わない。

- https://developers.openai.com/api/docs/pricing

## NEEDS CLARIFICATIONの解消状況

API構成/進捗/検査方式/設定方式は上記の採用案を計画へ反映。具体値はplan §4/5とともに2026-09-13に承認済み。未実測のモデル品質・委譲成立性・実IPM・CPU/メモリはP0/P4/P7の検証ゲートで扱い、確定事実に置き換えない。未解決技術を隠して実装完了扱いするものではない。
