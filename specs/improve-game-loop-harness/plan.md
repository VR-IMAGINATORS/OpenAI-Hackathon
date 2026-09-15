# ゲームループハーネス改善：実装計画

Status: approved (2026-09-15)

2026-09-15作成。[仕様](spec.md)の承認を受けた計画案。実装は未着手。ハッカソンの規模・既存の認証/上限・マルチレビュー不要の指示を継承する。計画承認前にタスク化・実装へ進まない。

## 1. 設計の中心

現在の統合サーバー内に、(1)実行候補と確定、(2)相棒の知識、(3)発話通知の小さな管理単位を置く。汎用エージェント基盤や新インフラは作らない。Liveは会話・委譲を担い、ゲーム状態の変更と開示の最終権限はサーバーに残す。

写真認識後は共通の意図判断へ入り、自明なら実行、不明なら質問する。写真用の架空delegationは作らず、通知はdelegation_id:null。音声起点は実IDに応答する。新規行動の実行と、進行中行動への訂正の処理を分離する。

秘密を読む判定器の自由文をそのままLiveへ渡さない。状態差分を検証して、公開済み事実だけから短い結果説明を作る。発話文・短い状況説明・画像の根拠を揃える。

詳細: [調査](research.md)、[データモデル](data-model.md)、[追加HTTP契約](contracts/voice-activity.openapi.json)。データ型名・新関数名は本計画で導入する名称。

## 2. 技術上の限界と最初の検証

Liveのackやtranscriptは再生完了を示さない。ブラウザ内で入出力の音声活動を推定して警告を待機するが、文末やネットワーク越しの正確な再生時刻までは保証しない。

P0でPC Chromeとスマホの実音声を確認する。分析不能・ブラウザ非表示・AudioContext停止・再生blockedはunknownとし、静寂と偽らない。通常警告は保留、最終は上限後に通知を試みる。これは聴感の低下がありうる経路として記録する。成立しなければ警告制御の計画を見直し、完了扱いにしない。他の独立した作業は進められる。

## 3. 実装ステップ

### P0: 音声活動の計測と警告の成立性確認

- 新規 apps/web/src/voice-activity.ts: VoiceActivityMonitor。Web Audioで入力/出力トラックを分析。50ms間隔、RMS閾値とヒステリシス、quiet判定800ms、unknownの処理。分析分岐を音声出力へ繋がず、再生経路やplaybackRateを変更しない。終了・再接続で分析ノードとtimerを解放。
- 変更 apps/web/src/live.ts: prepare/ontrack/resumeAudio/releaseでmonitorを起動・復旧・破棄。音声許可のユーザー操作からAudioContext.resumeを行う。
- 実機確認: 普通の発話、息継ぎ、両者の発話、PCスピーカー/イヤホン、スマホ、再生ブロック/背景タブ。本文や音声は記録せず、時刻・活動状態・警告送信の計測だけを使う。
- 新規 specs/improve-game-loop-harness/verification.md: 自動/実音声を分けた結果欄。unknown率・警告の待機時間・切れ方を記録。

### P1: 設定と知識の境界

- 新規 packages/shared/harness.ts: ActionOrigin、control input、knowledge、warning、voiceActivityのZod schema。音声と写真の根拠は判別unionで検証。観察は読み取り専用の別経路、状態変更を伴う環境操作は有効な対象IDを要求。
- 変更 packages/shared/core-config.ts / config/game-core.json: 自然文のacceptancePolicy、日英の会話方針・復旧文、複数警告。初期案60秒通常/15秒最終/最大3秒待機。旧単一警告形式を正規化し、互換読取をテスト。
- 変更 packages/shared/story-catalog.ts / scenario.ts / apps/server/scenario-catalog.ts: 知識と開示条件のschema、参照整合、開始時snapshot。scenarios/story-catalog.jsonへ既存の確定情報だけを移行。mysteryを確定真相として移行しない。既存全18構成を読む。
- 新規 apps/local-server/companion-knowledge.ts: KnowledgeStore、buildCompanionContext、eligibleRevealCandidates、applyReveals。条件はコードで判定、モデルは候補IDを選ぶだけ。選択後の再検証は状態版付き。
- 変更 apps/local-server/story.ts: storyContext/storyOpening/storyNarration/storyHintの責務を整理。公開文脈はbuildCompanionContext経由。謎・演出指示の全体JSONをLiveへ送らない。既存の段階ヒントも開示として管理。
- 推測は根拠の既知IDを要求し、tentative/retractedのみ。未知の真相を埋めるために製品シナリオへ設定を創作しない。

### P2: 実行候補、取消し、再試行

