# 物語、動画、リザルト

終端になったらending-packetから、初期伏線、各行動と成否、残った道具、確定した種別を読む。秘密の種別とタイトルはまだ会話に出さない。

1. 15秒で伝わる結末を作る。0〜5秒は直後の状況から動き出し、5〜10秒は人物の移動や大きな動作、10〜15秒は変化した場所・状況と未来と過去のつながりを示す余韻。なぜ監禁されたか、黒幕がどんな人物かを初期伏線に結び付け、輪郭がぼんやり分かる程度に補完する。実際の行動、既に提示した事実、解除数と矛盾させない。
2. happyは未来の自分が脱出し着信が静かに切れる。normalは危機を部分的に回避して救援の兆しが残る。badは脱出できないが別の時間への信号など曖昧な余韻を残す。流血・死の断定を必須にしない。
3. `title`、`story`、`evaluation`の3つの文字列を持つstory.jsonを保存し、`attach-story --story-json ...`で履歴へ登録する。次に直前の結果画像と同じ人物/衣装/空間で開始・終了フレームをnative imagegenから生成する。両方のサイズ・縦横比を揃え、事前に閲覧。顔は背面・遮蔽・口元以下で全編を計画する。終了フレームを`attach-ending`で保存し、開始・終了の実ファイルはH3のprepareへ渡す。
4. h3-cli.mdのprepareで、開始/終了画像、UTF-8動画プロンプト、15秒768P1本、最新の価格・円換算から確認可能なプランを作る。H3へ送るのはこの生成フレームで、元の実物写真を自動送信しない。
5. プランの素材画像、プロンプト全文、条件、USD/JPY概算、価格確認日と出典、動画料金にはCodex利用分を含めない旨を提示し、この1本の送信を承認してもらう。既存の具体的な承認が一致する場合は再確認しない。approveは承認の記録であり承認の取得を代替しない。
6. submitは一度だけ。request IDを保存してstatus/resultから回収する。同梱QCと視聴により尺、再生、音、人物/空間、顔の露出を確認。不明時に新しい枠を作って再送しない。抽出12フレームの確認だけで全編を確認済みとは書かない。回収した動画を`attach-video`で登録する。liveでは`--h3-run`と`--receipt`も渡し、承認・request ID・素材・動画の照合を通す。具体的な引数はcli.mdとh3-cli.mdを読む。
7. 動画をユーザーへ表示した後、mark-video-shown→result。エンド種別・タイトル、3つ中の解除数、4回中の行動数、実際の工夫を1〜2文で評価する。同じ設定/別の設定でリトライを案内する。

## 動画プロンプト

### 全エンド共通：開始と終了を大きく変える

開始・終了フレームの差を大きく設計することが標準要件。小さな手の動き、傷の追加、弱い発光だけで終わらせない。人物・衣装・空間のつながりを保ちつつ、人物の位置や姿勢、カメラ位置・画角、見える場所、照明や環境状態のうち複数を明確に変える。まず両フレームを並べて差が伝わるか確認し、その間を15秒でつなげられる移動・動作をプロンプトに書く。移動距離が大きすぎる場合は場所を近づけるか、明示したカットで接続する。単なるディゾルブや不連続な瞬間移動で差を作らない。

| 種別 | 大きく変える構成例 | 守る結果 |
|---|---|---|
| happy | 暗い室内から階段を上がり、外への扉を押し開けて明るい屋外へ出る。背後の追従カメラも移動する | 脱出成功 |
| normal | 危機のある室内から、実際に通れる範囲の高窓や格子へ移動し、大きく合図する。外の救援灯や近づく人影が空間を変える | 部分的回避・救援の兆し。未解除の出口から脱出させない |
| bad | 迫る足音や影から壁際へ後退し、道具で大きな痕跡を残す。カメラが人物の背後から壁の痕跡へ回り込み、最後に近づく影と暗転の予兆を描く | 脱出失敗。残る拘束があれば移動範囲をそのまま守る |

これは固定の映像テンプレートではない。履歴に応じた行動を選び、全身移動できない結末では大きな上体動作、カメラ移動、周囲の変化を使う。映像差のために新たな解除・道具・脱出成功を勝手に追加しない。

```text
15-second cinematic 3D mystery game ending, matching both reference frames.
[0-5s: 確定した直後の状況から動き始める]
[5-10s: 履歴に合う大きな人物動作・移動と、それを追うカメラ]
[10-15s: 開始から大きく変わった構図・場所・環境で、確定エンドに合う余韻]
Make the transition visibly dynamic and physically coherent. Clearly change the character
pose and framing, plus location within the established space or environmental lighting.
Specify the actual action connecting both frames; no static hold, dissolve or teleportation.
Same androgynous adult, charcoal hooded jacket and gray trousers. Keep the camera behind
the person or below mouth level throughout; never reveal eyes or a full face.
Purposeful tracking camera with stable readable motion. Ambient sound and physical sound effects, no spoken dialogue,
no title text, no ending labels, no subtitles, no gore. No change to the recorded outcome.
```

## 失敗や費用辞退

未生成を正直に記録して再開する。利用者が明示的に文章版を選んだ場合はwaiveして結末とリザルトを表示できるが、「15秒動画まで通し合格」は未達のまま。物語や動画を作り直しても、確定済みゲーム状態を変更しない。
