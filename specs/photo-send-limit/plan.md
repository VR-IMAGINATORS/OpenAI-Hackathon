# 実装計画

Status: authorized by implementation request (2026-09-14)

SpecWorkflowのspec→plan→tasksで記録。ユーザーが方式変更と実装を承認済み。プロジェクト指示に従いマルチレビューは実行しない。

1. sharedの難易度とScenario.rulesをmaxPhotoSends/maxPhotosPerSendに更新。PublicGameStateへphotoSendsRemaining/actionsUsedを公開。障害数以上の行動数を要求する旧検証を除く（R1/R7）。
2. GameSessionは受信完了時にphotoSendsUsedを更新し、0回の新規送信を拒否。行動予約と結果確定の回数終了を除く。残り時間・手持ち状態を保持。GameRuntimeのrequestIdキャッシュを維持（R2〜R5）。
3. 行動が増えてもメディア要求を無制限にしない。既定の画像生成予算を送信数から独立させる。API利用上限は現行のまま（R5）。
4. JoinScreen/HUD/撮影ボタン/AI公開状態と指示を更新。写真プレビューの消去は行動確定数で判断し、送信数と混同しない（R6/R7）。
5. テストの旧行動上限の期待値を新仕様に更新。HELLで2送信→3障害目を手持ちで突破、0回後の送信拒否・再送・復帰・無効写真・時間切れ・消費済み拒否を重点検証。check/test/buildとブラウザsmoke（R1〜R7）。

JSONスキーマ/APIの変更は同じアプリ配信で揃える。旧maxActions設定は黙って別意味へ解釈せず検証で拒否し、docs/planner-guideへ移行先を記載する。
