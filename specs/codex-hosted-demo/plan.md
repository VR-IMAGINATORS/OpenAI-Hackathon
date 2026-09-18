Status: approved (2026-09-18)

# 公開デモ実装計画

ユーザーの公開URL対応・デプロイ指示に基づくMVP。追加の機能拡張やマルチレビューは行わない（AGENTS指示）。設計点検では、元のproduction拒否、Docker内のCLI不在、既存deployのAPIキー必須、同時認証上限を確認した。

1. 公式npmのLinux x64 tarballを固定SHA512で検証しDockerへ配置する。Docker buildでバージョンとApp Server initialize/capabilitiesを検査する。異なる版への自動代替なし。
2. apps/serverの起動ファクトリからCodexPlayerSessionsとtransportを注入。production設定は明示providerと固定バイナリを要求する。API起動を回帰検証。
3. tools/deploy.tsと両ActionsにAI_PROVIDERを追加。codexではキーを注入せず、初期MAX_PLAYERS=2、画像締切300秒、GAME_MODEL=gpt-5.6-luna。既存運用認証と予算は維持。
4. 所有者のCookie・playIdによる認可を維持し、認証とキャンセルの既存テストを使う。認証ファイルは一時領域のみ。サーバー停止時のdisposeを継続。
5. 型・format・全test・build、Linux起動・匿名契約検査を行う。PRをdevelopへ反映し、developからcodex/release-*を作成、main向けPRを通じて配信。Actionsと公開healthzのSHA、bootstrapのcodex providerを確認する。

APIコントラクト/データモデルは既存codex-player-login/codex-game-liveを再利用し追加なし。実アカウントによるLinux音声確認は本人操作が必要で、自動検査成功と混同しない。
