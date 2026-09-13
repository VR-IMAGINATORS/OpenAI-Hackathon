# P2 LiveOutbox工程記録

Status: component implemented (2026-09-13)。P2全体・実Live統合は未完了。

## 正本

- ../plan.md §3.4 / ../data-model.md / ../contracts/openapi.json CommandBatch
- packages/shared/conversation.ts CoreLiveCommand

## 実施

- 接続のgeneration/controllerEpochを検証し、固定event_idと連続seqで通知を保存。
- ack後退と未発行seqを拒否。ack=0は明示再送であり、同じIDの履歴を返しack水位を戻さない。
- ack済み履歴も接続内に保持し、正本の再送と容量上限を両立。上限で明示エラーを返し、未送信通知を破棄しない。
- 接続変更時に破棄。同じ接続へのresetは重複通知を生まないno-op。
- 単一contentのUTF-8上限を既存factCommandと揃え、超過する直接入力は切り捨てず拒否。
- 出力を複製し、呼び出し元による改変から保存内容を保護。

## 検証

- npx tsx --test tests/core-live-outbox.test.ts: 5件成功（課金なし）。
- HTTP認証、500msブラウザpoll、最終発話猶予の実接続は親の統合作業。音声の再生完了やexactly-onceを保証する検証ではない。
