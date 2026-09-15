# 実装調査 — improve-game-core

2026-09-15。ローカルコードの読み取りのみ。外部API仕様・料金の新規確認、コード実行テストは未実施。

| 調査点 | 確認した根拠 | Decision / Rationale / Alternatives |
| --- | --- | --- |
| 完成構成の固定 | packages/shared/story-catalog.ts compileStoryScenario は純粋関数。apps/server/scenario-catalog.ts current はV3を抽選しV2を直接使用 | 生成前に構成を固定しV2として採用。プレイ時断片再抽選は整合検証と食い違うため採らない |
| 知識開示 | companion-knowledge.ts は前提条件、候補cueのみの投影、knowledge version検証を持つ | 既存を拡張。新しい知識DBやLLMだけによる開示は不要 |
| 調査応答 | core-intent-ai.ts はconsult分類後に開示選択し再分類する。既存ヒントをID正規表現で除外 | 情報層/ヒント種別を明示し有限の相談経路へ整理。本文全投入は秘密漏れのため採らない |
| 共通ゲームループ | hosted-runtime.ts はGameSession、知識、分類、課金、発話を組み合わせる。game-ai.ts は認識と判定の接口を持つ | 音声アダプターからゲーム進行を抽出。偽Liveイベントを大量生成して模擬する方式や別進行モデルを採らない |
| 利用制限 | hosted-runtime.ts reserveConversation/finishConversation、creditsRemaining、ScenarioCatalog difficultyPresetsが存在 | 仕様外の新規クレジット実装はしないが、既存消費を模擬でも維持。旧生成difficultyだけをゲーム条件としない |
| 時計 | GameClockのnowは注入可能。paused中もwaitingRemainingMsが減る | 評価のゲーム時計を固定しAPI時計を別管理。判定時間が長いだけの未クリアを避ける |
| 画像 | image-service.ts scenePrompt はsetting.location、openingClue、sceneRulesのvisualDescriptionを使う | 拡充版に公開画像投影を設け、全状態の解法・秘密が入らない検証。画像を調査ごとに増やさない |
| 旧検証 | tools/auto-mission/simulate.ts simulateWitness は生成済み解法の状態シミュレーション | 固定条件検査の考え方を再利用するが、盲検プレイヤーが手がかりへ辿る検証の代用にはしない |
| 予算 | tools/auto-mission/budget.ts は出力予約、call数、deadline。provider.ts usageはinput/output中心 | 全役割共通台帳と料金予約、推論/cacheを拡張。17calls/600秒を9プレイ全体に流用しない |
| 保存 | store.ts はschema検証→一時ファイル→rename、旧run16MiB | 原子保存を継承しplay別ファイルに分離。旧runスキーマを破壊しない |
| 日用品 | 旧default.jsonの8品に、元構成のマジックハンド・ドライバーがない | 共通カタログへ追加し、正解ラベルは除外。カタログ不足をストーリー不備としない |

未解決事項の扱い: 初回構成・上限・採用操作はplan.mdに案を固定した。料金はlive前に公式確認する。ハーネス抽出の実装量と音声回帰は実装時テストで検証する。特定のライブラリ導入や新しい外部サービスは不要。MVP、秘密分離、既存認証維持、課金なし自動検証＋実機確認はこれまでの合意を継承する。
