# エンディングの状態と入力

Status: approved (2026-09-14)

## ゲームの確定情報

`GameSession`に完全解除したギミックIDの配列を持たせる。現在位置や文章から解除数を推測しない。通常・旧手動行動の両経路で、行動の確定情報を保存してから終了判定を行う。

```ts
type EndingOutcome = 'happy' | 'normal' | 'bad';
type GameEndReason = 'escaped' | 'time_limit' | 'action_limit' | 'interrupted';
```

既存`status`の`won / lost / expired`は互換性のため維持する。`won`はhappy。`lost`は完全解除数2以上でnormal、それ未満でbad。`expired`は中断であり通常の結末種別はnull。現在の3ギミック以外の設定でも全解除時のhappyを優先する。

## プレイごとの物語材料

`StoryEvidenceLedger`は表示用チャットの間引きと別に、プレイ中に提示した描写を保持する。登録元は開始説明、画面へ追加した状況・行動結果、受理済みのAI発話文字起こし。ブラウザから任意の伏線を新しく登録するAPIは作らない。

各記録は`sourceId`、`kind`、`order`、`generation`、`gameVersion`、`text`を持つ。音声は元の`eventId`と時間範囲も持つ。重複受信を排除し、再接続で旧会話の伏線を失わず、新プレイと混ぜない。1プレイのJSON表現を最大512KiB、10,000イベントに制限する。上限到達時に黙って序盤だけを落とさず、`truncated`を記録する。

`CommittedEndingAction`は行動ID、順序、ギミックID、用途、道具名と状態、前後のfacts、成功、narrative、解除の有無を保存する。全行動結果を使って結末を考え、直近最大2行動だけに前後の画像参照を付けて映像化の候補にする。保存数はシナリオの最大行動数以下。

`EndingPacket`は次を固定する。

- playId、シナリオsnapshot、locale、確定種別、終了理由、完全解除ID、残るギミック。
- 全行動結果と提示済み物語材料。提示内容はデータとして送り、ゲームfactsより優先させない。
- 終了時刻、最終gameVersion、対応するシーンのmessageId。画像は生成完了順で選ばない。
- 直近行動の前後facts、参照画像とそのgameVersion。画像がなければ行動前の姿を推測しない。

ゲームのfacts・結果は終了時に固定する。終了前に発生した音声の文字起こしが後着する場合は、既存の最大12秒の通話終了猶予内だけ追記し、脚本生成前に物語材料を凍結する。終了後の新しい発言を過去の伏線にしない。

画像素材は終了callbackで別途固定する。内部ジョブが、その時点で完成・検査済みの最新の場面画像1枚と、直近最大2行動に対応する行動前画像を保持する。`finalMessageId`の画像が未完成でも、同じプレイのより前の完成画像を使う。後着画像は追加せず、画像のgameVersionと終了時の確定gameVersionを制作入力で区別する。画像素材の選定は文字起こし猶予や動画の待機列に影響されない。

## 生成内容

`EndingDesign`は`title / story / evaluation`、採用した伏線sourceIdと行動ID、候補比較と選択理由、開始画像prompt、終了画像prompt、最終動画promptを持つ。表示文は選択言語、画像・動画promptは英語を使う。

物語材料の選別は本文を上限付きのチャンクに分けて行い、出典ID付きの伏線を抽出する。最大6回の抽出と1回の脚本生成。抽出内容は照合可能な原文参照を必須とし、存在しないIDを拒否する。候補比較は脚本生成1回の構造化出力に含める。種別・文字列・成否はサーバーで固定し、生成結果で上書きしない。脚本生成失敗時に舞台別固定文へ切り替えない。

## 公開する動画状態

```ts
type EndingVideoStatus =
  | 'disabled' | 'not_applicable' | 'queued' | 'preparing'
  | 'generating' | 'ready' | 'failed' | 'expired';
```

公開オブジェクトは`playId`、`outcome`、`clearedCount`、`status`、`errorCode`、`retainUntil`、`videoPath`（readyのみ）、`story`（完成済みの場合）を持つ。実APIキー、上流URL、上流応答本文、prompt、request IDを含めない。

内部ジョブには締切、キャンセル世代、試行数、submit開始済みフラグ、request ID、検証済みstatus/result/cancel URL、入力ハッシュを追加する。submit前のフラグ設定は同期的に行う。失敗・失効後に同じplayIdで新しいジョブを作らない。

遷移はqueued→preparing→generating→ready。途中からfailed / expiredへ遷移でき、終端から自動的にqueuedへ戻らない。disabled / not_applicableはAPIを呼ばない。

## 保持と配信

動画は検証したMP4をメモリで保持する。1動画最大24MiB、1結果最大32MiB、結果全体128MiB、終了プレイ最大10件。ダウンロード中の予約容量も計数し、同時受信で上限を超えないようにする。MP4の構造・尺・寸法・音声trackを技術検査するが、映像内容を評価したことにはしない。

既存の所有者照合を使って動画bytesのHTTP Range配信を行う。保持期限または容量制限で破棄した後は410とする。結果破棄で関連ジョブも失効する。再起動後の復元は行わない。