- 変更 packages/shared/conversation.ts: ExecuteIntent/ActionTicketへActionOriginとrevisionを追加。evidenceSeqを全体でoptionalにする変更はしない。
- 変更 apps/local-server/conversation.ts: 新規実行の適格性と進行中の制御用発話の適格性を分離。judging中でも制御用のuser fragmentsを保持。無音やassistant発言を根拠にしない。
- 新規 apps/local-server/action-coordinator.ts: ActionCoordinator。写真/音声候補を一件のoperationへ対応させ、同じ要求を重複実行しない。写真triggerは一度取り込むが、その写真の道具の再利用は禁止しない。
- 変更 apps/local-server/intent-coordinator.ts: 実Live委譲の受付・expiryを維持し、共通action coordinatorへ渡す。予約成功と根拠の予約を同期させ、予約失敗前にledger.consumeしない。judging中の委譲を一律expiredにせず制御へ配送。
- 変更 apps/local-server/core-intent-ai.ts: 写真/音声別入力、wait/consult/execute/clarify/observeと制御分類を明示schemaで扱う。既存providerDecisionのoptions添字依存を廃止。制御分類は独立した単一worker、最大5秒、最新入力へ集約。新規行動を並列実行しない。
- 変更 apps/local-server/game.ts: reserveAction/judgeActionを計算と確定へ分離、cancelPendingActionとcommitActionResultを追加。再試行では同じticketとmaterialized inventory IDを保持。試行失敗だけで写真contextを捨てない。
- finallyの時計再開やpending解除はそのticketをまだ所有するときだけ実施。古い処理の終了で新しい処理の時計を再開しない。
- accepted/rejectedは物の認識版・設定版・関連状況に紐づける。認識訂正時に再評価できる。リスクは既存のbroken/consumedと宣言済みfactsの範囲で扱い、判定器が未定義の悪化状態を追加しない。

確定境界の疑似コード:

```ts
const ticket = reserveCandidate(candidate); // 根拠予約もここで原子的に
const result = await evaluateWithOneRetry(ticket);
await controls.settleFor(ticket); // 未解決の入力があれば確定を保留
// この検証と更新の間にawaitを挟まない
const committed = commitActionResult(ticket, result, {
  revision: ticket.revision,
  requireNoPendingControl: true,
});
if (committed) presentCommittedResult(committed);
```

入力受信時にcontrol revisionを同期更新してから分類を始める。無関係な発話なら保留解除、訂正なら旧ticket失効と再評価。判別不能・timeoutなら古い行動を確定せず確認する。未到着音声まで遡る保証はしない。

再試行は一つのoperationで追加一度。既存のHTTP再送、AI内部retry、分類の再評価を監査し、技術再試行を掛け合わせない。結果が確定済みなら再判定せず発話だけ回復。再試行不能・失効時は終了または短い再依頼案内を返す。

### P3: 自律判断と公開情報だけの会話生成

- 変更 apps/local-server/hosted-runtime.ts: photosの認識終了からActionCoordinatorへ登録。固定「これをどう使う？」を削除。eventは制御入力を確定前に届ける。公開状態取得をbuildCompanionContextに集約。
- 変更 apps/local-server/game-ai.ts: 許容方針と物理制約を明確化、結果は検証できる状態差分として返す。秘密を読んだモデルのnarrativeをLiveへ転送しない。
- 新規 apps/local-server/companion-response.ts: composeCompanionReply。既知/開示済み事実、確定した公開結果、ユーザー要求のみを入力する。結果と次の状況を短くまとめ、未要求の解法提案を抑える。モデル追加常駐なし、既存のserver-side AI設定と上限を使用。
- 変更 apps/local-server/live.ts / story.ts / config/game-core.json: 用途が自明ならハーネスが実行、確定前の成否禁止、内部用語を読み上げない。写真認識だけの時点で「実行した」と言わない。導入の操作説明を新フローに揃える。
- publicContext、再接続instructions、相談answer、結果、エラー、story stageのすべてを点検。隠し文字列のcanaryを使って入力/出力境界をテストする。
- 失敗時の短い定型文は日英設定へ寄せる。再試行中と復旧不可を区別。「少し待って」のまま処理を終えない。

### P4: 会話を考慮した通知配送

