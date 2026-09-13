# P1 設定スキーマ実装

Status: implemented (2026-09-13)。P1全体・P0実Liveゲートの完了を意味しない。

## 変更

- `packages/shared/core-config.ts`: ja/enの共通会話方針・分類例、判断方針、画像検査方針、表示用グループ間隔をstrict schemaで検証。
- `packages/shared/scenario.ts`: v2、両言語表示、宣言facts、値・遷移・障害参照、画像制約の検証。旧v1 APIは保持。`localizeScenario`は既存runtimeへの一時投影、`publicScenarioV2`は両言語の安全概要だけを返す。
- `config/game-core.json`と`scenarios/mobile-playtest.json`: 編集可能な初期方針とv2例。
- `tests/core-config.test.ts`: 未翻訳、未知の運営設定、重複ID/値/遷移、不正参照、安全公開、v1投影を検証。

## 契約の具体化

factsの`allowedTransitions`は`{from,to}`。`requiredVisualFacts`は`{key,value}`、`forbiddenVisualChanges`は`{key,from,to}`。画像用制約は現在の確定factsを覆さず、未確定の進展を画像が先取りしないためのものとして適用する。P4で確定snapshotと合わせて解決する。`factKeys`は画像参照を含む障害の参照可能なfacts集合。

表示文は各言語2000文字以内。設定ファイル256KiB制限とsnapshot freezeはScenarioCatalog担当。モデル・URL・予算・期限・並列数等の未知設定キーは拒否する。自然文を信頼済みの運営設定へ昇格させない。

## 確認

- `npx tsc --noEmit`: 成功（スキーマ実装直後）。
- `npx tsx --test tests/core-config.test.ts tests/scenario.test.ts`: 7件成功。
- 対象TS/JSONのPrettier整形済み。
- 実AI、画像生成、本編での日英通しプレイは未実施。v2の本編反映は後続工程。
