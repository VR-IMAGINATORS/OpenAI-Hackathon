# 自動ミッション生成: 技術調査

調査日: 2026-09-14。公式ドキュメントとローカルコードの読み取りのみ。実APIの権限・課金・速度・精度は未検証。

## モデルとAPI

| 役割の候補       | API ID        | 標準テキスト単価（入力/出力、100万tokenあたりUSD） |
| ---------------- | ------------- | -------------------------------------------------- |
| 最上位生成・検証 | gpt-6-astra   | 10 / 50                                            |
| 物理評価         | gpt-5.6-sol   | 4 / 20                                             |
| 因果・説明評価   | gpt-5.6-terra | 2 / 12                                             |
| 道具・回数評価   | gpt-5.6-luna  | 0.20 / 1.20                                        |

出典: [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)、[Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)、[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)。2026-09-14に本文を取得して確認。キャッシュ等の条件は各公式ページを参照。上表は費用の確約や1実行の実測値ではない。

Decision: コントラクト生成・ストーリー生成/修正にgpt-6-astraを採用。検証役もAstraを別リクエスト・別の指示で実行。3視点の評価をSol/Terra/Lunaへ割り当てる。
Rationale: ユーザーの最上位生成要件を満たし、評価側は独立性と費用の両方を考慮する。Luna担当の数量検査には決定的検査も併用する。
Alternatives: 全役割Astraは費用増、下位モデルによる生成は要件違反。異なるモデルによる見逃し低減は仮説であり、既知ケースで確認する。

AstraはResponses APIとStructured Outputsに対応。reasoning.effortはhighを初期値とする設計案。実行するアカウントでの利用可否は未確認。アクセス不可ならエラーで終了し、安いモデルへ黙って置換しない。

## 構造化出力

Decision: Responses APIにstore:false、text.formatのjson_schema/strict:trueを指定する。独立評価は前のresponse IDや共有conversationを使わず、新規リクエストにする。
Rationale: 状態と評価の版をコードで照合できる。出力形式の一致と意味的な成立性は別に検査する。
Alternatives: 自由文のJSON抽出やモデルだけによる合否集計は不正形式・評価欠落を見逃す。

[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)は全fieldをrequiredとする制約、refusalが通常の期待schemaと異なることを記載している。provider schemaはトップレベルobject、additionalProperties:false、必要なnullable fieldを明示。実装時にZod由来のschemaを点検する。refusal、incomplete、無効JSON、欠けた必須評価を合格に変換しない。

## 既存実装との境界

- Node/TypeScript、tsx、Zod、dotenvは既存依存。CLIはこれを使い、WebサーバーやAgents SDKの追加は不要。
- packages/server/openai.tsの通信には30秒の期限、ai-config.tsには1000出力token等のゲーム向け上限がある。長いシナリオ生成のために本編設定を緩めず、独立したResponses adapterを新設する。
- packages/shared/scenario.tsとscenarios/mobile-playtest.jsonの現行ルールはmaxPhotoSends/maxPhotosPerSend/totalTimeSeconds。maxActionsは現行本編にない。プロトタイプ設定では独立したnullable上限として扱い、例ではnull（集計のみ）、上限付きfixtureで回数不足を検査する。
- eval-workflowから、決定的検査優先、必須judge欠落は不合格、根拠付きの指摘と棄却を参考にする。ソースコード用judge runner/合議scriptやプラグイン実行環境には依存しない。
- runs/は既存Git ignore対象。生成結果はruns/auto-mission/<runId>/へ保存する。既存ゲームのscenario JSONを生成先にしない。

## 未検証事項と扱い

APIアカウントのモデル利用可否、Astraの実応答時間、Lunaによる見逃し率は実装後の実API試験で測る。モデルIDの存在とアカウント権限を混同しない。時間制限は手順の見積時間を検査するが、プレイヤーの思考時間・撮影時間を実測した保証にはならない。
