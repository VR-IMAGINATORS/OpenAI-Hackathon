# 取り込みデータ

`StoryCatalog`（version 3）は共通rules・共通world/aiName/phases、6つのscene（id/name/description/anchor/mystery/openingClue/sequences）、10個のgimmick（id/name/observation/mechanism/hints等）を所有する。全表示文は日英で定義する。実装の厳密なschemaは `packages/shared/story-catalog.ts`。

`compileStoryScenario(catalog, candidateIndex)` は選出されたscene+sequenceを既存ScenarioV2へ変換する。元のgimmick IDを保ち、各障害へ固有factとcompletionFactを付ける。障害以外の即興の物語からfactsを変更しない。

追加する `StoryContext` は日英の `aiName / world / mystery / openingClue` と `phases: { opening, middle, final }`。V2の任意フィールド `story` に格納し、旧V2の処理は維持する。機構・ヒントはサーバー用で、公開概要に出さない。

公開概要はタイトル・遊び方・共通rules・障害数のみ。実際の選出とそのsnapshotは新規プレイで一度だけ作る。終了担当にはプレイのsnapshot、確定状態、実際に提示した文を既存の経路で渡す。
