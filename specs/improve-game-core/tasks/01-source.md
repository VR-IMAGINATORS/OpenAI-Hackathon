# T01 原資料の固定と拡充データスキーマ

Issue: #58 / Status: completed / 2026-09-15

- [x] 仕様・計画S1・データモデル・CLI契約・評価契約を確認
- [x] 固定入力・候補・コンパイラ実装
- [x] 境界と互換性テスト
- [x] 結果を記録

## 実装

- freezeSourceはI/Oを行わずカタログ原文・SHA-256・完成構成・元解法を保持。再読込検証は固定された原文から再計算し、外部の現行原資料を参照しない。
- validatePreservationは障害の順序・判定用機構・受理/拒否/例示解法・完了条件・遷移・物理制約・ルールを固定。表示変更は列挙したパスだけ許可。
- ScenarioV2の任意investigationに概要・情報層・補完許容値・公開画像情報・拡充元を追加。新規知識は対象と情報層のメタデータ必須。KnowledgeStateの補完値保存はT03で追加する。
- 補完は限定許容値方式。攻略非関連性の意味評価は後続の独立評価で検証する。文章の矛盾がないことをdigestのみで保証しない。
- changeMapの参照は原カタログと候補のJSON pointer。存在を検証。2000文字/100知識/256 KiB上限を維持。

## 検証

- 新規sourceテスト8/8、既存story-catalog・harness-knowledgeを含む対象回帰25/25成功。
- npm run check成功（TypeScript、既存V1/V2/V3、core config）。
- 実API・音声・実機・マルチレビュー・commit/pushは未実施。

## 実行環境の記録

通常apply_patchはWindows sandbox helper setup refreshエラーで失敗。正規require_escalated execによる編集は承認された。自作新規ファイルの構文修復でindexOf以降を切り捨てる案は自動承認審査にデータ損失リスクとして拒否された。対象2ファイルを一時領域へバックアップし、重複本文の完全一致をassertで検証する安全策を再申請して承認され修復した。既存未コミット原資料は保持。
