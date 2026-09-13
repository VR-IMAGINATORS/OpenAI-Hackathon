# 実写ドラマ向け作例：台詞なしの芝居

現在の優先資料は [顔・台詞に頼らない演出とカメラワーク](cinematography.md)。このファイルの顔・表情の作例は以前の調査として残し、今回の制作条件にはしない。

調査日: 2026-09-13。特定プロジェクトの手順には依存しない。台詞・ナレーション・口パクの作例は対象外。環境音・効果音は使えるものとして扱う。BGMの可否は別条件であり、台詞なしと同義にはしない。

公開投稿のプロンプト本文・制作説明を確認した。掲載動画の全編視聴・音声確認・再生成は未実施。「作者が生成結果とともに公開した文」と「こちらが新たに書いた応用例」を区別する。

## 1. 公開プロンプトと制作例

### A. 日常の動作から、画面外の相手への反応へ

**出典**: CompleteJicama2811「The MINIMAX H3 is awesome.」— [作者の投稿・プロンプト](https://www.reddit.com/r/StableDiffusion/comments/1ve4f2l/the_minimax_h3_is_awesome/)

作者申告はI2V、bf16、1920×1088。5秒のプロンプトで、スイカを食べる女性と和室の開始画像を維持する。本文には次の順序が指定されている。

| 時間 | 指定されている芝居 |
|---|---|
| 0〜1.5秒 | 小さく一口かじり、両手で支える |
| 1.5〜3秒 | 咀嚼し、目元が和らぐ |
| 3〜4.2秒 | 画面左の人物に気づき、目が先、頭が後に動く |
| 4.2〜5秒 | 画面外の相手へ微笑みを保つ |

作者の原文抜粋:

> Her eyes shift toward the left first, followed by a slow and subtle turn of her head.

カメラは固定。発話とカメラ目線を避け、音は夏の室内・庭の虫・小さな咀嚼音に限定している。

**応用上の読み取り**: 「嬉しそう」だけでなく、動作 → 気づき → 視線 → 頭 → 表情の順で書く。相手を画面外に置けば一人の芝居でも関係性を作れる。単に微笑むポートレートから、相手に反応する短い場面へ変わる。これは本文からの演出分析で、成功率の比較結果ではない。

### B. カップの受け渡しから感情を見せる

**出典**: amida168「MiniMax H3 GGUF in ComfyUI: T2V & I2V Guide」のText-to-Video Example — [作者の手順・原文・出力リンク](https://www.kombitz.com/2026/08/04/minimax_h3_gguf_in_comfyui_t2v_i2v_guide/)

6秒のカフェ広告例。受取カウンターへ歩く → 両手でカップを受ける → 飲む → 目を閉じて味わう → 商品の寄り、という構成。台詞なしの指定がある一方、音声欄には店内の会話音が含まれる。

**応用上の読み取り**: ドラマでは受け渡しと反応だけを取り出せる。例えば「受け取りかけて手が止まる」「相手が手を離した後も両手で包む」など、小道具への接し方を感情の根拠にする。

**そのまま流用しない点**: 6秒に多数の動作・カメラ・商品カットが詰まった広告用の文である。静かなドラマには動作を減らし、受け渡し後の間を増やす。声を完全に除くなら店内の会話音も削る。この記事の手順全般を検証済みとして推奨するものではない。

### C. 車内・複数人物の連続性は、参照準備まで含めて設計

**出典**: diagonal_1「Made a 15-second cinematic road movie with MiniMax H3」— [作者の制作メモ](https://www.reddit.com/r/MiniMax_AI/comments/1vxs8q6/made_a_15second_cinematic_road_movie_with_minimax/)

作者は人物の多方向資料、衣装、車の外観4方向、固定した4座席の内装、ショット別キーフレームの準備を記している。狙いは人物・服・車体・車内の変化を抑えること。取得できた本文には完全な生成プロンプトはないため、原文作例ではなく準備方法の事例とする。完成映像が台詞なしであるとは確認していない。

**応用上の読み取り**: 台詞のない二人のドラマでも、「誰がどこにいるか」が揺れると視線の意味が変わる。複数ショットなら、席、画面左右、視線の先、手元の物をメモし、参照素材にも同じ配置を反映する。顔だけの資料を増やして車内配置まで固定できるとは考えない。

### D. 周囲から意識が離れる芝居と、音声混入の失敗例

**出典**: DoubleChillStudio「MiniMax H3 ref2va. Gibberish at start of audio」— [作者の条件・原文・問題報告](https://www.reddit.com/r/comfyui/comments/1vtp02j/minimax_h3_ref2va_gibberish_at_start_of_audio/)

5秒のRef2VA例。川沿いの三人から一人の顔へ寄り、周囲をぼかし、川の音も遠くなるように指定している。作者はint8とTurbo LoRA、8 steps等の条件を明記し、台詞なし・BGMなしの指定があるのに冒頭へ意味不明な声が入ると報告した。

**応用上の読み取り**: 顔の芝居だけでなく、ピントと聞こえる環境の変化で主観を表現する発想が参考になる。ただし、この例は無声化の成功例ではない。コメント欄の修正提案も、解決確認済みとは扱わない。

## 2. エージェントが再利用する演出単位

以下は上記作例を起点にした独自の設計指針。H3固有の実証済み法則ではない。

| 伝えたいこと | 画面内で起こす出来事 | カメラ・音で補う点 |
|---|---|---|
| 気づき | 動作を止め、目が動き、頭が少し追う | 視線の先を決め、何に反応したか分かる音を先行させる |
| ためらい | 手を伸ばし、触れる直前に止め、ゆっくり引く | 手と対象を同じ画角に残す |
| 緊張がほどける | 握っていた指が緩む、肩が少し下がる | 大きく笑わせず、変化後の間を残す |
| 距離が縮まる | 同じ物に視線を向け、受け渡しが成立する | 二人を同じ画面で見せるか、左右・視線を保って切る |
| 不在・喪失 | 物を置いた後、空いた席へ目が向く | 空席が読める画角を保ち、説明の文字を入れない |
| 警戒 | 音の後に手が止まり、見つめるが近づかない | 音源の方向と人物の反応方向を一致させる |

実写感はカメラ機種名だけに任せない。どこから光が来るか、目と手が読めるか、物に重さがあるか、布や髪が動作に遅れて動くかを具体化する。焦点距離を指定しても、厳密な光学再現が保証されるわけではない。

一つの瞬間へ「涙・微笑み・目の震え・嚥下・唇の震え」を全部詰めない。主となる変化を選び、必要なら他の変化を順番に置く。「大げさな演技をしない」に加え、実際にする小さな動作を書く。

## 3. 台詞なしの応用プロンプト

以下の三例は**今回の独自作成・未生成**。公開原文の転載・翻訳ではない。すべてテキスト起点の基本三フィールド形式なので、画像を使う場合はその画像の姿勢・構図に合わせ、[基本ガイド](README.md)から画像整合の指定を追加する。尺と縦横比は利用APIにも設定する。

### 作例1：玄関の鍵の音に気づく — 8秒・固定・一人

狙い: 待っていた人が帰ってきたことを、姿を見せずに伝える。Aの反応順序を応用。鍵の音→手の停止→視線→小さな安堵が読めるかを確認する。

```text
integrated_multimodal_description: [Shot 1] Naturalistic live-action domestic drama. An eye-level medium close-up shows a woman in a grey cardigan seated at a kitchen table at dusk. Her hands wrap around a ceramic mug. Soft window light comes from frame right; the hallway is beyond frame left. The camera remains locked throughout the eight-second shot. She slowly rubs the mug handle with her thumb. At about two seconds, a key turns in a lock off-screen to the left. Her thumb stops. Her eyes move toward the hallway before her head follows slightly. After a brief pause, her grip loosens and the corners of her mouth lift almost imperceptibly. Hold this quiet reaction for the final two seconds. She never looks into the lens or forms words. The mug stays supported on the table.

overall_soundscape: Low refrigerator hum, one distant key turning, then a soft latch click. No speech, narration, singing or background voices.

non_diegetic_music: N/A
```

### 作例2：差し出された手袋 — 12秒・二人・受け渡し

狙い: 気まずい二人の関係が少し和らぐ。Bの物の受け渡し、Cの配置維持を応用。大きな表情変化より、手袋を受け取るまでの間で見せる。

```text
integrated_multimodal_description: [Shot 1] Live-action winter drama at an empty bus shelter. A woman in a navy coat sits frame left; a man in a brown coat sits frame right. They face forward with a small gap between them. A steady eye-level medium two-shot includes their faces and hands. Soft overcast light keeps both faces readable. He notices her rubbing her bare hands. He takes a pair of grey gloves from his coat pocket and offers them across the gap, holding them by the cuffs. She looks at the gloves, then briefly at him, without reaching immediately. [Shot 2] At 00:07.000, cut closer from the same side of the bench, keeping her left and him right. She takes the gloves with both hands; he releases them only after she has a firm hold. Her shoulders relax slightly. They look toward the road together for the remaining seconds. Their mouths remain relaxed, without speech-like movement.

overall_soundscape: Light wind against the shelter, coat fabric moving, and distant tires on damp asphalt. No voices, announcements, narration or singing.

non_diegetic_music: N/A
```

### 作例3：廊下の奥のドアノブ — 10秒・無言のサスペンス

狙い: 不安を顔の誇張ではなく、音、動作の停止、奥行きで示す。独自の演出案。人物とドアの関係を同じ画角で読ませ、原因不明の表情だけにしない。

```text
integrated_multimodal_description: [Shot 1] Restrained live-action suspense in an ordinary apartment corridor at night. A waist-up side view places a man holding a folded towel in the left foreground. A closed door remains clearly visible at the far right end of the corridor. One ceiling light casts soft, uneven shadows. Keep enough depth of field to read both the man and the door handle. He starts to fold the towel. At three seconds, a faint metallic click comes from the door. His hands stop midway. His eyes move toward the handle, followed by a small head turn. The handle slowly rotates a little, then returns. He tightens his fingers around the towel and stays where he is. The camera makes a very slow, short push forward while keeping the handle visible. End with the door still closed. No one speaks or appears behind the man.

overall_soundscape: Quiet ventilation, the towel's soft rustle, a single handle click and its restrained mechanical return. No voices, whispering, narration, vocal effects or singing.

non_diegetic_music: N/A
```

上の例は芝居を読み取りやすくするためBGMなしにしている。BGMを使う場合も、歌声や語りを入れず、無言の間を音楽で埋める必要があるかを個別に判断する。

## 4. 台詞なし専用の見直し

- 「無言」を口パクに置き換えない。話者ID、台詞ブロック、独白、歌詞を追加しない。
- カフェ・駅・テレビ・ラジオなどから入る背景の声も必要に応じ除外する。残したい環境音は具体的に書く。
- 呼吸、瞬き、食べる動作まで一律に固定しない。口を閉じ続ける指定が食事の芝居と衝突しないか確認する。
- カメラ目線が不要なら、視線の相手と方向を明示する。複数カットでは人物の左右や相手を見る方向を照合する。
- 結果確認では「芝居が伝わる」「人物・物が維持される」「余計な声がない」を別々に判定する。音楽なし指定だけで声が消えたとみなさない。
- 公開作例の長い禁止リストを丸ごと加えない。今回の芝居に必要な保持条件と動作の自由度を両立させる。

次の生成担当へは「このファイルのA〜Dから参考にした点、選んだ芝居の変化、実際の参照素材、独自に加えた演出」を短く残す。公開例との一致や実生成成功は未確認のまま記録しない。
