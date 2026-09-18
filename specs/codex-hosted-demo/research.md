# 技術調査

- 公式npm @openai/codex@0.154.0-alpha.6.2-linux-x64が存在。tarballはhttps://registry.npmjs.org/@openai/codex/-/codex-0.154.0-alpha.6.2-linux-x64.tgz。
- npm integrity: sha512-xlnRDWXHIbkPQeFk1sh6GKApHunKVdAm8Wb6FliTW5/lzV0zUE2FIda/z9QDr7AfZb6eHC2KF0lf+z/LkzXhDg==。
- Linuxバイナリはx86_64-unknown-linux-musl。Windows用同梱exeの流用は不可。未検証の別バージョンへの置換はしない。
- 既存DockerはAPI起動のみ、productionでCodexを拒否していた。既存mainマージでdevelopment環境へ配信する。審査環境の配信は依頼範囲外。
- 公式インターフェースの採用と、ゲーム用途への個別許諾は別。許諾取得済みとは表示しない。