- 新規 apps/local-server/voice-notifications.ts: VoiceNotificationScheduler。通常60秒/最終15秒、両側quiet800ms、最終待機3秒を初期値。活動のstaleは2秒、unknownはquietでない。最終に到達したら古い通常警告を置換。
- 新規API POST /api/play/voice-activity。変更 apps/server/app.ts: controlled(req)、同一origin、schema、専用rate limit（毎秒4件・burst8）、generationとsequence検証。勝敗・消費・時計は変更できない。
- 変更 apps/web/src/PlayScreen.tsx / live.ts: 最新活動のみを最大毎秒4回、安定時毎秒1回送信。音声イベントと独立した小さな送信経路で、telemetryの遅さが訂正を塞がない。再送キューを蓄積しない。
- 変更 hosted-runtime.tsのtick: warningSent一個をschedulerへ置換。先にgame.check、終了後は破棄。恒常的な口調指示は開始時、警告時は短いcommentary一件を中心に送り、毎回のinstructions.appendをやめる。
- 変更 live-outbox.ts / packages/shared/conversation.ts / PlayScreen.tsx: 警告のvalidUntilとbatch.serverNowを追加。ブラウザはpoll受信からの経過を加味し送信直前に期限・世代を再確認。棄却seqもackを進める。通常結果の保持と警告expiryを混同しない。
- 優先順位: 終了、中止/訂正、最終警告、確定結果、通常警告。結果は消さず遅延送信、期限切れ警告だけ破棄。送信後のLive音声を確実に取り消せると主張しない。
- 音声が実際に聞かれたことをackで記録しない。未知・blocked時は既存UIの再生再開案内と時間表示を維持する。

### P5: 検証とドキュメント

- 変更 tests/core-*.test.tsの該当群、tests/photo-send-limit.test.ts、tests/story-runtime.test.ts、tests/story-catalog.test.ts、tests/hosted-http.test.ts。新規 tests/harness-actions.test.ts、harness-knowledge.test.ts、voice-notifications.test.ts、voice-activity.test.ts。
- fake clockとdeferred Promiseで、訂正受信→判定完了→訂正分類完了の全順序、古いfinally、新しい写真/音声、再接続、期限切れを試す。
- 秘密canaryが初期・相談・結果・再接続・回復のLive payload/公開stateへ混入しない。推測の支持IDと開示条件、全18構成の参照整合、旧設定の移行を確認。
- 自然文方針の違い、拒否と受信消費、軽い試行と危険確認、次障害で止まること、画像のcommit後開始を確認。
- 警告はactive/quiet/unknown/stale、古いsequence、期限超過、接続変更、送信待ち、最終の置換、ack欠落を試す。偽の活動データでゲーム時間や回数を改変できないことも確認。
- npm.cmd run check、npm.cmd test、npm.cmd run build。実API/日英/スマホ/PC/聴感は別欄で記録し、自動テストの成功で代替しない。
- 実音声の重点: 写真だけの自律実行、相談と依頼、判定中の訂正、自然な警告、結果後の状況説明、メタ発言、再試行時の二重行動なし。
- 変更 docs/development.md: 設定編集場所と計測方法。game-coreの古い要求を新仕様へ揃え、今回のverificationへリンク。PR先develop、main/AWSへは反映しない。

## 4. 情報保護・性能

既存cookieとplay/client/control epochの所有権を継承。secretはサーバーsnapshotのみ。ブラウザからモデル名・上流URL・開示状態・時計を指定できない。音声活動は不信データであり通知タイミングの参考に限定する。

生の音声・写真・会話・資格情報を新規ログへ保存しない。開発traceは既存の認証と保持期限内で、ID、stage、短い判断理由を扱う。秘密の推論過程を出さない。

行動worker1、制御worker1、保留は既存上限内。取消しはAbortSignalだけに依存せずrevisionの確定検証で守る。API呼出し増による待ち時間は実測し、まず不要な往復と重複入力を減らす。新しいモデルへの変更をこの計画で強制しない。

## 5. 要件カバレッジと自己点検

| 要件 | 実装 | 検証 |
| --- | --- | --- |
| H01〜H07 | P2/P3 | A01〜A05/A10/A15 |
| H08〜H12 | P1/P2/P3 | A05〜A07 |
| H13〜H17 | P1/P3 | A04/A08/A09 |
| H18〜H19 | P3 | A14/A15 |
| H20〜H23 | P0/P4 | A12/A13/A15 |
| H24〜H27 | P2/P3/P4 | A03/A10/A11/A13 |
| H28〜H29 | P1/P5 | A06/A08/A15と全構成/情報境界検証 |

自己点検で対処: 音声根拠のoptional化を回避、判定中訂正の専用経路、秘密を読んだ自由文の分離、旧finallyの時計再開防止、再試行時の具現化ID固定、警告outbox失効を追加した。新しいインフラ・クレジット・生成器接続は含めない。マルチレビューはユーザーの指示に従い未実施。技術調査の補助エージェントはコード読取のみでありレビューではない。

## 6. 判断ブリーフと承認状態

1. 警告は実音声の活動を推定して待つ。自然な文末を完全保証はできないためP0を最初に検証する。
2. 警告の初期案は60秒通常/15秒最終/3秒待機。変更は設定のみで可能。
3. 秘密非公開を守るため、行動判定と公開結果の発話生成を分ける。追加の待ち時間・API利用量を測る。

2026-09-15、判断ブリーフ提示後にユーザーが本計画とタスク化を承認。マルチレビュー省略も再確認済み。Task Contractは承認済み要件を転記し、実装前に固定する。
