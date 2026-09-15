# GitHub issue登録前のタスクドラフト

Status: GitHub publication approved and completed (2026-09-15)。登録済み本文の記録。issue番号はtasks.mdを参照。

宛先: https://github.com/VR-IMAGINATORS/OpenAI-Hackathon

正本: [仕様](spec.md)、[計画](plan.md)、[データモデル](data-model.md)、[契約](contracts/voice-activity.openapi.json)。型とAPIは参照先を使用し、タスク本文で独自定義しない。全タスク未着手。マルチレビューなし。クレジット制・生成器接続・AWS公開は対象外。

## T01: 音声活動の計測と実機成立性の確認

- 計画: §3 P0
- 依存: なし
- 対象: apps/web/src/voice-activity.ts、apps/web/src/live.ts

入力・出力の音声活動を推定し、既存再生経路を変更せずに警告待機の成立性を確認する。

完了条件:

- [ ] 分析の起動・再開・終了とunknown判定がある。
- [ ] PC Chromeとスマホで発話・息継ぎ・重なり・再生blockedを確認し、実測と未確認をverification.mdへ分けて記録する。
- [ ] 実装・模擬テスト・実AI・実機の確認を区別して記録する。

## T02: ハーネス契約と設定・シナリオ移行

- 計画: §3 P1
- 依存: なし
- 対象: packages/shared/harness.ts、conversation.ts、core-config.ts、scenario.ts、story-catalog.ts、apps/server/scenario-catalog.ts、config/game-core.json、scenarios/story-catalog.json

実行根拠・知識・警告の契約と新規プレイに固定する設定を整備する。

完了条件:

- [ ] 旧設定の明示的な正規化と全18構成の参照整合を検証する。
- [ ] 自然文の許容方針と日英設定を編集でき、秘密を公開stateへ追加しない。型はdata-model.mdを参照し独自に補完しない。
- [ ] 実装・模擬テスト・実AI・実機の確認を区別して記録する。

## T03: 知識・開示・推測の管理

- 計画: §3 P1/P3の知識部分
- 依存: T02
- 対象: apps/local-server/companion-knowledge.ts、story.ts

相棒が知る情報だけを会話へ渡し、条件と質問に応じて情報を開示する。

完了条件:

- [ ] 開示候補IDをサーバーで検証し、秘密本文を回答モデルへ渡さない。
- [ ] 推測は既知の根拠と対応し、繰り返しで事実にならない。既存mysteryを確定真相として移行せず、段階ヒントも同じ開示経路へ統合する。
- [ ] 実装・模擬テスト・実AI・実機の確認を区別して記録する。

## T04: 自律行動と確定前訂正・再試行

- 計画: §3 P2
- 依存: T02
- 対象: apps/local-server/action-coordinator.ts、intent-coordinator.ts、conversation.ts、core-intent-ai.ts、game.ts

写真・音声の共通行動管理と、判定中も動く訂正制御を実装する。

完了条件:

- [ ] 予約成功と根拠予約を同期させ、古い結果とfinallyを無効化する。
- [ ] 同一operationの再試行は追加一度、具現化IDを維持。結果確定前の訂正、写真と音声の重複、確定後通知失敗を競合テストで確認する。
- [ ] 実装・模擬テスト・実AI・実機の確認を区別して記録する。

## T05: 写真自律実行と自然な会話の統合

- 計画: §3 P3
- 依存: T03,T04
- 対象: apps/local-server/hosted-runtime.ts、game-ai.ts、companion-response.ts、live.ts、story.ts、config/game-core.json

写真認識を共通判断へ接続し、公開済み情報だけで結果と状況を説明する。

完了条件:

- [ ] 自明なら用途質問なし、曖昧なら質問、危険なら必要な確認。一つの障害を越えたら判断をユーザーへ返す。
- [ ] 秘密を知る判定器の自由文をLiveへ流さず、メタ発言・不要な回数通知を抑える。確定後だけ画像を生成し、日英の導入と復旧文も整合させる。
- [ ] 実装・模擬テスト・実AI・実機の確認を区別して記録する。

## T06: 音声活動APIと期限付き警告配送

- 計画: §3 P4
- 依存: T01,T02
- 対象: apps/server/app.ts、apps/web/src/PlayScreen.tsx、live.ts、apps/local-server/voice-notifications.ts、live-outbox.ts、hosted-runtime.ts

通常警告を会話の切れ目へ送り、最終警告は有限待機で通知する。

完了条件:

- [ ] 60秒通常・15秒最終・最大3秒待機を初期設定にし、unknown/staleを静寂と扱わない。
- [ ] 専用APIの所有権・rate limit・sequence、outbox期限とackを検証。終了後警告を棄却し、結果通知を失わず、最終警告の聴感を実機で確認する。
- [ ] 実装・模擬テスト・実AI・実機の確認を区別して記録する。

## T07: 競合・情報境界・回帰の自動検証

- 計画: §3 P5の自動検証
- 依存: T05,T06
- 対象: tests/harness-actions.test.ts、harness-knowledge.test.ts、voice-notifications.test.ts、voice-activity.test.ts、既存core/story/hostedテスト

仕様A01〜A15の決定的な部分と契約AC-16を検証する。

完了条件:

- [ ] 制御入力・判定完了・取消しの順序を反転し、二重実行や秘密漏洩を検出できる。
- [ ] 全18構成・旧設定・所有権・送信数を確認。npm run check/test/buildを実施し、模擬成功と実AI品質を混同しない。
- [ ] 実装・模擬テスト・実AI・実機の確認を区別して記録する。

## T08: 日英・PC・スマホの体験検証と開発資料

- 計画: §3 P5の実機検証
- 依存: T07
- 対象: specs/improve-game-loop-harness/verification.md、docs/development.md、specs/game-core/spec.md

実際の音声と写真で体験を確認し、設定変更と調査の手順を残す。

完了条件:

- [ ] 自律行動、訂正、リスク確認、非メタ発言、時間警告、次状況の説明を日英・PC・スマホで記録する。
- [ ] 待ち時間・API利用量と失敗例を記録。未確認は未確認のまま残し、PR先はdevelop。AWSリリースとマルチレビューは実施しない。
- [ ] 実装・模擬テスト・実AI・実機の確認を区別して記録する。

T01の実機確認待ちでも独立したT02〜T05は進められる。T06の完了にはT01の成立性確認が必要。依存関係は並列実行の指示ではない。


