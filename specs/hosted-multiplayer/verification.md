# 検証記録 — AWS公開・複数人試遊

実施日: 2026-09-13。自動・ローカル確認は実装時点の記録であり、実APIキー・本物の環境ファイルを使用していません。実AWS配信とユーザーによる実プレイの結果は別記します。

## 自動・ローカル確認

| 確認 | 結果・範囲 |
|---|---|
| TypeScript / シナリオ / Vite / サーバビルド | 成功 |
| Nodeテスト | 65件成功、失敗0。providerだけfake。ゲーム・写真変換・HTTP・時計・配信手順を検証 |
| 5枠と所有権 | 5人の独立ゲームと音声、6人目拒否、他人の状態へのアクセス拒否、終了後の再参加 |
| 再送と操作権 | 開始・Live・写真・行動の同ID再送、内容変更拒否、引継ぎ後の旧要求・遅延判定破棄 |
| 期限と停止 | 絶対10分、切断最大60秒、ゲーム待ち時間、遅い終了処理で他プレイの期限監視を止めない |
| 写真キュー | 同時1件・待機4件、失効/切断時の待機解除、実画像変換 |
| 認証とログ | Cookie/Origin/Host、管理Bearer、終了不明時枠保持、本文・秘密sentinel非露出 |
| ブラウザmock | マイク拒否時枠なし、満員時Liveなし、応答欠落後の再送、写真、明示引継ぎ、390px/PC表示 |
| 実ローカル起動 | tools/dev --mock + Viteで実認証・画像・終了・再参加を確認。検証プロセスを終了 |
| 実HTTPSトンネル | tools/mobile --mockで共通URL・ターミナルQR・Secure Cookie・モバイル表示を確認。初期DNS遅延に対し待機を45秒へ変更し再試験成功。プロセスとポートを終了 |
| Linux Docker | build、非root UID1000、HTTP health/bootstrap/auth、sharp JPEG変換、秘密ファイルの除外を確認 |
| SIGTERM | Dockerで実index.jsがdrain完了・exit0。fake Liveを持つ別Nodeプロセスはhangup1回・予約0・exit0 |
| 配信 | fake AWS/HTTPでdrain待ち、期限超過中止、version照合、初回条件、秘密JSONの成功/失敗時削除を確認 |

ブラウザ検証用の一時スクリプト・スクリーンショットはGit対象外のartifacts/に保存しています。Docker検証コンテナは終了・削除済みです。

## 公開ゲート（進捗）

開発環境のAWS設定・自動配信は完了。ユーザーからAWS上でも一通りプレイできたとの報告を受領しました。複数人同時プレイや障害時の運用確認は別途残します。

- [x] 開発用Micro/scale1サービス、OIDC、GitHub Environmentのmain制限、秘密値・変数を設定する。
- [x] main自動配信を実行する。
- [ ] 審査環境への指定SHA手動配信を実行する。
- [x] 標準HTTPS URLでゲームを一通りプレイする（ユーザー報告。個別操作・障害数の詳細記録はなし）。
- [ ] 5人同時プレイのCPU・メモリ・遅延・写真撮影復帰・誤失効を記録する。Nano縮小は未判断。
- [ ] 稼働中更新で既存Liveの終了、失敗更新の受付停止、旧版の明示resumeを確認する。
- [ ] AWSの停止猶予と、本物のLive終了を確認する。強制kill/OOM時の停止保証とは分ける。
- [ ] 審査終了時のdrain・サービス削除・企画専用資格の整理を実行する。

設定と操作は docs/hosting.md。自動テストやDocker成功を上記の成功として扱いません。

## 文書更新

README・docs/development.md・docs/architecture.md・docs/hosting.md・AGENTS.mdを現行構成へ同期しました。AGENTS.mdは自動承認レビューで一度保留となりましたが、ユーザーの明示承認後に旧構成・設定先・起動コマンドの記述を更新しました。秘密保護・承認・ワークフローのルールは保持しています。実装変更はなく、文書差分を確認しました。AWS等の未実施項目は上記のままです。

## 初回AWSデプロイの実確認（2026-09-13）

PR #16のマージコミット233dd5c64d3dc98054f3fe6c72b22717526bbd1eでActions run 34728247924を実行。buildとGitHub OIDCによるAWS認証は成功しました。配信はサービス照合で失敗し、デプロイ成功には至っていません。

AWS ContainerService応答の正しい項目はcontainerServiceNameですが、配信実装とfake応答がserviceNameになっていました。公式仕様に合わせたfake応答でService configuration mismatchを再現し、応答型と照合を修正。送信するdeployment documentのserviceNameは正しいため維持しました。初回READY/null状態を含む配信テスト7件、TypeScript、対象ファイルの書式確認が成功。修正版のAWS配信は未実施です。

公式仕様: https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_ContainerService.html

### 2回目の修正（PR #17マージ後）

Actions run 34728653304（c18605011a9eac47627748cb9898b5a6bda3b847）はbuild/OIDC成功後、配信処理で失敗。既存ログでは失敗段階を識別できませんでした。調査で、固定版lightsailctl v1.0.8はpush成功時もJSONではなく `Refer to this image as "..." in deployments.` を出力することを公式ソースで確認しました。汎用JSON解析はこの成功出力を扱えません。

pushに限り一意の登録完了行から識別子を取り出すよう修正し、通常APIはJSON解析を維持。改行差・完了行重複・不正出力拒否を検証しました。実際の文章形式を配信fakeにも使用。固定段階ログと許可した固定エラーメッセージだけを追加し、生のstdout/stderrや環境変数は表示しません。配信テスト8件・全体型検査成功。AWS再配信は未実施です。

出力形式の根拠: https://github.com/aws/lightsailctl/blob/v1.0.8/internal/cs/pushimage.go

### 起動直後の公開エンドポイント待機

PR #18のrun 34728966348はイメージ登録とdeployment作成まで成功しましたが、ACTIVE直後の公開health要求で一時エラーになりジョブは失敗しました。その後、公開/healthzは200で8b2dd53a170958cba8d15228c320a82698eea894と一致しました。初回配置済みのためGitHub developmentのINITIAL_DEPLOYMENTをfalseへ変更しました。

配信後のhealth確認だけを、一時HTTPエラー・接続失敗・timeout時に既存10分期限内で再試行します。drainや配信作成は再送しません。403などは即時失敗。成功までの一時503/接続失敗と、恒久エラー/期限超過の回帰テストを追加し、配信10件・型検査に成功しました。

### Node直接実行の回帰検証

PR #19のrun 34729307540は、追加したTypeScriptのparameter propertyをNode strip-onlyが処理できず、配信処理開始前に失敗しました。通常のクラスフィールド代入へ変更し、Nodeの直接importをテストに追加。配信テスト11件・型検査・native Node importが成功。公開中の8b2dd53には変更を加えていません。

## 開発環境の配信・実プレイ確認（2026-09-13）

PR #20のマージSHA a05011886caed4816d9ae314a3c8cc9a7d711f4cに対するActions run 34729487906が成功。drain_confirmed / deployment_confirmedを確認し、公開healthのSHA一致と、画面・bootstrapのHTTP 200、Liveモードを確認しました。INITIAL_DEPLOYMENTはfalseへ変更済みです。

ユーザーから「AWS上のものでも一通りプレイできました」と報告を受領。これはユーザーによる実プレイ確認であり、エージェントによる操作検証ではありません。同時5人の負荷測定や稼働中Liveの更新・停止試験まで完了したとは扱いません。上記の失敗記録と未実施記載は各試行当時の履歴です。
