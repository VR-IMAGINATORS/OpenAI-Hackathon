# 実装計画

Status: authorized by implementation request (2026-09-14)

ユーザーが現在のブランチでの実装とコミットを依頼済み。ハッカソン中のマルチレビュー禁止を優先し、追加承認待ち・マルチレビュー・外部issue投稿は行わずローカルに記録する。

1. `packages/shared/difficulty.ts` に3値のスキーマ・表示名・上限を定義（R2/R3）。
2. `ScenarioCatalog.current(locale, difficulty?)` で新プレイのシナリオを検証後、難易度を適用し再検証。digest に選択を含めdeep freeze。変更後の時計・画像生成予算も確認（R3/R6）。
3. `/api/plays`、PlayRegistry、AuthSession に任意のdifficultyを通し、同じrequestIdで難易度が異なる再送は409。PublicGameStateから復帰時の選択を復元（R6）。
4. JoinScreenに3つの難易度別submitボタン、空欄alert、認証から導入への遷移を実装。押されたボタンのvalueで難易度を固定し、別の開始ボタンは置かない。styles.cssはjoin専用で縮小しタップ領域を維持（R1/R2/R4/R5、ユーザーの追加説明を反映）。
5. 課金なしHTTPテストで3種・不正入力・再送・復帰、ゲームテストで時間切れと最終行動の脱出を確認。ブラウザsmokeで表示領域・空欄・日英・導入遷移を確認。check/test/build後コミット（R7）。

要件R1〜R7を上記に対応確認。新たな認証情報や外部依存は追加しない。
