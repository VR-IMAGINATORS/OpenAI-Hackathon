# 設定と通信データ

## Scenario（version 1）

id/title/premise/playerBriefing: 非空文字列。
rules: maxActions（整数1〜20）, maxPhotosPerAction（整数1〜2）, totalTimeSeconds（整数30〜3600）。
setting: location, characters（文字列配列）, constraints（文字列配列）。
obstacles: 1〜10個、id/title/situation/goal/constraints。idは重複不可、個数はmaxActions以下。
events: id/title/mode（required/optional/disabled）, eligibleObstacleIds, triggerCondition, timeLimitSeconds（整数10〜600）, maxOccurrences（整数1〜3）, onTimeout（description/additionalConstraint）。IDはunique、参照先は実在する障害。
ending: targetDurationSeconds（15）, generateOnFailure（true）。

公開投影: id/title/playerBriefing, obstacleCount, rulesのみ。具体障害/goal/内部制約はブラウザbootstrapに含めない。
JSONは起動/validateで検証。変更後はlocal再起動。ここではイベントを実行せず、時計も動かさない。

## Relay

認証モードrequired/none。required時は運営側passphrase必須。
セッション: ランダムopaque token、expiresAt、残り要求数。メモリ保存、失効時除去。
全体: プロセス起動以来の発行数/要求数（上限設定あり）。認証試行は固定窓の全体上限。
期限は時計の差し替え可能なテストを用意。noneも同一のtoken/上限制御を通る。
モック診断: kind=mock、固定メッセージ、接続したservice=relay。

triggerConditionはAI向け自由文。コード検証は障害参照と回数等の構造条件のみ。自然文の真偽の評価方法は後続設計。
