# データ契約

既存の所有者限定 `GET /api/play/ending?playId=...` を拡張。

- EndingView.storyStatus: queued | generating | ready | failed | disabled | not_applicable。
- EndingStory: 既存title/text/evaluationを保持し、tagId（固定40IDまたはnull）とtagCatalogVersionを追加。タグ情報は既存結果との互換のためoptional。主表示はtext、title/evaluationは現行生成契約との互換のため保持する。
- AI writer出力: tagはnull、またはid / evidenceActionIds（1〜40件、重複なし）/ reason。storyは最大240文字。タグ根拠はサーバー内で検証し公開結果には含めない。
- 同プレイの結果は有限メモリに一度保存。状態は文章と動画それぞれ進行し、文章readyは後続メディア失敗でも維持。
- 内部EndingNarrativeは文章・タグ・根拠と抽出済み証拠を保持。映像用endingDesignSchemaは映像指示と根拠IDのみを返し、文章・タグを上書きできない。EndingCallKindはstory（最大1回）とdirection（最大1回）を別に計数し、どちらも全体Responses予算を消費する。

新規APIはなく、厳密なTypeScript契約はpackages/shared/ending.tsを参照。
