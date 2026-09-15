# T03 / Issue #60 — 調査会話・積極性・無害補完

状態: 担当実装・自動検証完了（2026-09-15）。spec / plan S3 / data-model / Issue #60を確認。T01とT02の共通境界を利用する。

## 実行サブタスク

- [x] 積極性の既定値と補完状態、知識候補の情報層・対象を追加
- [x] 相談確定を分類→候補選択→公開文脈回答の有限経路へ変更。仮の知識状態を用い、ゲーム/知識/会話version・epochを再検証して一括確定
- [x] 広い質問・直接質問・明示ヒントを分離し、概要会話の必須化を避ける
- [x] 承認済みallowlistからのみ補完値を確定、30件・同一プレイ固定・別プレイ分離
- [x] プロンプトを外出ししてプレイ内固定、Live・結果通知・初期概要に設定を反映
- [x] 新規境界テストと既存回帰・型検査を実行し結果記録

## 方針

旧profileなしの知識も利用可。既存の明示段階ヒントは維持し、候補のhint判定はmetadataまたは宣言済みobstacle.hintsとの対応から決める。任意IDの正規表現だけでは決めない。選択器に渡すのはcue・対象・情報層のみ。秘密本文は許可された候補を選択後の回答段階だけへ渡す。補完は宣言済みallowedValuesからのみ選ぶ。

マルチレビュー・実API・実機・commit/pushは行わない。計画の前提矛盾、DoD矛盾、大幅な規模超過を発見した場合は記録して親へ報告する。

## 中間チェックポイント

型検査成功。有限経路への意図的な変更に合わせて既存の知識開示fixtureを更新し、story-runtimeは16/16成功。元の18構成×日本語/英語のLive8000文字上限も維持。新規の直接質問・広い質問・補完・古いversion/epochのテストを追加中。

## 実装結果

- core-configのcompanionInitiativeはobservations/hypotheses/suggestions。旧設定の省略時はobservations。
- core_intentは1回のみ。相談をknowledge_selection→investigation_replyへ進め、行動の全分類を再実行しない。profileなしで開示のない相談は従来の短い回答を維持する。
- KnowledgeStore.fork/commitFromで開示・補完・推測を仮状態に保持し、回答後に知識versionと共通ハーネスのゲーム/会話/世代/epochを確認して一括確定。通信失敗・古い状態・abortでは開示も会話課金も確定しない。
- 候補はtargetId/layer/requestCueだけ。概要でdetailを選んだ誤出力は除外。具体質問はdetailへ直接到達。段階ヒントは明示依頼だけ。metadataや宣言済みobstacle.hintsから種別を決め、元ヒントをmetadataでdetailへ格下げできない。
- 補完は承認済みambienceSlotsのallowedValuesから選択する。未定義slot/valueは拒否、30件まで、同一プレイ内で上書き不可。正式知識・推測とは別領域。source scenarioと別プレイへ書き戻さない。
- config/prompts/investigationの5ファイルをプレイ生成時に読み、fork・再接続でも固定したbundleを利用。Live・結果発話へ積極性と固定補完を渡す。プロンプトによる発話制御の実音声精度は別検証。
- storyOpeningBriefingは親T04のbuildPublicSceneによる初期概要を使用し、調査から考えて写真へ進める案内を日本語/英語で追加。
- provider wire schemaは全フィールド必須。互換fixture用defaultsとはharnessResponseのwireSchema引数で分離。

## 検証結果

- npx tsc --noEmit: 成功。
- 新規improve-game-core-knowledge: 16/16成功（有限経路、直接質問、広い調査、秘密非混入、任意IDのヒント、否定ヒント、3積極性、補完の固定/分離/30件、game/knowledge/context/epoch/abort、回答障害、未定義属性、初期概要）。
- 新規14件時点で関連6ファイルの91/91成功。最後のヒント格下げガードと2件追加後、knowledge/story関連43/43成功。
- 既存18構成×日本語/英語の導入がLive8000文字上限を満たすことをstory-runtimeで確認。
- 親からHTTPの旧導入末尾期待更新後6/6成功、build（check含む）成功の報告あり。全体結果の最終報告は親で管理する。
- 課金・実API・GPT-Liveの実音声・実機撮影・面白さの確認は未実施。マルチレビュー/commit/push/AWS反映なし。

## 後続向け

- KnowledgeStore.snapshot().ambienceにslotId/value/createdAtVersion/sourceRequestIdを記録。補完履歴はS5/S8で評価記録・レポートへ写せる。
- GameHarness.publicView().ambienceは公開targetId/attribute/valueだけ。PlayerへKnowledgeStore/source/prompts全体は渡さない。
- 計測transportはknowledge_selection/investigation_replyというschema名で追加通信を識別できる。