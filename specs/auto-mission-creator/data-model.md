# 自動ミッション生成: データモデル案

Status: implemented。TypeScript/Zodの正本はtools/auto-mission/schemas.ts。本書の名前は内部契約の設計であり、現行Webゲームの公開APIではない。

## 入力

MissionConfig: schemaVersion、locale（初期ja）、world（premise/constraints）、difficulty、objectCatalog、referenceScenarios、models、limits。

- difficulty: maxPhotoSends、maxPhotosPerSend、maxActions:正整数|null、totalTimeSeconds、obstacleCount。
- objectCatalog: ID、名称、ordinaryProperties。リストは解法保証用であり別解を禁止するものではない。
- models: contractGenerator/storyGenerator/repairer/verifierをgpt-6-astraへ設定。初期実装の最上位allowlistはAstraのみ。評価者はphysics=Sol、resources=Luna、causality=Terra。同一役割の省略不可。未知モデルで最上位条件を自己申告させない。
- limits: maxRepairs（0〜2）、maxApiCalls、maxOutputTokensTotal、deadlineSeconds、requestTimeoutSeconds、各役割のmaxOutputTokens、maxInputBytesPerCall、maxConcurrentReviews（最大3）。

## 固定コントラクト

MissionContract: schemaVersion、inputDigest、world、difficulty、objectCatalog、locations、factDefinitions、initialState、orderedObstacles、escapeConditions。

FactDefinition: key、allowedValues、initialValue。条件は宣言済みkey/valueへの等値要求の配列（AND）。任意コードや自由な式は実行しない。
ObstacleContract: id、locationId、goalConditions、constraints。順序付きで2〜5個、初期3個。

world/difficulty/objectCatalogはモデル出力で差し替えず、入力値をコードで結合する。モデルが生成するlocations/facts/goals/初期状況を形式検査し、Astraの独立したcontract-checkで全体の矛盾・成立に必要な欠落を検証する。NGならストーリー生成へ進まない。正常化したJSONをdigest化して固定し、各出力には同digestを要求する。

## 候補と手順

MissionCandidate: revision、contractDigest、title、opening、obstacles（id/description/solutionExample）、ending、items、steps。

ItemInstance: id、catalogId、initialPlacement。候補内に宣言された具現化対象は最初unmaterialized。舞台備品はcontractの初期状態に宣言し、リストの道具が最初から都合よく置いてある状態にしない。
ItemState: phase（unmaterialized/held/placed/unavailable）、locationId|null、condition（usable/spent/broken）。初期はunmaterialized/usable。所在と消費状態は独立。

Step: id、obstacleId、kind、description、preconditions、itemIds、targetLocationId|null、factEffects、itemEffects、estimatedSeconds、timeRationale。

- kind: send / use / place / retrieve / move。
- send: maxPhotosPerSend以下のリスト内対象を具現化。コードが送信1回と数える。具現化場所と受け取り可否を説明する。
- use/place/retrieve/move: コードが各1行動と数える。複数の独立した操作を一つの手順の自然文へ隠すことはAI評価で指摘する。
- move: 次の場所へ移動する一動作。heldは一緒に移動、placedは元の場所に残る。設置物を持ち出すにはretrieveが必要。unavailable/spentを戻す操作は不可。
- actionCost/sendCostをモデルの自己申告値として使わない。カウントはkindから決まる。
- factEffectsは宣言済みkeyのfrom/to。fromは実行前状態と一致し、toは許可値でなければ不可。
- itemEffectsはkindに対応した合法遷移だけ。未具現化/遠方/使い切った道具をuseできない。使用後に壊れる等は明示。
- 全手順を順に適用し、各ギミックのgoalが成立してから次へ進む。終端は全goalとescapeConditionsを満たす。

## 評価・指摘

MechanicalResult: candidateDigest、checks（id/pass/fail/path/reason）、stateTrace、resourceTotals、estimatedTotalSeconds。
Review: role、candidateDigest、verdict（pass/fail/unknown）、summary、findings。
Finding: サーバー採番ID、role、blocking:boolean、category、targetPath、excerpt、reason、missingInformation。
Verification: candidateDigest、decisions（findingId/confirmed/rejected/unresolved、reason、evidencePaths、counterevidence）。

参照パス・引用の存在はコード検査、反証の意味的妥当性は検証モデルの評価。同一モデルでも生成と検証の会話状態は共有しない。全指摘にちょうど一つの判定が必要。機械検査failは検証役が棄却不可。unknownは必須確認の欠落として残し、多数決で消さない。検証役が新しいblocking問題を発見した場合も修正対象として記録する。

## 実行状態と保存

RunRecord: runId、parentRunId|null、mode、status、phase、failureCode|null、inputSnapshot、contract|null、contractCheck|null、revisions、calls、startedAt、endedAt|null。

statusはrunning/passed/failed。phaseはcontract/generate/check/review/verify/repair/finished。人間承認待ちはない。
FailureCode: CONFIG_INVALID / CONTRACT_INVALID / STORY_REJECTED / REVIEW_INCOMPLETE / API_ERROR / API_TIMEOUT / MODEL_UNAVAILABLE / OUTPUT_INVALID / BUDGET_EXCEEDED / INTERRUPTED / STORAGE_ERROR。

CallRecordはrole/model/requestedModel/responseModel/status/使用量/時間/上限予約/一般化したエラーのみ。APIキーや認証ヘッダーは保存しない。使用量不明を0とせずnullとする。保存するpromptは公開可能な固定指示と明示入力のみ。非公開の内部推論の取得を要求しない。

PhaseTiming: phase、revision|null、role|null、startedAt、endedAt|null、durationMs|null、status（completed/skipped/failed/aborted）、reason|null。比較には単調時計を使い、ISO日時は表示・追跡用。実行全体の経過と並列API時間の合計を区別する。未完了・未実施の所要時間を0の成功扱いにしない。

初期deadlineSecondsは600。目標180秒は表示・分析用であり、合否検査の省略や強制合格には使わない。生成手順内のestimatedSecondsはゲーム内動作の見積りであり、PhaseTimingのAPI実測時間とは別の値。

各revisionはcandidate/digest/checks/reviews/verificationを固定し、修正で上書きしない。JSONはtmp書込→同ディレクトリrename。SIGINTと通常例外では保存を試みるが、ディスク障害・強制終了後の完全保存は保証できない。HTML単体をJSONから再生成できる。

終端では全ギミックgoalとescapeConditionsが同時成立する。同一fact keyに異なるvalueを要求する契約はコード検査で拒否し、途中の場所への到達を目標にする場合は永続的な達成フラグを定義する。RunRecord.contractValidationにはこの機械検査結果を保存する（過去の保存結果との互換のため任意フィールド）。CallRecordのinstructionsDigest/inputDigestは固定した指示と正規化入力のSHA-256で、認証ヘッダーは含まない。
