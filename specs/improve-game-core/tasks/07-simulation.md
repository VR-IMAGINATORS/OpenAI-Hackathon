# T07 / Issue #64 — 共通ハーネスで模擬プレイ

状態: 完了（2026-09-15）。承認済みplan S5/S6・spec P01–P09・CLI契約・Issue #64を確認。

## 実行サブタスク

- [x] 盲検PlayerViewとask/send_itemsの厳密な検証を実装
- [x] 認識だけsyntheticへ差替え、共通ハーネス/判定AIへ明示text-onlyアダプターで接続
- [x] 3モデル×3persona、pilot3とremaining6の差集合と条件固定を実装
- [x] 1プレイ最大25ターン、ゲーム終端/上限未クリア/通信等未完了を分離
- [x] 全AIを既存meterの同一play/scopeへ接続し、固定ゲーム時計と実API時計を分離
- [x] 毎ターンcheckpoint、完了済みplay単位再利用、未完了の別attempt retryを接続
- [x] 公開非混入・制限・写真自律・3件停止・再開のテストと型検査を実行

## 接続前提

PilotContext={input,candidate,compiled,store,budget,createClient(playId,scopeId?),signal?}。T06 CLI担当と直接調整する。GameAI.recognizeのみsyntheticへ置換し、judge/core-intent/selection/replyは同じ計測clientを使う。GameAI judgeも写真バイナリを送るため、core-intentに加えてjudge入力にも明示text-only輸送設定が必要。本番既定の画像経路は維持する。

実API/課金・マルチレビュー・commit/pushなし。計画の前提矛盾、DoD矛盾、大幅な規模超過は記録して親へ報告する。

## 中間検証

player/play-adapter/matrixと固定4プロンプトを作成。初回6テスト中4成功、残り2はmeterが生成する失敗コードおよび可用候補に応じた呼出数の期待を修正中。25ターン停止と写真判定/100credit消費、公開allowlistは成功。選択済み物品の通常属性のみをjudge入力へ補足し、画像バイナリを除く。本番画像モード既定は変更していない。

## 最終結果

- 公開allowlistのPlayerView、厳密ask/send_items、固定4プロンプト、3モデル×3personaを実装。初回対角3件でpilot_reported、明示remainingで差集合6件だけを実行する。
- 写真認識のみsynthetic。共通GameHarnessで受領→危険確認/自動行動→判定→知識同期→料金確定。画像の代わりに選択済み物品の通常属性をjudgeへ渡す。実ゲームの既定画像経路は維持。
- API全役割を同じplay/attempt scopeのmeterへ接続。25ターン上限、固定ゲーム時計、通信時計別管理。通常の未クリアとAPI/取消し未完了を分離する。説明APIに共通fallbackがある場合も、失敗callがあれば評価プレイは未完了とする。
- 毎ターン公開前後状態・公開返答・確定event・private診断を保存。開示/補完traceは初回のturn/version付き。未完了retryは新attemptで初期状態から開始し、古いcall/turnを保持する。未実施pilotが残るretry後はawaiting_pilotへ戻す。
- 新規9テスト成功。関連回帰（simulation/shared harness/core intent/schema/actions/photo limits）56/56成功。npx tsc --noEmit成功。T06 CLI担当が既定runnerとmock transportを接続済み。

実AIの能力・音声・写真認識精度・面白さは未検証。ここでのmock成功は実AI評価成功を意味しない。課金・マルチレビュー・commit/pushなし。
