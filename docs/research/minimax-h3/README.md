# MiniMax H3 プロンプト調査

調査日: 2026-09-13。特定プロジェクトのルール・実装から独立した資料。

## 使い方

今回の用途では、まず [顔・台詞に頼らない演出とカメラワーク](cinematography.md) を読む。公式記法、公開検証、実写撮影の知見を分け、演出14パターンと完成プロンプト3例を収録した。以前の [無言の芝居の調査](live-action-drama.md) は補足資料であり、表情演技を今回の前提にはしない。

生成担当エージェントに [agent-instructions.md](agent-instructions.md) と [prompt-templates.md](prompt-templates.md) を読ませる。前者が作成・修正手順、後者が入力の記入例。公式の厳密な書き換え形式が必要な環境では、下記の原典も読む。

この調査では資料と公開例の説明文を確認した。動画の全編視聴、実生成、比較実験は行っていない。記入例は独自作成の未検証例であり、成功済みプロンプト集ではない。

## 確認できたこと

### モデルの能力とサービスの入力仕様を分ける

H3はテキスト・画像・動画・音声を合わせて扱い、映像と音を生成する。MiniMaxの公開例では、人物の外見、カメラ動作、歌声に異なる参照を割り当てている。エージェントは「この素材に似せる」だけでなく、何を借りるかを明示するとよい。ただしモデルの紹介で挙げられる2Kなどの能力が、すべての提供経路で選べるとは限らない。[MiniMax公式発表](https://www.minimax.io/blog/minimax-h3)

### 公式には二つの書き換え形式がある

テキスト・キーフレーム系は、映像と同期音の本文 `integrated_multimodal_description`、環境音等の `overall_soundscape`、観客向け音楽の `non_diegetic_music` の順。画像があれば、その時間上の役割を冒頭に指定する。開始画像から先を描く場合と、開始・終了画像をつなぐ場合を区別する。[公式基本ガイド](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)

複数参照系は `subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`。人物等の参照内容と、画像・動画ファイル自体を分けて定義する。音のコピーと、声質などの参考利用も別の関係として記す。これらは希望する保持関係であり、生成後の忠実度判定ではない。[公式参照ガイド](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)

公式はプロンプト作成用の [h3-prompt-writingスキル](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md) も公開している。本文は英語、台詞・歌詞・画面上の文字は原語を維持する形式。今回このスキルのインストールはしていない。

### APIへは、その経路の名前で渡す

2026-09-13時点のAPI資料から確認した差分。送信時には再確認する。

| 項目 | fal H3 Max Turbo I2V | fal H3 Max R2V |
|---|---|---|
| 入力画像 | `image_url` が開始、`end_image_url` が終了 | `reference_image_urls` の順に `Image 1`, `Image 2` |
| その他の参照 | このInput欄に動画・音声参照フィールドなし | `reference_video_urls`, `reference_audio_urls` |
| 動画参照の呼び方 | — | `Video 1` など、動画リスト内の順番 |
| 音声参照の呼び方 | — | `Audio 1` など、音声リスト内の順番 |
| 解像度の選択値 | 480P / 768P / 1080P | 480P / 768P / 1080P |
| プロンプト展開 | `prompt_expansion_mode`: balanced / quality | 同左 |

R2Vは全参照合計12ファイル以下。動画は各2〜15秒、動画の合計15秒以下。音声も各2〜15秒、音声の合計15秒以下で、音声だけの参照は不可。I2Vの画面比率は入力画像に従う。APIの出力 `expanded_prompt` は取得できる場合もあるが、nullもあり得る。[Turbo I2V API](https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api)、[Max R2V API](https://fal.ai/models/minimax/h3-max/reference-to-video/api)

**公式の書き換え形式を、APIの必須JSONスキーマと取り違えない。** falの上記APIは `prompt` 文字列を受け取る。構造化した文字列を入力することと、三つ・六つのセクションをAPIパラメータとして渡すことは別。自動展開を通す場合に、原文の形式がそのままモデルまで届くとは保証しない。

## 公開例から取り出せる工夫

falの解説には、参照人物の正面・側面・背面を用意する例、カメラの移動に合わせて情報を見せる例、環境音と効果音を具体化する例がある。転用するなら「振り向く人物には見える予定の角度の情報を用意する」「見せたい情報が読める画角と時間を確保する」という設計判断が有用。公開例の説明にある局所編集の保持性は、任意の素材での完全保持を保証する実験結果として扱わない。[fal公開例付き解説](https://fal.ai/learn/tools/minimax-h3-explained)

## 根拠の扱い

- **公式記法**: 上記MiniMaxの基本・参照ガイドと公式スキル。
- **提供者の仕様**: 利用するエンドポイントの現行Input/Output欄。モデル全般の記事より優先する。
- **公開例からの示唆**: 提供者の作例説明。成功率や他の条件での再現性は未検証。
- **本資料の作業上の推奨**: 次の指示書の優先順位、修正表、記録様式。H3で比較実証した法則ではない。

検索にはH3名を冠した非公式サイトやコミュニティ記事も現れたが、固有記法の根拠には採用していない。falの「Prompting Guide + 44 Video Examples」は本文再取得がタイムアウトしたため、その44例を精査済みとは扱わない。代わりに取得できた公式ガイドとfalの解説・API資料を使った。
