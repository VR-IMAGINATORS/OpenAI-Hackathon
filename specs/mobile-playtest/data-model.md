# データモデル

## GameSession (localのみ)
- id: UUID、ownerTokenHash: SHA256、generation: 非負整数。
- status: joining | briefing | playing | judging | won | lost | expired。
- scenario: Scenario、obstacleIndex: 0..obstacles.length-1、actionsUsed: 確定行動数（ゲーム上限なし）、photoSendsUsed: 0..maxPhotoSends。詳細は [写真送信回数の制限](../photo-send-limit/spec.md)。
- inventory: {id:UUID,name:string,description:string,status:available|damaged|consumed}[]、最大40。
- situation: string（最大2000文字）、photos: {id:UUID,jpeg:Buffer}[]（1枚2MiB以下、最大設定枚数）。
- proposal: {revision:整数,items:{photoId:UUID|null,inventoryId:UUID|null,name:string}[],usage:string,summary:string}|null。
- clock: remainingMs, lastTickMonotonicMs, pauseReasons:Set, waitingBudgetMs=60000。
- live: {id, generation, connected, lastHeartbeatAt}、relayTokenは非公開。
- actionResults: Map<UUID,{requestHash,status:pending|failed|complete,result}>。1プレイ内最大100要求。違うpayloadで同IDは409。

## AI結果
認識: items/usage/summary（文字列上限各1000、items最大40）。localがphotoId/inventoryIdを検証。提案のrevisionはAIに生成させない。
判定: success:boolean,narrative:string（最大2000）,situation:string（最大2000）,inventoryChanges:{id,status,description}[]。
AIはobstacleIndex/actionsUsed/時計/statusを返せない。localで現在障害だけを最大1つ進める。新規物は今回の写真認識からlocalがID付与して生成。任意の物の追加は不可。

## 公開状態
ownerTokenHash/relayToken/生写真/秘密シナリオgoal/内部promptは含めない。現在障害の公開title/situation、proposal、inventory、status、残行動、残時間、revision、lastResultだけ返す。

## 招待/所有
inviteHash、有効5分、未使用のみ。claimは単一owner発行、所有cookie期限15分。全変更操作は完全一致Originとowner照合。終了後の新規プレイはPC管理から新規招待を発行。
管理tokenはゲームtokenと別。管理portは127.0.0.1:4312のみ。

## 順序
写真/発言変更→proposal invalid→認識結果検証→revision更新。
commit→snapshot保存/lock→AI→検証→state更新/行動消費→result保存→lock解除。
不正結果/通信失敗→failed保存/消費なし→lock解除。同じID再送は失敗結果を返し、明示再試行は新しいID。
終端状態への遷移時に画像・会話・Liveを破棄し結果の短文のみ管理画面に残す。再起動で全て失効。
遅延判定は適用直前にsession id/generation/pending actionId/非終端を再照合。終端化はgenerationを増やしpending無効化。古い完了を破棄し消費しない。無効化されたaction再送は410。
