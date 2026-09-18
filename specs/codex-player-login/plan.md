Status: approved scope by user implementation request (2026-09-18)

# 実装計画

既存のworkerとlogin helperを再利用。仕様の対象は既存PoCの次段階であり、今回の依頼を実装承認として扱う。AGENTS.mdのハッカソン方針によりマルチレビューは実施しない。

- apps/serverにplayer judgment provider境界を追加。起動ツールからだけ実Codex管理を注入し、通常サーバーには影響させない。
- AiServiceの内部ゲーム呼出にplayIdを渡す。registry factoryで所有者と紐付け、closeで解放する。
- tools/codex-poc/player-sessions.tsに所有者→認証状態とplayId→接続のMap。開始前に予約して重複生成を防ぐ。取消とfactory完了の競合でも後着workerを閉じる。失敗/失効時も閉鎖完了まで容量を保持する。
- 待機状態は3分、認証済み未プレイは10分。実プレイ期限は既存registryが管理。上限は起動設定capacity。失敗の生ログは公開しない。
- UIはログイン状態poll、コード/リンク、取消/ログアウト、開始ボタンの制御。通常APIモードでは追加画面なし。
- テスト: fake workerによる2所有者の分離、遅延開始取消、同時開始、期限、play結合/解放。HTTP Cookie/Origin/未認証・APIモード回帰。UIビルドと可能な範囲のブラウザ確認。

公式仕様: https://developers.openai.com/ja-JP/docs/app-server のaccount/login/start(chatgptDeviceCode)、account/login/completed、account/logoutを利用。既存の固定版プロトコルとPoCの実測を優先。共有の1プロセスをlogout/loginで使い回す案は認証混線を避けるため不採用。
