# データモデル

型名の一部は設計上の概念名。実装ではGameSessionのticket/版検証を行動状態の正本とし、hosted-runtimeが写真受信・危険確認・制御入力を統合する。独立した二重の行動レジストリは設けない。すべてサーバー所有、プレイ終了時に既存の保持規約に従って破棄する。

## 実行と訂正

- ActionOrigin = {kind:'speech', evidenceSeq:number[], delegationId:string} | {kind:'photo', requestId:string, photoIds:string[], photoVersion:number}。写真IDは受信済み・認識済み・所有者一致が必須。音声は実際のuser fragmentと委譲への参照が必須。空のevidenceSeqで写真を偽装しない。
- ActionOperation: id、origin、generation、controllerEpoch、gameVersion、obstacleId、revision、status、intent、attempts、deadline、resultId、handledEvidenceSeq。statusはevaluating→awaiting_confirmation/ready→judging→committed、またはcancelled/failed。保留中の新入力があればcommitできない。
- intent: usage、itemRefs（最大40）、mode:'tool'|'environment'。toolには1件以上の有効な参照。environmentはサーバー設定で現在扱える場所・設備・観察対象のIDを必要とし、任意の能力を付与しない。写真トリガーでも他の手持ちと組み合わせられる。
- riskConfirmation: operationId、revision、対象・用途・具体リスク。許可は一致する提案だけに有効。訂正で失効し、単なる相づちを別提案の許可に流用しない。
- controlInput: user fragment参照、targetOperationId、arrivalRevision、status:'pending'|'keep'|'cancel'|'replace'|'unknown'。判定中の発話を新しい行動の実行根拠として無条件採用せず、制御用に保持する。分類は当該operationの確定前に終える。unknownや失敗なら古い行動を確定せず短く聞き直す。
- commit: operationの世代・操作権・状態版・revision、未解決制御入力なし、期限、許可状態、道具状態、許可遷移を再検証し、同期的に状態とresultIdを一度だけ更新する。結果画像と結果の発話はcommit後にのみ開始する。受付の短い相づちは結果を断定しない。
- 音声の再送と写真送信requestIdはそれぞれ既存の重複排除に従う。進行中operationと同じ要求を表す音声はそのoperationへ関連付け、二件目を予約しない。単なる道具・用途の文字列一致で、意図的な二回目の試行を禁止しない。

## 知識

- ScenarioKnowledgeEntry: id、localizedText、kind:'known'|'observable'|'hidden'、prerequisites（factKey/value条件のAND）、revealMode:'automatic'|'on_request'、requestCue（選択用の短い説明）、observationTargetId?。最大100件、id一意、参照先の存在をロード時検証。
- プレイ開始時にknownを開示。自動開示はコードで前提条件を検証。on_requestは現在条件を満たす候補のidとrequestCueだけを選択モデルへ渡し、返ったidをサーバーで再検証してlocalizedTextを開示する。見聞きの範囲・状態変更が必要な調査かも条件で区別。
- KnowledgeState: version、revealedIdsと開示根拠（initial/progress/request/observation）、Inference[]。未開示本文を一般公開stateへ含めない。会話の回答モデルも未開示本文を受け取らない。
- Inference: id、text、supportingKnownIds、status:'tentative'|'retracted'、updatedAtVersion。支持IDはすべて既知であること。モデルが勝手にconfirmedへ昇格できる列挙値を設けない。
- AcceptanceDecision: 物の同一性、認識revision、policyVersion、状況参照、accepted/rejected、短い理由。物や関連状況が変われば再評価可能。受信済み写真の再認識・拒否は送信数の返却を起こさない。
- CompanionContext: 公開の世界設定、既知・開示済み事実、推測、現在の道具・目標、検証済み結果だけ。mechanism、referenceSolutions、未開示mystery・direction、未許可の将来状態を含めない。
- JudgmentResult: 許可されたfact/inventoryの差分と成否・部分進展。秘密を知る判定器の自由文は発話へ転送しない。発話用の差分は現在成立した公開事実だけへ投影する。

## 時間警告と配送

- VoiceActivity: generation、sequence、input/output:'active'|'quiet'|'unknown'、playbackReady:boolean。時刻はサーバー受信時を使用。生音声・振幅列は送信しない。片側unknown、サンプル失効、AudioContext停止、再生blockedは静寂とみなさない。
- ブラウザ: 50msごとの分析、活動検出にヒステリシス、両側800ms静寂を候補にする。RMS開始0.02/終了0.01は暫定調整値。状態変化を最大毎秒4回、安定時heartbeat毎秒1回。音声保存なし。backgroundではunknown。
- WarningPolicy: 初期案は60秒通常、15秒最終。最終は3秒待機上限。閾値は降順・重複不可、待機上限は閾値より短い。旧timeWarningの単一閾値は通常警告へ正規化。新規設定は日英の切替表現を持つ。
- PendingNotice: id、kind、operationId?、revision?、generation、expiresAt、priority、payload。優先順は終了→中止/訂正→最終警告→行動結果→通常警告。結果は保持して後続配送、古い警告だけ棄却。通常警告が最終に追いついたら最終だけ。
- 2026-09-15の統合後: normal-warningは配送時にthinking.appendのtime_warningへ変換し、結果とは結合しない。final-warningはcommentaryへ変換し、待機中の結果との結合を維持する。通常警告のthinkingにも警告用expiryを付け、ブラウザで期限切れ・終了後の送信を防ぐ。
- 音声活動受信から2秒でstale。最終警告はunknownでも待機上限で配送を試みる。再生blockedでは聞こえたと記録せず、既存の再生再開UIと時間表示を維持する。
- outboxは配送前の通知待ち行列と区別する。発行直前に状態を検証、警告に有効期限を付け、ブラウザでも送信直前に世代・終了・期限を確認する。棄却したseqもackを進め、後続結果を詰まらせない。送信済みLiveの音声を取り消せるとは仮定しない。

## 設定と上限

共通許容方針と会話表現はconfig/game-core.json、舞台固有の条件と知識はscenarios/story-catalog.json。schemaVersionを上げ旧形式を明示的に正規化する。既存ScenarioSnapshotへ正規化済みコピーを保存する。許容方針だけで世界の物理制約を上書きしない。

operation同時実行1、制御分類同時1（新入力は最新版へまとめる）、再試行追加1、既存deadline/会話量/API上限を維持。制御分類のtimeout初期案5秒、処理が不明なら古い行動を中止し説明する。実際の訂正を未到着時刻へ遡って適用する保証はしない。
