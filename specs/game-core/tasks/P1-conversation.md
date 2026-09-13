# P1 会話共通契約

Status: implemented (2026-09-13)。P1の会話型担当分のみ。P0全ケースや本編統合の完了を示さない。

## 正本・対象

- [データモデル](../data-model.md) / [HTTP契約](../contracts/openapi.json)
- packages/shared/conversation.ts
- tests/core-conversation-contracts.test.ts

## 工程

- [x] 既存game.ts/api.tsを変更せず会話・委譲・意図・行動・事実の内部型とstrict Zodスキーマを追加
- [x] wait/consult/executeの分岐外フィールド、空/重複根拠、写真と所持品の参照名前空間、時刻逆転を拒否
- [x] ActionTicketへplanのactionEpochを含め、予約根拠とexecute intentの根拠一致を検証
- [x] factChangesはkey/from/to、inventoryChangesは既存判断型と同じid/status/description。重複変更と行動versionの飛び越しを拒否
- [x] 内部LiveOutboxEntryとHTTP Commandを別型にし、ChatMessage/SceneImageSlotをHTTP正本と同期
- [x] 契約テスト7件を実行し7件通過。npx tsc --noEmit通過

## 検証の境界・後続責務

ここで保証するのは形、参照の形式、数値範囲とオブジェクト内整合性。evidenceSeqが実在するuser発話か、根拠が消費済みか、参照道具の所有/可用性、factsの宣言/現在値/許可遷移、世代やcontrollerの一致は、P2で実データと突き合わせる必要がある。

内部の時刻はミリ秒の整数、HTTP画像slotのdeadlineはdate-time文字列。元の文字起こしにtrimやAI要約をかけない。HTML文字列をエスケープするのはReact表示側の責務。

構造上の補足としてexecuteは1件以上の道具参照、ActionResultは1回の確定でversionを1進める形とした。HTTP Commandには世代/controllerを追加していない（CommandBatchが接続単位を管理）。LiveOutboxの容量、ack、取消、画像の合否状態整合性、事実更新の実処理はまだ実装していない。

実API・実音声・画像生成はこの担当では実行していない。共有スキーマはまだ本編へ接続していない。
