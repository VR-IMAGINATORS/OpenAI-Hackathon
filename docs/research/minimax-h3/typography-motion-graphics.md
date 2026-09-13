# H3でエンドタイトルとモーショングラフィックスを同時生成する

調査日：2026-09-13。公開された記法とプロンプトを確認。掲載動画の視聴による再現性評価、本プロジェクトでの文字入りH3生成は未実施。

## 公開資料で確認できたこと

- [MiniMax公式プロンプトガイド §4.5](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)：画面内文字は英語のダブルクォートで囲み、内容・句読点を翻訳せず保持する。発話用の`<d>`とは区別する。
- [falのH3 Max Turbo I2V公開例](https://fal.ai/models/minimax/h3-max-turbo/image-to-video)：今回と同じエンドポイントの入力例とexpanded_promptに、文字の拡大、字間の拡張、短い色ずれ、移動ブラー、変形から鮮明な字形への収束が明記されている。書体、色、余白への配置、保持と退場も指定している。これは公開プロンプトの実例であり、毎回正確な文字が出る保証ではない。
- [MiniMax公式の商品広告用スキル](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/minimalist-product-ad-generator/SKILL.md)：動画生成自体で文字とタイミングを扱い、文字が崩れる場合は表示回数を減らして最後の一行へ簡素化する方針がある。広告専用の語数・書体・構成ルールはH3の制約ではなく、ゲームにはそのまま移植しない。

## このプロジェクトで採用する設計

以下は上記を参考にした制作提案。公式の保証値ではない。

**本編・タイトル・視覚VFXを一つのH3ジョブで生成する。** 返された動画をそのまま再生する。FFmpeg合成やブラウザ上の文字重ねを標準工程にしない。開始画像のみを参照し、タイトル付き終了画像や絵コンテを必須にしない。

| ゲームの確定値 | 表示文字列 | 演出の方向案 |
|---|---|---|
| `happy` | `TRUE END` | 光の広がりと大きな着地から、開放感のある静止へ |
| `normal` | `NORMAL END` | 一度の鋭い光の走査と小さな拡大から、緊張を残す静止へ |
| `bad` | `BAD END` | 短い収縮と色ずれから、重い静止へ |

表示名は今回の設計案として大文字・単一行に統一。ゲーム内部の判定値は改名しない。H3にどのラベルを出すか判断させず、確定結果に対応する一種類だけを最終プロンプトへ渡す。

### 文字を演出として成立させる指定

1. **結末の証拠が先、ラベルは後。** 15秒のNormal試案なら最終場面で未脱出の根拠を見せ、12.0〜12.6秒で文字が着地、12.6〜15.0秒は鮮明に保持する。秒数は指示目標でありフレーム精度の保証ではない。
2. **書体と構図。** 太いサンセリフ、白系の字面、控えめなアンバーの縁。字間を指定し、一行を収める余白を最終ショットに確保する。人物・空のカード枠・暗い案内表示を覆わない。位置は各ショットで一箇所に決める。
3. **動きは入口と静止をセットで。** スケールの短いオーバーシュートとease-out、細いライトスイープを主効果にする。細かい粒子は補助。全保持時間にわたるグリッチや歪みで読みにくくしない。
4. **画面に固定されたグラフィック。** 室内の看板や浮遊物ではなく、生成動画の画面上のタイトルと明示する。室内へ光や影を投げず、未作動の装置を点灯させない。文字のVFXでゲーム内の成功・失敗を捏造しない。
5. **音は別に固定。** 既存の最後の物理音と登場を合わせる。広告例の台詞・音楽・電子音を持ち込まない。環境音と物理的効果音のみ、`non_diegetic_music: N/A`を維持する。

## Normal用の具体的な追記例

これは最終ショットへ組み込む原案で、単独で送る完全な動画プロンプトではない。下中央の余白を確保できる構図で使用する。余白がなければ構図と配置を一緒に修正する。

```text
Keep the final evidence visible: the empty card activation recess, the unlit emergency guide, and the adult still inside. Frame these above a clear lower-center area reserved for the title. Reveal this evidence before the title appears.

At 00:12.000, introduce exactly one screen-space motion-graphics title reading "NORMAL END", uppercase, on a single line. Use bold clean sans-serif lettering, off-white with a narrow amber edge, centered in the reserved lower-center negative space, with generous safe margins. Keep every letter fully within the frame and clear of the person, recess and indicator.

From 00:12.000 to 00:12.600, bring the complete title in with a brief scale overshoot that eases into its final size, a small tracking expansion, and one thin amber light sweep across the letter faces. Let a few graphic particles trail the sweep and quickly disappear. By 00:12.600, settle into crisp, stable, evenly spaced lettering. Hold the complete unchanged title until the end at 00:15.000, without another cut or fade-out.

The title and its effects are graphics fixed to the screen, not objects inside the room. They cast no light or shadows onto the scene. The emergency guide stays dark and the phone flashlight continues working. Time the title entrance to the final physical footstep from upstairs and its natural decay. Add no voice, music or synthetic title sound. Show no other added text, subtitles or ending labels. No title appears before 00:12.000.
```

日本語での意図：空のカード枠と暗い案内表示を先に見せる。最後の上階の足音に合わせて、画面下の余白へ「NORMAL END」が短く拡大して着地し、アンバーの光が一度走る。残り約2.4秒は読みやすく静止。室内の照明や攻略状態には影響させない。

### 組み込み時の矛盾チェック

- 旧プロンプトの`No captions`、`No titles`、`No labels`等の全面禁止を残さない。「指定したエンドタイトル以外の追加文字は出さない」へ置換する。否定文へ別エンドの文字列を列挙しない。
- ラベルを開始画像に入れない。最終ショットの結果提示時刻・タイトル開始・保持・カットの指示を一つの時間割に揃える。
- 既存`staging.py`には文字を禁止する出力が残る。この試案は監督用文章プロンプトへ直接統合する。旧コンパイラ出力を無修正で併用しない。汎用コンパイラの正式対応は別途実装する。
- エンドタイトルはカテゴリを補足する。未脱出理由を説明字幕で代用しない。

## 検証と依存関係

次回の試作では同じ履歴・開始画像を使い、最終ショットの余白とタイトル演出を変更点として記録する。人が綴り・余分な文字・読みやすさ・登場順・静止時間・事実整合・演出の手応えを確認する。文字を読めたことと、映画として良くなったことを分けて評価する。

崩れた場合は、効果の削減、字面の拡大、保持の延長を次の候補にする。自動課金リトライや無断の後付け合成は行わない。失敗しても確定済みゲーム結果を変えない。

この方式は**タイトル合成工程のFFmpeg依存を除く設計**。既存ツールのprobeや通常プレイ登録を含む全体の依存解消・Web実装まで済んだ意味ではない。実際の文字生成品質は次の承認済み試作で確かめる。
