# H3プロンプトの記入例

すべて独自作成・実生成未検証。波括弧の項目は実素材と依頼に合わせて埋める。形式の根拠とAPI差分は [調査](README.md) を参照。

今回の顔・台詞に頼らない映像は [演出14パターンと完成プロンプト3例](cinematography.md) を優先する。

## A. テキストからの基本形

公式の三つのフィールドを使った記入枠。尺・解像度などのAPI設定は本文とは別に一致させる。

```text
integrated_multimodal_description: [Shot 1] {style and opening composition}. {subject and visible action}. {camera behavior and observable result}.

overall_soundscape: {ambience and physical sounds}.

non_diegetic_music: {music description, or N/A}.
```

## B. 開始・終了画像をつなぐ短い入力例

8秒、同じ机とカップ、開始はカップに手を添えた状態、終了はカップを少し持ち上げた状態、という素材を想定。これはfal等のプロンプト展開を使う経路への自然文例。公式FL2VAの厳密な冒頭定型を転載したものではない。

```text
Use the supplied first and last frames as the opening and ending of this eight-second clip. Keep the cup, sleeve and table consistent. In one uninterrupted close-up, the hand grips the handle, lifts the cup slightly above the table, then settles into the supplied ending pose. The camera stays still. Include quiet room ambience and a brief ceramic scrape as the lift begins. No speech or music.
```

画像が両端で異なる手、別のカップ、異なる視点なら、この例を無理に当てはめない。変化に必要な出来事を設計する。正式な三フィールド出力が必要なら [基本ガイド](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md) のFL2VA整合行と組み合わせる。

## C. 複数参照の短いAPI入力例

fal Max R2Vを想定。`reference_image_urls[0]` が人物、`reference_image_urls[1]` が場所、`reference_video_urls[0]` が歩行の参考。動画の人物や背景は借りない。

```text
Image 1 supplies the person's appearance and clothing. Image 2 supplies the location. Video 1 supplies only the walking rhythm; exclude its person and location. Over eight seconds, show the person from Image 1 walking through the location from Image 2, then stopping beside the window. Keep the camera at waist height, following from behind. Use footsteps and indoor ambience, without speech or music.
```

APIの参照名に合わせた独自例であり、公式Ref2VAの六セクション完成例ではない。音声参照を追加するなら「声質の参考」「音源のコピー」などの役割も指定する。音源コピーの要求が、無加工の音声ファイル結合として実行されるとは仮定しない。

## D. 正式なRef2VAを組み立てる記入枠

これは省略形の作業枠。完成時には [公式参照ガイド](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md) のラベル・保持関係・話者規則で埋める。存在しない素材は定義しない。

```text
subject_definitions:
{reference labels, source assets and roles}

summary:
{task type and intended result}

retention_analysis:
{each label, applicable shots, retention relationship and details}

detailed_description:
{visual style}
[Shot 1] {composition, action, references, camera and synchronized sound}

overall_soundscape:
{ambient and physical sound}

non_diegetic_music:
{audience-only music, or N/A}
```

## E. 曖昧な要求の具体化

次はH3固有の公式規則ではなく、演出を明確にする作業例。

| 下書き | 具体化する内容 |
|---|---|
| 緊張感のあるシーン | 指が止まる、物音の後に視線が動く、扉の隙間を見つめる等、観客が見聞きする根拠 |
| カメラが寄る | レンズのズームか、カメラの前進か。何を最後の画面内に残すか |
| このキャラで動画に似せる | どの素材が外見、動き、衣装、背景を担当するか |
| 背景だけ変える | 変更する背景と、保持する人物・動作・画角・時間構成を分けて指定 |
| 綺麗に終わる | 最後の姿勢、物の位置、画角、余韻のために動きを落ち着かせる時間 |

## エージェントに依頼する文

> agent-instructions.mdとこの記入例を読み、添付素材と私の意図からMiniMax H3用プロンプトを作ってください。まず入力モードと参照の役割を確定し、使用経路に合う本文、条件メモ、矛盾チェックを出してください。仮定と確認済み情報を区別し、まだ生成していない例を成功例と扱わないでください。
