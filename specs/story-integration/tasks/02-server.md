# P2: 選出と時間

対象: plan.md P2。担当: 主担当。新カタログを既定にし、18構成のサーバー抽選・preview・snapshot固定・共通時間検証を実装する。旧V2の明示指定を維持する。対象: scenario-catalog.ts、server/config.ts・app.ts、tools/mobile.ts・validate-scenario.ts、関連テストと運用文書。

- [x] current/preview・V3対応
- [x] 既定設定と時間検証
- [x] 抽選・snapshot・bootstrap・設定テスト

2026-09-14: `story-server.test.ts` 5件と `hosted-config.test.ts` 4件が成功。全18候補、日英、preview非抽選、HTTP作成リトライ・再読込・操作権移行の選出保持、300→180/450秒の新規反映と旧snapshotの不変、480秒の寿命不整合拒否、明示指定した旧V2互換を確認。旧シナリオを前提にする全編回帰テスト2本はSCENARIO_PATHを明示し、従来構成を継続検証する。
