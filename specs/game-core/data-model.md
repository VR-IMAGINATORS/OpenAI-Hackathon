# データモデル — game-core

Status: approved (2026-09-13)。plan.mdと同時承認。本文の型はアプリ内部型でありLive APIの型ではない。

## エンティティ

|型|主なフィールド|制約・寿命|
|---|---|---|
|ScenarioSnapshot|digest, locale:ja/en, scenarioV2, coreConfig, createdAt|開始時にdeep freeze。モデルallowlist/秘密は含めない。遅延jobも同じsnapshot|
|TranscriptFragment|serverSeq, eventId, generation, speaker:user/assistant, delta, startMs,endMs,receivedGameVersion,executionEligible|時刻区間は検証、順序はserverSeq、原文保存。64KiB/10,000イベント。終了で元台帳破棄|
|DelegationRequest|id,generation,offsetMs,receivedAt,deadline,attempts,lastEvaluatedContextVersion,status|status pending/evaluating/consulted/reserved/expired。最大3評価/20秒。公式event本文には指示なし|
|IntentDecision|kind:wait/consult/execute,evidenceSeq,itemRefs,usage,reason|kindごとstrict union。evidenceは既存user断片。itemRefsはphotoIdまたはinventoryId。発言未取得から推測しない|
|ActionTicket|id,playId,generation,controllerEpoch,gameVersion,contextVersion,evidenceSeq,intent,status|status pending/committed/failed/invalid。予約で根拠発言範囲を占有。1プレイpending1件。サーバーID|
|GameFacts|obstacleId, values:Record<declaredKey,allowedEnum>|シナリオでkey/値/許可遷移を宣言。未宣言key拒否。situationは派生演出|
|ActionResult|actionId,beforeVersion,afterVersion,success,factChanges,inventoryChanges,narrative,shortReason|コード検証後一度だけ確定。snapshotをSceneJobへ渡す|
|LiveOutboxEntry|seq,eventId,generation,controllerEpoch,delegationId,commandType,content,messageId|generation別連番。128件/64KiB、ackは連続seq。connection切替で旧分無効|
|ChatMessage|id,createdOrder,updatedVersion,side:user/assistant,kind:transcript/photo/result/system,text,assetIds,imageSlot,relatedCommandSeq,liveGeneration|128件/文字48KiB。textはHTMLとして扱わない。updatedVersionがfeed cursor|
|SceneJob|id,playId,messageId,snapshot,status,attempts,deadline,cancellationEpoch|status queued/generating/checking/retrying/ready/failed/cancelled。生成最大2、検査最大2、全体150秒|
|MediaPermit|jobId,ownerPlayId,cancellationEpoch,expiresAt,generationAttempts,inspectionAttempts,busy|終了後新規発行不可。既登録分だけ継続。運営drainで全失効。費用計数は再起動でリセット|
|ResultEntry|playId,ownerDigest,locale,feedVersion,messages,assets,result,endedAt,retainUntil,bytes|終了後5分上限、終了済み10件、8MiB/entry、128MiB/global。旧結果evictはジョブもcancel|
|Asset|id,playId,kind:photo/scene,bytes,mime:image/jpeg|photoは32KiB thumbnail、scene256KiB。sceneは合格後のみ登録。元写真は行動/終了で破棄|
|TraceEntry|actionId,configDigest,interpretation,shortReason,durationMs|開発限定128件/64KiB。所有者のみ。終了で破棄。写真/全文promptなし|

## 主要シグネチャ

- ConversationLedger.append(event): TranscriptFragment
- ConversationLedger.captureUnconsumedContext(): IntentContext
- IntentCoordinator.acceptDelegation(event): void
- IntentCoordinator.onContextChanged(): void
- GameSession.reserveAction(intent, expectedContextVersion, expectedGameVersion, actionEpoch, controllerEpoch): ActionTicket
- GameSession.commitAction(ticket, judgment): ActionResult
- SceneJobs.enqueue(resultSnapshot, messageId): SceneJob
- ResultStore.feed(ownerDigest, playId, afterVersion): FeedResponse
- ResultStore.asset(ownerDigest, playId, assetId): Buffer
- LiveOutbox.poll(generation, controllerEpoch, ackThrough): CommandBatch

## 遷移・不変条件

写真送信→用途待ち→相談または指示→予約→判定→結果。consultとwaitは回数を変えない。結果確定後に独立した画像jobを作り、ゲームは次へ進む。judgingでも会話台帳は更新するが、同時に別ticketを予約しない。

gameVersionは確定状態、contextVersionは未確定入力、feedVersionは表示更新。混用しない。古いgameVersionの画像は正しい過去画像であり、現在状態を書き換えず元messageへ追加する。古いgameVersionの行動判定は採用しない。

勝敗/時間切れ/手動終了/接続失効/絶対期限/運営drainはendReasonで区別。通話終了確認と結果閲覧保持は独立。API秘密を所有者向けsnapshotにも含めない。

## scenario v2 と共通設定

v2ではプレイヤー表示テキストをLocalizedText={ja:string,en:string}とし、title/playerBriefing/obstacle.title/premiseを対象とする。内部situation/goal/constraintsはAIへの入力文であり、localeに沿った表示文を結果として生成する。初期状態をそのまま表示する箇所にはローカライズ済みのsituationDisplayを必須にする。

core.facts: [{key,initial,values,allowedTransitions,visualDescription}]、obstacle.factKeys/goal/requiredVisualFacts/forbiddenVisualChanges、core.characterAppearance/core.visualStyle/core.judgmentPolicy/core.hintLevels。キーは既存id形式、最大30facts、値最大10/key、文各2000文字、全設定256KiB。参照整合性・初期値と遷移集合を検証する。

共通configはschemaVersion=1、conversation（locale別Live指示と分類例）、judgment（物理性/曖昧さ/部分進展）、visualInspection（重大矛盾の説明）、chatGroupingGapMs（表示だけ）。シナリオは指定されたpolicy欄のみ補足し、秘密/モデル/APIURL/予算を上書きできない。

## 接続と行動の世代

liveGenerationは音声接続の世代、actionEpochはゲーム行動の失効世代。勝敗確定でactionEpochのみ進め、finalVoiceUntilの猶予内では既存liveGenerationの最終コマンドを届ける。inputの表示と新規実行の可否を分け、read-only pollはruntimeの一般的terminal拒否を経由させない。

judging中のexecutionEligible=falseを後から昇格させない。分類snapshotのgameVersion/actionEpochが変われば予約不可。区間が曖昧な後着音声は再発話へ。failed ticketの根拠も自動再実行せず、新発言が必要。結果メッセージとコマンドは相互IDで相関し、表示待ちは最大2秒、通信不能/履歴再読時はテキストで回復する。
