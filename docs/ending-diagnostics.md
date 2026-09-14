# タグ・結末文の失敗を調査する

解除0個はエラー条件ではない。全試行が失敗しても結末文を生成でき、根拠のある試行にはタグを付けられる。0行動や適合するタグがなければtag=null。画面の「タグ・結末文を作る段階で失敗」は段階の説明であり、解除数が原因だとは判断できない。

## 今回のプレイで確認する情報

1. リザルトの「不具合報告用の情報」を開き、エラーコードとPlay IDを控える。環境（ローカル／公開URL）、発生時刻、解除数も添える。旧版でPlay IDが出ない場合は、ブラウザのNetworkにある`GET /api/play/ending?playId=...`のplayIdを確認する。
2. サーバーを起動したターミナル、または公開環境のサーバーログで`ending_failed_story`と同じ`correlationId`を検索する。Play IDとcorrelationIdは同じ値。再起動でプレイ情報が失われるため、先に情報を控える。
3. 更新後はHTTP応答の`storyStatus`・`storyErrorCode`が文章、`status`・`errorCode`が動画の状態。文章失敗でも動画生成を継続し、完成後も文章側コードは残る。文章と動画の両方が失敗した場合は両コードを調べる。

| コード末尾（通常はENDING_STORY_に続く） | 分かること／次の確認 |
| --- | --- |
| INVALID_TAG_EVIDENCE | タグの根拠が機械的な条件を満たさない。例：失敗後の解除がないのに「学習」タグを選択。解除0個自体は禁止していない。 |
| INVALID_RESPONSE | JSON形式・必須項目・文字数・タグIDなどの検証に失敗。更新後のログのvalidationFieldsでstory/tagなど対象項目を確認。 |
| INVALID_SOURCES / INVALID_EVIDENCE | 存在しない出典ID、または原文と一致しない証拠。 |
| EVIDENCE_TOO_LARGE | 証拠が抽出処理の入力上限を超えた。 |
| RESPONSE_INCOMPLETE | AI応答が未完了。これだけではトークン上限などの詳細理由を断定できない。 |
| RESPONSE_REFUSED | AI応答が拒否された。 |
| HTTP_401 / HTTP_403 / HTTP_429 | 認証・権限・利用上限の応答。 |
| TIMEOUT | 文章フェーズまたはAI呼び出しの期限切れ。 |
| FAILED | その他の失敗。コードだけでは通信障害などの詳細を確定できない。 |
| ENDING_AI_BUDGET_EXHAUSTED（独立コード） | 共通AI予算・利用制限。文章と動画の障害を分離しても、共通予算は超過しない。 |

更新後のサーバーログ例（架空）：

```json
{"event":"ending_failed_story","correlationId":"example-play-id","errorCode":"ENDING_STORY_INVALID_RESPONSE","clearedCount":0,"actionCount":3,"failedActionCount":3,"validationFields":"tag"}
```

`validationFields`はスキーマの項目名だけで、実際の応答値・会話・写真・認証情報は記録しない。既存プレイのログに後から詳細を追加することはできないため、旧版のコードだけで不明な場合は更新後の新しいプレイで確認する。再読込は結果取得のみで、失敗した生成を再送しない。

## 動画への影響

文章・タグ・証拠抽出の失敗時は、文章を捏造せず、確定済みの結末・行動・状態から映像指示を作る。文章側は最大60秒。成功時は従来どおり文章を先に公開する。動画の元画像不足、映像API失敗、全体期限切れ、利用上限、キャンセルは引き続き動画を止める独立した理由となる。
