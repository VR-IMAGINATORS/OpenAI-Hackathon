# エンディングタグ実装計画

Status: approved direction (2026-09-14)

既存のproposal.mdで提示した「既存生成を拡張・画像制作前保存・動画なしでも文章生成」をユーザーが進行了承。追加指示で40タグ・自動先行表示を確定。通常の実装判断は依頼範囲内で進める。ハッカソン中のマルチレビュー禁止に従い、マルチレビューは実施しない。

## 実装

1. `packages/shared/ending-tags.ts` に日英40タグのID・表示名・判定条件を定義。`apps/local-server/ending-tags.ts` にAI出力schemaと根拠検証を置く（T01,T06）。
2. `apps/local-server/ending-ai.ts` のcreateEndingTextで全行動から文章・タグを先に生成。動画ありなら、保存済みのEndingNarrativeと抽出済み証拠をcreateEndingDesignへ渡し、映像用のschemaだけで別途directionを生成する。映像が文章・タグを再生成しない（T02,T06）。
3. `packages/shared/ending.ts` に文章状態と任意のタグ情報を追加。`apps/server/ending-jobs.ts` は検証済み文章を即時保存。動画予約と文章実行を分け、動画disabled/素材なし/予算不足でも文章を生成。期限・重複防止・キャンセルを維持（T03〜T05,T07）。
4. `apps/web/src/EndingVideo.tsx` はタグ・短文を解除数の直後に自動表示。文章の準備状態でもpollを継続し、再生終了待ちをなくす。`styles.css` にタグ表示を追加（T03,T07）。
5. 関連仕様を同期し、サーバーテストとブラウザsmoke、check/test/buildで確認。実APIは呼ばない。

## 運用と境界

既存の認証付きending APIを拡張し、新規エンドポイントは不要。providerの指示・タグ理由は公開せず、固定タグID・版・短文だけを渡す。ブラウザからタグや確定結果を指定しない。既存メモリ保持を継承。文章のみは最長120秒（既存設定が短ければその期限）とし、動画有効時の最大8分とは分ける。

全プレイの文章フェーズと動画フェーズの実行枠を別々にENDING_CONCURRENT以下とする（既定それぞれ2）。文章生成は最大60秒で終了し、成功なら保存、失敗ならstoryErrorCodeを保持して動画フェーズへ送る。文章成功を動画開始の条件にしない。動画有効のプレイでも他の動画の処理中・受理不明を待たず文章を生成する。API実行自体は既存の全体Responses同時数・予算を共有し、待機キューは合計10件まで。

文章の出力検証失敗・未完了応答は、抽出済み証拠と固定の修正指示を使って1回だけ再生成する（初回2048、修正4096出力トークン上限）。失敗した本文は次の入力にもログにも含めない。最終失敗時はEndingNarrativeなしでdirectionを呼び、確定状態・行動だけを渡す。証拠の再抽出・ダミー文章の公開は行わない。EndingDesign/PreparedEndingから文章フィールドの依存を除く（T08〜T10）。

各応答schemaのIDをプレイ・フェーズの候補enumにする。文章/動画のusedEvidenceIdsは提示済み証拠、タグ根拠は全確定行動、動画usedActionIdsは直近行動、抽出sourceIdは対象チャンクに限定。ログには固定コード・検証項目名・件数だけを残す。修正開始はending_failed_story_retry、最終失敗はending_failed_story。不正出典件数と行動ID・eventId混同件数を記録し、実ID・本文は記録しない。

## カバレッジ確認

T01,T06→1,2、T02→2、T03→3,4、T04,T05→3、T07→3,4。通常動画経路はstoryとdirectionの2回に分割する。永続図鑑、共有投稿は含まない。型と既存APIの変更点はdata-model.md参照。

ユーザーの失敗報告を受け、e7ab1ccの同時生成方式を修正した。映像API失敗・脚本不正・不完全応答・動画待機枠・待機中期限切れでも文章readyを維持する回帰テストを追加する。
