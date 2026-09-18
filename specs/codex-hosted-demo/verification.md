# 公開デモ検証

2026-09-18。実装PR #73、Linux CI https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/actions/runs/35345019622 が成功。

- Linux上のnpm ci、format:check、全テスト、型・標準JSON・UI/サーバービルド: 成功。
- Linux amd64 Docker build: 成功。公式配布物SHA512とバージョンを検証し、未認証のApp Server initialize・画像機能・音声一覧を確認。
- コンテナの実行ユーザーnodeでも匿名App Server起動と終了: 成功。WSLでも固定バージョンの実行を確認。
- 公開起動ファクトリがCodex認証を要求し、未認証のプレイを拒否すること、APIキー/動画キーを配信設定から除外すること、既存API配信のキー必須条件を自動検証。
- プレイヤー分離・再プレイ保持は既存模擬HTTPテストで検証。ローカルの実ログイン/音声/再プレイ保持はユーザー報告で確認済み。
- Linux公開環境での本人ログイン後の実音声・写真判断・実画像生成は未確認。匿名preflightを実音声成功として扱わない。

リリース手順: PR #73をdevelopへマージし、そのdevelop（ca078ab）からcodex/release-2026-09-18-codex-demoを作成。公開後はhealthzのSHAとbootstrapのprovider/playerLoginを確認する。
