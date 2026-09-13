# 空間から動画プロンプトを作る

画像生成前に、同じ座標系で固定物・人物・道具・カメラを設計する。写真から測定できない寸法は「演出用の仮定」と記録し、実測や厳密な再構成と称さない。設計図はプロンプトの根拠であり、生成モデルの物理拘束ではない。

1. ending-packetと直前画像を読み、移動可能範囲と未解除機構を確定する。
2. `staging.json`を作る。単位m、xは右、yは上、zは奥。roomは原点からの室内寸法。entitiesはid/name/description/size/support/keys（tとposition）を持つ。固体はsolid=true。接触が意図的な組だけallow_contactに記す。キー間は直線・等速補間。カメラはshotsのfrom/to/position/target/fovで固定し、ショット間は明示カット。smoothなカメラ移動が必要ならこの版の対応範囲を拡張してから設計する。
3. 各ショットにaction、sound（環境音・効果音のみ）を記す。revealには最後にだけ見せる装置のid群とatを指定する。bounds・移動速度・固体の衝突・カメラと固体・前半の画角への結末装置の混入を `scripts/staging.py` で検査する。直方体と線形軌道の検査であり、人体変形、把持、照明反射、モデルの実挙動は保証しない。
4. 次のCLIを実行し、同じJSONから配置と時間を見られるpreview.html、各カットのカメラ図、video-prompt.txt、checks.jsonを新規フォルダへ出す。図とプロンプトで位置関係が一致するか読み、成否・失敗理由・最後まで結末を伏せる3観点を自己レビューする。機械検査の成功を演出レビュー成功に置き換えない。

```powershell
py -X utf8 "$CallToPast/scripts/staging.py" --input "$Revision/staging.json" --output "$Revision/compiled"
```

5. レビュー後、カメラ図と既存の人物/道具画像を参照して開始・終了画像を生成する。図は配置の根拠、ゲーム画像は外見の根拠。画像用プロンプトと参照の役割を記録する。配置を変えるなら先にstaging.jsonを修正し、再コンパイル・再レビューする。生成動画は人が確認する。

音は効果音と環境音のみ。セリフ・ナレーション・歌・BGMは入れない。話し言葉で失敗理由を補わない。生成後はファイルの回収とreceipt照合までを担当し、映像・音声・演出の合否は人に任せる。

## JSONの追加フィールド

- duration: 動画尺。標準15秒。
- assumptions: 演出上仮定した寸法・支持方法などの文字列配列。
- continuity: 外見と固定済みゲーム結果の説明。
- outcome: 制作内部の結論と履歴の根拠。
- max_speed: 道具の速度上限(m/s)。実物の物理能力の保証ではない。
- allow_contact: 支持などの意図的接触を許容するidペア。理由は各supportへ記す。
- review: 3観点の人/AIによる設計レビューは別ファイルで記録する。compilerは自動合格を出さない。
