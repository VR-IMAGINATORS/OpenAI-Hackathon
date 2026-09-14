# P1: マスターと型

対象: plan.md P1、spec.md S01/S03/S04/S06/S07。担当ファイル: packages/shared/story-schema.ts、packages/shared/story-catalog.ts、packages/shared/scenario.ts、scenarios/story-catalog.json、tests/story-catalog.test.ts。

DoD: 元の6舞台・10障害・18順序と日本語設定を保持、日英、厳密な参照検証、全候補のV2コンパイル、固有の部分進展とcompletionFact、旧V2の互換性を満たす。元マスターを変更しない。工程ごとにチェックを記録する。前提の矛盾・範囲拡大があれば親へ報告する。

## 実行サブタスク

- [x] 元マスター・Story.md・既存V2と画像条件の参照箇所を確認
- [x] StoryContext、V2任意フィールドとcompletionFactの参照・到達性検証を追加
- [x] 元の日本語設定を保持し、全6舞台・10障害・18構成の日英カタログを追加
- [x] 厳密な参照検証と候補からV2へのコンパイルを実装
- [x] 元マスターとの対応・不正参照・全構成・旧V2互換性を自動検証

## 検証結果

- `tsx --test tests/story-catalog.test.ts tests/story-runtime.test.ts`: 19件成功。元の6舞台の名前・説明・人物・謎・18順序、10障害の観察・機構・ヒント・受入/不成立条件・代表解、10道具の日本語と物性を全件比較。
- 全ローカライズ項目について日本語/英語の実テキスト、連続する `?` とU+FFFDの欠如を確認。新規日本語のPowerShell入力変換を修正済み。元マスターは読み取りのみ。
- `tsc --noEmit`: 成功。担当5ファイルのPrettier整形済み。
- 全18候補の固有fact・許可遷移・完了条件・画像条件・両言語と旧V2互換性を検証。公開概要に謎・後続機構を含めない。
- 実AI・音声・実画像・面白さは未検証。全体check/test/buildとコミットは親担当で実施。
