# データモデル（設計案）

Status: approved (2026-09-15)

## 固定原資料と候補

- SourceSnapshot: schemaVersion、sourceDigest、rawCatalogText、compiledOriginal、selection{sceneId,sequenceIndex,obstacleIds}、originalSections。原文を保持し、レポートで選択部分と共有設定を識別する。
- ExpansionCandidate: candidateId、revision、parentDigest|null、sourceDigest、originalInvariantDigest、openingOverview、expandedStory、knowledgeAdditions、displayOverrides、ambienceSlots、publicVisuals、changeMap。文章はja/en、各2000文字以下。全文は章配列で保持し切り捨てない。
- changeMap: source JSON pointer、expanded pointer、kind（retained/added/revised）、理由。参照実在を検証し、原文本文をモデル出力で置き換えない。
- 固定領域: 元のrules/障害IDと順序/goal・constraints・mechanism/完了条件/core factsと遷移/物理制約。入力・採用の双方で検証する。表示を削っても判定条件は削除しない。

## ゲーム知識

- InvestigationProfile（ScenarioV2の任意項目）: initialOverview、knowledgeMetadata、ambienceSlots、publicVisuals、sourceRef。
- knowledgeMetadata: knowledgeId、targetId、layer（overview/detail/hint/background）。既存のkind/revealMode/prerequisitesを維持。metadataは既存IDを必ず参照する。初期公開でないbackgroundは自動公開にできない。cueに秘密本文を複写しない。
- ambienceSlots: targetId、attribute、許容値または限定生成指示、攻略非関連性の根拠。成立性評価で検証し、任意の新しい属性をランタイムが作れない。
- KnowledgeState拡張: ambience{slotId,value,createdAtVersion,sourceRequestId}[]。推測inferencesとは別。最大30件。同じslotは上書き不可。知識versionとゲーム/会話versionが一致した場合だけ確定する。
- 公開射影: PlayerView / CompanionContext / PublicSceneContext は別allowlist。秘密のbackend判定理由、解法、制約全集、他プレイ、モデル評価はプレイヤーへ渡さない。

## 評価

- EvaluationManifest: runId、mode(mock/live)、sourceDigest、candidateDigest、revision、codeRevision+dirtyDigest、configDigest、promptDigests、catalogDigest、locale、rules、initiative、selectedModels、playMatrix、parentRunId、stage、budgets、pricingSnapshot。
- PlayRecord: playId、attemptId、model、persona、status（running/cleared/uncleared/incomplete）、terminationReason、turns、disclosureTrace、ambienceTrace、stateVersions、callIds。credits_exhausted等のゲーム終端はunclearedで理由を残す。API/保存/予算/壁時計上限はincomplete。
- Turn: index、playerRequest、publicReply、committedPublicEvents、publicStateBefore/After、traceRef。非公開診断は別領域で評価者のみ参照する。
- CallUsage: callId、role、modelRequested/Returned、playId|null、revision、status、reservedTokens/cost、inputTokens/outputTokens/cachedInputTokens/reasoningTokens（不明null）、duration、pricingRef。秘密のヘッダー/キーを保存しない。
- Review: reviewerRole/model、candidateDigest、playIds、feasibilityFindings、funScores（観点別1〜5またはnull）、evidenceRefs、suggestions。peer reviewを入力に含めない。
- VerifiedFinding: classification、evidence、counterEvidence、blocking、repairable。repairableはconfirmed_scenario_defectのみに制限する。
- AdoptionRecord: candidateDigest、sourceDigest、evaluationRunId、evaluationDigest、adoptedAt、outputPath。mockや3プレイのみを評価済みlive採用と混同しない。

## 状態遷移

frozen → expanding → static_check → pilot_running → pilot_reported（必ず停止）

pilot_reported → explicit_continue → remaining_running → reviewing → ready_for_adoption → explicit_adopt → adopted

confirmed_scenario_defect → repairing（2回まで）→ 新revision/static_check → awaiting_pilot（次の明示実行）

任意段階のAPI/予算等失敗 → incomplete。矛盾等の不備 → rejected。面白さは独立の評価であり状態遷移の合否条件にしない。途中playはresumeで再演せず、再試行は新attempt。候補・条件変更で旧成功結果を流用しない。
