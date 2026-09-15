# 実装計画

Status: approved (2026-09-15, conversation-authorized scope)

## 方針

ハッカソンの既存構成内で実装。上記spec L1–L6は会話で合意した実装方針の具体化。AGENTS.mdの指定によりマルチレビューは実施しない。新しいHTTP API・外部サービス・保存データは不要。

1. `companion-response.ts` の本編台詞生成を公開事実の同期投影へ置換し、`hosted-runtime.ts / performCoreAction` から追加Responses呼出しを除く（L1）。
2. `core-intent-ai.ts` と共有スキーマに雑談受付を区別するresponseKindを追加。既存answerは相談資料として扱い、雑談は空の資料とし、Liveが返答を考える。受付・証拠消費・クレジット精算は既存の順序を維持（L2, L3, L6）。
3. `live.ts` に通知ID付き事実送信を実装。短い資料は一つのcommentary、長い資料はthinkingの連番部分＋最後のcommentary一つ。`hosted-runtime.ts` は相談の直前の重複した状況送信を除き、送信失敗後はその通知の残りを投入しない（L4）。
4. `live.ts` と `config/game-core.json` の会話方針を揃える。photo/controlの通知資料も台詞ではなく公開事実と必要事項に揃える。警告のスケジュール・通常警告のthinking・終話処理は維持（L5）。
5. 単体・runtime回帰テスト、型・全テスト・ビルド、仕様とAI指示マップの同期（L1–L6）。

## リスクと検証境界

commentaryは逐語読み上げではなくLiveが言い換えるAPI。事実送信への変更だけで意味的重複ゼロ・誤読ゼロは保証できない。長い資料を途中で発話しないことはLiveへの指示も必要。バックエンドは秘密を公開投影し、行動は既存の確定処理に限定する。再接続で未確定の古い発話を再生しない。

仕様・計画・タスクは本実装のローカル記録とする。ユーザーが明示的に起動していないスキル経由でGitHubにメッセージを投稿しないという開発者指示に従い、issueは作成しない。
