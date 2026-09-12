# シナリオの編集

編集例は scenarios/default.json。これは構成確認用で、面白さを調整済みの完成シナリオではない。

1. JSONを編集、または別ファイルへコピーする。
2. `npm run validate:scenario -- scenarios/default.json` で検証する。
3. 別ファイルは .env.local の SCENARIO_PATH に設定する。
4. localサーバーを再起動する。プレイ途中の変更反映は本編で扱う。

| フィールド | 意味 |
|---|---|
| title/playerBriefing | 画面のタイトル/プレイヤー向け説明 |
| premise/setting | 物語の大枠、場所、人物、変えてはいけない制約 |
| rules.maxActions | 最大行動数。初期4。障害数以上 |
| rules.maxPhotosPerAction | 1行動の新規写真上限。初期2。持越品再利用の行動とは別 |
| rules.totalTimeSeconds | 全体時間。初期300秒 |
| obstacles | 順番のある障害と達成条件。道具の正解リストは作らない |
| events | 緊迫演出の候補。required/optional/disabledで採用方法を指定 |
| events[].eligibleObstacleIds | 発動可能な障害ID |
| events[].triggerCondition | AIへ渡す物語上の条件。自由文 |
| events[].timeLimitSeconds/maxOccurrences | 局所期限/回数上限 |
| events[].onTimeout | 攻略可能性を残す不利な変化 |
| ending | 初期の15秒動画・失敗時も生成という方針 |

ID重複、存在しない参照、範囲外数値、スペルミスなどを拒否する。スキーマは packages/shared/scenario.ts、仕様は specs/web-foundation/data-model.md。
構造が正しいことは、シナリオが解ける/面白いことを保証しない。自然文の発動条件や「必ず別解が残るか」は後続のAI評価と人間の試遊で検証する。

現在の画面に反映するのは公開概要と制限値のみ。JSONに書いた障害、イベント、時計、エンディングはまだ実行されない。
