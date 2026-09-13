# AWS公開・複数人試遊 実装タスク

計画承認: 2026-09-13。詳細はGitHub Issueとtasks/。P1〜P6実装・ローカル検証完了。P7〜P8は下記の実績と公開ゲートを参照。

正本: spec.md、plan.md、data-model.md、contracts/openapi.yaml。API型・列挙値はチケットで再定義せず正本を参照する。

## タスク一覧

- [x] P1 [AI通信と利用制限を内部サービスへ統合](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/8) — 依存: なし（契約に基づき先行可能）
- [x] P2 [認証・複数プレイ所有権と復帰期限を管理](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/9) — 依存: なし（契約に基づき先行可能）
- [x] P3 [ゲームと音声の実行状態をプレイ単位へ分離](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/10) — 依存: #8, #9
- [x] P4 [単一HTTPサーバーと運用API・安全なログを実装](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/11) — 依存: #8, #9, #10
- [x] P5 [公開URL向け参加・復帰・再プレイ画面へ変更](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/12) — 依存: なし（契約に基づき先行可能）
- [x] P6 [ローカル起動を1サーバーと共通URLのQRへ移行](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/13) — 依存: #11, #12
- [ ] P7 [LightsailとGitHub Actionsの配信手順を実装](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/14) — 依存: #11, #13
- [ ] P8 [複数人プレイの統合検証と公開手順を確定](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/issues/15) — 依存: #8, #9, #10, #11, #12, #13, #14

## 進め方と完了の区別

P1・P2・P5は契約に基づき先行可能。P3→P4でサーバーへ統合し、P6でローカル導線、P7で配信、P8で全体検証。P7の設定テンプレートは先行可能だが実配信確認は依存完了後。共有ファイル変更は担当タスクへ集約する。

実装・fake検証と、AWS・実API・実スマホ・同時5人の公開ゲートを分けて記録する。未実施の公開ゲートを理由なく完了扱いしない。Issue作成時点ではコード変更・AWS作成は未実施。

## 現在の残り
P7のコード/Docker/fake検証は完了。AWS連携・Lightsail未設定のため実配信は未実施。P8はverification.mdの公開ゲートを残す。AGENTS.mdはユーザーの明示承認後に同期済み。全完了とは扱わない。
