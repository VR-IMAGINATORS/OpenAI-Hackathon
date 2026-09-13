# MiniMax H3：顔・台詞に頼らない演出とカメラワーク

追補：[文字・モーショングラフィックスをH3で同時生成する](typography-motion-graphics.md)。公式の画面内文字記法、同じTurbo I2Vの公開例、エンドタイトルの配置・動き・保持の指定を整理。エンドタイトルを採用する場合、文字の全面禁止を残さず、指定以外の追加文字だけを禁止する。

調査日: 2026-09-13。今回の優先資料。実写の手元・足元・背面・物・空間を対象に、観客へ情報を渡す順序を設計する。顔のアップ、表情芝居、台詞、ナレーションは前提にしない。特定プロジェクトの制作手順には依存しない。

目次: [出典](#1-調べた資料と使える部分) / [カメラの指定](#2-カメラの指定で分けるもの) / [演出14パターン](#3-用途で選ぶ演出14パターン) / [完成例](#4-顔も台詞も使わない完成プロンプト3例) / [作成と見直し](#5-エージェント用の作成と見直し)

**確認範囲**: 原文・作者の条件説明・投稿内の報告を確認。掲載動画の全編視聴、軌道やタイミングの計測、H3での再生成は未実施。以下の英語断片と完成例は独自作成で、実生成未検証。一般の撮影技法をH3への要求文にする案と、H3で作者が報告した実績を分ける。

## 1. 調べた資料と使える部分

### S1 — MiniMax公式：カメラ移動とカットの記法

[Video Prompt Writing Guide / 基本系](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)

移動の種類・幅・速さを、ショット内の自然文で書く。パンと横移動、ズームと前進、ティルトと上下移動を区別する。最初は `[Shot 1]`、次のカットから時刻を書く。カットは新しい情報を出すために使い、距離や角度の小さな変更ならカメラ移動も検討する。これは公式の文章形式であり、厳密な数値軌道を拘束するAPIではない。

### S2 — H3の同条件カメラ比較：成功扱いにしない項目もある

[wonderflex / Testing camera controls from official MiniMax prompt writing guide](https://www.reddit.com/r/StableDiffusion/comments/1vl07cw/testing_camera_controls_from_official_minimax/)

作者は標準ComfyUIのT2V、参照なし、同seed・設定で、移動幅と速さ、各移動、画角、トランジションを比較したと説明。POVは複数の書き方でも期待した視点にならず、cowboy shotも意図した画角ではなかったと報告している。元の題材はクレイアニメなので、実写での再現性の証拠ではない。

**利用法**: 技法名を選ぶための比較資料として有用。ただし名称だけで確実に動くと考えず、冒頭と終端の構図も書く。コメントのPOV成功例は、床のバッグを見下ろし、手がジッパーへ伸びるという画面内容まで指定している。これは別投稿者の単例である。

### S3 — H3の空間公開例：場所を移動しながら情報を見せる

[fal / MiniMax H3 Explained](https://fal.ai/learn/tools/minimax-h3-explained)

空になった屋内プールを進む例は、カメラの高さ、進む方向、途中にある物、最後に目を向ける壁面を具体化している。環境音には反響・水滴・照明器具の音が書かれている。

**利用法**: 人物を映さなくても「途中で何を通り過ぎ、最終的に何へ行き着くか」でショットを作る。記事の文字出現演出まで踏襲する必要はない。顔の代わりに空間の変化を情報にする。

### S4 — H3のドア通過テスト：複雑な接触は別問題

[MiniMax H3 is great but it still struggles with doors](https://www.reddit.com/r/StableDiffusion/comments/1vhu0k6/minimax_h3_is_great_but_it_still_struggles_with/)

投稿者は入室・ドアを閉める試行を、ハンドル操作や通過をどこまで指示する必要があるかを調べるテストとして紹介している。単純な移動語だけで接触動作まで解決するとは限らないことを示す問題報告として参照する。

**利用法**: ドアの開閉、人物の通過、カメラの通過を一度に要求する前に、誰が何を動かすかを分ける。実際の失敗原因をこの投稿だけで一般化しない。

### S5 — 実写撮影：移動を続けることの意味

[ARRI / Roger Deakinsインタビュー：The immersive camera movement of 1917](https://www.arri.com/news-en/the-immersive-camera-movement-of-1917-/193410-193410)

人物の移動へ途切れず同行する構成によって、観客がその時間と場所から離れない感覚を作るという撮影者の説明。長回しは技術を目立たせるためだけのものではない。

**H3への応用案**: 短いクリップでも、背面追従や足元追従を一つの到達点まで続ける。これは映画の演出原理を応用する案で、H3に同作の撮影精度を期待する根拠ではない。

### S6 — 実写撮影・編集：空間の連続性と奥行き

[Adobe / 180-degree rule](https://www.adobe.com/creativecloud/video/discover/what-is-the-180-degree-rule.html)、[Film Education Scotland / Foreground Middleground Background](https://filmeducation.scot/course/our-cinema/year-1-within-a-single-shot/foreground-middleground-background/)

Adobeはカメラを軸の同じ側に置くことで空間関係を保ち、意図的な軸越えと区別する。Film Education Scotlandは前景・中景・背景の配置や、その間の移動で画面を構成する課題を示している。

**H3への応用案**: 人物の顔がなくても、手の伸びる方向、歩行方向、物の左右をカット間で維持する。前景をただの飾りにせず、情報を隠す・奥行きを比較するために配置する。

## 2. カメラの指定で分けるもの

### 画角・視点・動作・ピントは別の指定

「ローアングルのクローズアップ」は位置と画角。「横へ移動する」は軌道。「奥へピントを移す」は注目対象の変更。この三つを混同しない。

| 指定 | 意味と書くべき終点 |
|---|---|
| Push in / Pull out | カメラが前進・後退。何に寄るか／何が新たに画面へ入るか |
| Zoom in / out | カメラ位置を変えず画角を変える。移動による前景のずれは目的にしない |
| Pan / Tilt | その場で左右／上下を向く。どこで止めるか |
| Truck / Pedestal | 本体が横／上下へ動く。どの遮蔽物を越えるか |
| Tracking / Arc | 対象に同行／対象の周りを回る。距離と見える側を指定 |
| Static | 位置・画角を固定。被写体や物だけを動かす |
| Rack focus | ピントの送り。カメラ移動や被写体移動と区別する一般撮影技法 |

移動語の区別はS1、ピント送りの演出例は本資料の提案。POV、ロール、揺れもS1に記載があるが、必要な場合だけ追加する。

### 使い回せる記入枠

```text
Opening: {visible objects, frame boundaries, foreground and background}.
Viewpoint: {height, side, angle, distance from the subject}.
Camera path: {movement, direction, range, pace, trigger}.
Subject motion: {what moves independently of the camera}.
Focus: {what must remain readable; optional focus change}.
Reveal: {information hidden initially; when and how it becomes visible}.
Ending: {final composition and a short readable hold}.
Continuity: {screen direction, fixed geometry, object state}.
Sound: {physical cue, timing, source direction; no voices}.
```

数値の高さや距離は演出上の目安。実測した軌道として報告しない。顔を出さない場合は、単に「顔なし」ではなく「上端は肩より下」「背面のまま横顔が見える側へ回らない」など、構図の条件にする。

## 3. 用途で選ぶ演出14パターン

以下は独自作成の短いプロンプト断片。S1・S5・S6等を土台にした撮影設計で、個々のH3成功例ではない。必要なものを選び、一つの短い動画に全部詰め込まない。

### 01. 寄りから引いて、物の意味を変える

**用途**: 物の詳細→それが置かれた状況。最初は鍵だけ、最後に開かない扉との関係が分かる、など。

```text
Begin close on a brass key on the floor. Slowly pull back until the key, the closed door and the gap beneath it share the frame. Stop moving and hold the wider composition.
```

**注意**: ズームアウトと後退を混ぜない。引いて初めて現れる部分にも、床・壁・物の位置を指定する。

### 02. 前景の横から、隠れた物を見せる

**用途**: 棚・柱・机の陰にある情報を遅れて公開。

```text
A shelf edge blocks the right half of the view. Truck slowly left until a metal box behind the shelf becomes fully visible. The shelf stays fixed; the camera passes beside it, never through it.
```

**注意**: 見せたい物が後から出現するのではなく、最初から遮蔽物の奥にあると書く。移動方向で実際に見える配置か確認する。

### 03. 足元へ並走して、進行を見せる

**用途**: 距離、路面、障害、立ち止まる場所。

```text
Track beside a pair of boots at ankle height as they move from left to right. Keep the frame below the knees. Match their walking speed, then settle as both boots stop before a puddle.
```

**注意**: カメラの移動と足の歩行を別々に指定。靴の滑り、停止後も続くカメラ移動を確認する。

### 04. 背中から同行して、目的地へ到達する

**用途**: 探索、廊下の移動、狭い場所への接近。S5の同行する時間の考え方を短尺へ応用。

```text
Follow two metres behind the person, showing only their back as they approach the end of the corridor. Keep the doorway ahead readable. Do not arc around them. Stop before crossing the threshold.
```

**注意**: 振り返りや周回を追加すると顔が見える。カメラが追い越すか、どこで停止するかを決める。

### 05. 俯瞰固定で、作業の因果を見せる

**用途**: 部品の配置、工具、鍵、手順、比較。

```text
Use a locked top-down view of the work surface. Only forearms and hands enter from the bottom edge. One hand holds the plate still while the other slides the pin into the visible slot.
```

**注意**: 手が作用点をずっと隠すなら、先に配置か角度を修正する。俯瞰を途中で斜めへ変えない。

### 06. 手元の主観視点で、対象との距離を示す

**用途**: 箱を調べる、手を伸ばす、道具を使う。

```text
Look downward from the person's own eye position at the box on their lap. Only their hands and knees enter the view. The right hand reaches from the lower-right edge toward the lid latch.
```

**注意**: POVだけで済ませない。S2では不成立の報告もある。対象・手が入る辺・見下ろす角度を明示し、第三者カメラとの混在を避ける。

### 07. ピント送りで、画面内の注目先を変える

**用途**: 手前の物から奥の変化へ、カットなしで注意を移す。

```text
Keep the camera fixed. A loose screw is sharp in the near foreground while the door latch behind it is soft. As the latch starts moving, shift focus from the screw to the latch. Nothing changes position except the latch.
```

**注意**: 全域を鮮明にする指示とは併用しない。ボケているだけなら、奥の情報を完全に隠せるとは限らない。

### 08. 音を先に出し、その音源へ向く

**用途**: 画面外の出来事を予告してから見せる。

```text
Hold on the empty tabletop. A single metal tap sounds off-screen to the right. After a short pause, pan right to reveal a hanging chain touching the cabinet. End with the contact point visible.
```

**注意**: 音・パン・到達点を同じ方向関係にする。後付け説明音声は不要。

### 09. 固定画で、人が去った後を残す

**用途**: 通過、置き去り、時間の経過、残された物の強調。

```text
Hold a locked waist-down shot of the doorway. The person exits frame left, leaving a wet footprint and a small bag. Do not follow them. Hold the now-empty doorway for the final two seconds.
```

**注意**: 常に人物を追わせない。動かないカメラも、何を残して見せるかを選ぶ演出。

### 10. 作業中に切って、同じ動きをつなぐ

**用途**: 手を伸ばす全体→接触する手元。操作が一回だけ行われたと伝える。

```text
Cut while the hand is still reaching toward the lever. The close shot continues the same reach from the same screen direction, then shows the fingers closing around the handle once.
```

**注意**: 次のカットで手が元へ戻る、既に終わった操作を再実行する、左右が反転する、を確認。切替時刻だけでなく切替時の物の状態を書く。

### 11. 原因と結果の寄りをつなぐ

**用途**: 押す→機構が動く、糸を引く→離れた物が変化する。

```text
Show the thumb pressing the switch fully down. Cut to the connected bolt withdrawing from its socket. Keep the switch click continuous across the cut, followed by the bolt's scrape.
```

**注意**: 二つが無関係な物に見えないよう、広い画で位置関係を先に示すか、線や機構の接続を画面内に残す。

### 12. 前景で一瞬隠し、カットを目立たなくする

**用途**: 同じ動作を別角度へつなぐ編集案。

```text
The camera passes close behind a dark pillar until it fills the frame. Cut during the full occlusion. Continue the same rightward movement beyond the pillar, preserving the room layout and travel direction.
```

**注意**: 遮蔽を使った編集と、モデルのワンショット生成は別。H3が継ぎ目を正確に作れると保証しない。確実な接合が必要なら編集時の判断に回す。

### 13. 上へ移動し、配置全体を明らかにする

**用途**: 一つの部品→それを含む配置、障害や通路の関係。

```text
Begin just above the tabletop edge, with the front rim blocking the far side. Raise the camera slowly while keeping the lens angled toward the table, revealing the complete arrangement beyond the rim.
```

**注意**: ティルトだけでは遮蔽物の向こうは見えない。カメラ位置の上昇と向きの調整を区別する。

### 14. 小さく回り込み、横の構造を見せる

**用途**: 物の厚み、接続、裏へ回る線、障害物との隙間。

```text
Move through a short arc around the left side of the machine, keeping its base near frame centre. End at a three-quarter side view where the cable connection becomes visible. Avoid a full orbit.
```

**注意**: 見えなかった側の形状をモデルが補う。構造が重要なら別角度の参照を用意する。必要な情報が見える角度までで止める。

## 4. 顔も台詞も使わない完成プロンプト3例

すべて独自作成・未生成。画角は16:9を想定。尺は利用APIの設定にも反映する。BGMなしはこの例の選択であり、全制作の必須条件ではない。

### A. 棚の横から、箱を発見する — 8秒・一つの移動

使用パターン: 02。人物を出さず、カメラの位置が変わることで情報が増える。

```text
integrated_multimodal_description: [Shot 1] Photoreal live-action interior. From a low viewpoint in front of a storage shelf, its thick right-side vertical panel occupies most of the right half of the frame. Dusty floorboards extend behind it. A small metal box already rests on those boards, hidden behind the panel. During the first six seconds, the camera trucks slowly left through open floor space until the line of sight clears the panel and the entire box is visible. The shelf and box remain stationary. A narrow beam from an off-screen window grazes the box lid. Stop the lateral movement and hold the final view for two seconds. One continuous shot, fixed focal length, no zoom, no people.

overall_soundscape: Low indoor air noise and a faint wooden creak. No speech, narration, singing or background voices.

non_diegetic_music: N/A
```

設計確認: 棚と箱の位置関係が、左への移動で実際に見えるものになっているか。箱が途中で出現していないか。

### B. 足元から手元へ、操作と結果をつなぐ — 12秒・3カット

使用パターン: 03、10、11。顔を出すためのカットはない。

```text
integrated_multimodal_description: [Shot 1] Naturalistic live-action footage in a workshop. Track beside work boots moving left to right at ankle height. The frame remains below the knees. The boots stop beside a low metal cabinet. [Shot 2] At 00:04.000, cut to a close side view of a gloved hand reaching from frame left toward the cabinet lever on frame right. The hand grips and lowers the lever in one continuous movement. The cabinet stays fixed. [Shot 3] At 00:08.000, cut to the cabinet's locking bolt as it finishes sliding out of its socket, continuing the same mechanical operation. The door remains closed, with the withdrawn bolt and empty socket both clearly visible. Hold for the remaining time. No faces, no change of gloves or cabinet design, no repeated lever pull.

overall_soundscape: Measured bootsteps stop before the lever scrape. A metallic click bridges the last cut, followed by the bolt sliding. No voices or narration.

non_diegetic_music: N/A
```

設計確認: レバーとボルトが同じ機構だと読める外観にする。カット後も同じ操作が続くこと、閉じた扉と解除状態を混同しないこと。

### C. 固定画の奥で起こる変化 — 10秒・人物なし

使用パターン: 07、08の音先行。カメラを動かす代わりに焦点と音で情報を選ぶ。

```text
integrated_multimodal_description: [Shot 1] Photoreal live-action view across a table toward a closed door. A key lies in sharp focus at the lower-left foreground. The door handle is visible but softly out of focus in the upper-right background. The camera and focal length remain fixed for the entire ten seconds. At three seconds, a faint mechanical tick comes from the door. During the next two seconds, focus shifts from the key to the handle. Only after the handle becomes sharp does it rotate slightly downward, pause, and return to its original position. The door never opens. Hold the sharp handle through the final two seconds. No people or reflections of faces appear.

overall_soundscape: Soft room tone, one small mechanical tick, then the restrained movement of the door handle. No whispering, speech, narration or singing.

non_diegetic_music: N/A
```

設計確認: ピント送りがズームや物体移動になっていないか。鍵とドアの因果関係まで断定する映像ではなく、注意を奥へ移す構成として扱う。

## 5. エージェント用の作成と見直し

1. **見せる順序を一文で決める**: 例「最初は足元しか分からず、止まった先の操作とその結果が分かる」。感情語から始めなくてよい。
2. **構図を三つ記す**: 冒頭／情報が変わる瞬間／終端。各時点で、何が見え、何が画面外・遮蔽・ボケにあるかを書く。
3. **手段を選ぶ**: 対象の動き、カメラ移動、ピント、カット、音のどれが情報を変えるのかを明確にする。
4. **軌道を成立させる**: 壁・棚・ドアを通り抜けない。周回で顔を見せない。固定物をカメラと一緒に移動させない。
5. **カット前後を照合する**: 進行方向、手、物の数、接触点、操作の途中状態。空間関係を変える場合は意図を記す。
6. **読める終わりを置く**: 最後に何が判明するかを保ち、唐突な暗転や新しい動作で終わらせる必要があるか判断する。
7. **結果を別々に評価する**: 構図／軌道／情報の順序／物理的つながり／不要な顔・声の混入。生成成功と演出成功を区別する。

未検証の表現を「H3の専用コマンド」「必ず効く語句」と扱わない。数値のタイムコード、距離、レンズ名は要求であり保証ではない。失敗時には画角・軌道・被写体の動作を同時に変更せず、主な修正要因を一つ選んで記録する。
