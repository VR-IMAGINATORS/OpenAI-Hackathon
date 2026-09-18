# 調査結果

- 公式 https://developers.openai.com/ja-JP/docs/image-generation は組み込み画像生成をCodex利用枠に計上すると説明。
- 固定CLI 0.154.0-alpha.6.2の生成済みClientRequest.tsにあるRPCは `modelProvider/capabilities/read`。未認証の専用プロセスで `imageGeneration:true` を実測。これはアカウント別生成成功を保証しない。
- 専用画像RPCはなく、thread/start→turn/startで組み込みimage_generationを呼ばせる。item/completedのimageGeneration.resultはbase64、savedPathは読まない。公式ソース: https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs
- 別threadで生成と検査を行い、音声threadは維持。生成結果のPNG等をJPEG/1024以内へ変換して既存SceneJobs検査に接続。
- APIのmodel/quality/sizeパラメータは組み込み生成ツールでは指定できない。codex-image-generationは内部経路ラベルであり実モデル名ではない。
- 実測した声一覧にgleamはなく、defaultV2=marin。ユーザーがCodexはmarin、APIはgleamを維持する方針を選択。
- 続く実接続でmarinは拒否。対応一覧はjuniper, maple, spruce, ember, vale, breeze, arbor, sol, coveと報告された。RPCのversion=v3とlistVoicesのv2一覧を対応づける根拠はなく、juniperへ修正。API側は変更しない。

選択理由: 本人の専用認証と既存の予算・検査・表示を再利用できる。API併用はユーザーのキーなし要件に反するため採用しない。モデルの道具利用・アカウント枠は実ログインで確認が必要。
