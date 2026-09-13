# AWS公開・更新・廃止

この手順の正本は `specs/hosted-multiplayer/plan.md`。公開版は単一Nodeプロセス、Lightsail Containers Micro、scale=1。開発・審査のサービスは別々に用意する。ゲーム状態はメモリだけにあり、再起動時は失われる。既存のrelayを別に起動する必要はない。

## 先に準備するもの

運営がAWS account ID、region、service nameを決める。東京 `ap-northeast-1` は案であり、コードに実アカウントは設定していない。Micro基本料金は1環境10 USD/月、2環境20 USD/月を目安にし、API・税・転送超過等は別。無効化中も課金されるため、終了時は削除する。[AWS料金](https://aws.amazon.com/lightsail/pricing/)

1. `infra/lightsail/service.example.json` のサービス名を実値に置き換え、運営権限でLightsailコンテナサービスを作る。power=micro、scale=1。公開endpoint設定はデプロイスクリプトが行う。作成前にaccount/region/nameを確認する。通常deploy roleに作成・削除・IAM管理権限は付けない。
2. `development` と `judging` のGitHub Environmentを作る。両方の deployment branch policy を **Selected branches and tags → branch mainのみ、tagなし** に設定する。workflow内のifだけを境界にしない。審査用は必要になってからAWSサービスを追加する。
3. 環境ごとに別IAM roleを作る。OIDC providerは `token.actions.githubusercontent.com`、audienceは `sts.amazonaws.com`。`infra/lightsail/trust-policy.example.json` のaccountとsubjectを実設定で埋める。本リポジトリが使用する**実際のsub文字列**だけを許可し、wildcardにしない。新しい形式ではowner/repositoryのimmutable IDを含む場合があるため、名前だけの古い例をコピーしない。OIDCのJWTや短期credentialをログに出さず、管理画面・診断でaud/subだけ確認する。[GitHub公式OIDC手順](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
4. roleの権限には `deploy-policy.example.json` を用い、実コンテナサービスARNを指定する。Resource指定に対応しないGet/registry login操作だけ `*` を使う。初回の実CLI検証で必要なactionを確認し、不足時はaction単位で追加する。[AWS権限表](https://docs.aws.amazon.com/service-authorization/latest/reference/list_lightsail.html)
5. GitHub mainの変更権限を限定し、Environmentのsecret閲覧・管理者を限定する。ActionsをSecrets付きで動かす信頼境界はmainである。

## Environmentの設定

| 種類 | 名前 | 内容 |
| --- | --- | --- |
| Secret | OPENAI_API_KEY | この環境用のOpenAIキー |
| Secret | APP_PASSPHRASE | 参加者へ伝える共通合言葉 |
| Secret | OPS_TOKEN | 十分に長いランダムな運用専用token。参加用と別にする |
| Variable | AWS_ACCOUNT_ID | 12桁の対象account |
| Variable | AWS_REGION | 対象region |
| Variable | AWS_DEPLOY_ROLE_ARN | このEnvironment専用OIDC role |
| Variable | LIGHTSAIL_SERVICE_NAME | 作成済みサービス名 |
| Variable | PUBLIC_APP_URL | AWSが発行した標準HTTPS origin。パスなし |
| Variable | INITIAL_DEPLOYMENT | 初回だけ `true`。成功後、必ず `false` に戻す |
| Variable | AI_GLOBAL_LIVE_ATTEMPTS | 環境のLive作成回数上限。例50 |
| Variable | AI_GLOBAL_RESPONSE_ATTEMPTS | 環境のResponses回数上限。例1000 |
| Variable | LIVE_MODEL | 省略時 `gpt-live-1` |
| Variable | RESPONSE_MODEL | 省略時 `gpt-5.6-terra`。運営が利用可能なモデルを設定 |

例示回数は予算の推奨値ではない。運営の実予算と利用権限で決める。回数上限はプロセス再起動で戻り、金額上限ではない。合言葉やキーをコマンドに直書きせず、GitHubのSecret入力UI等で登録する。ローカルのルート`.env`は読み込まない。`.env.relay.local`からの移行が必要な場合は、運営が必要な値だけを新しい`.env.local`へ手動で移す。キー値をGitへ追加しない。

環境変数はDocker buildへ渡さず、配信時だけLightsail deployment environmentに注入する。Lightsailのdeploymentを閲覧できるIAM権限では環境変数も見えるため、その閲覧者も秘密を扱う人として限定する。以前のdeployment履歴に古いキーが残ることを考慮し、ローテーションでは旧キーも失効させる。[AWS Container environment](https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_Container.html)

## 配信の流れ

- 開発: mainへのpush（マージを含む）で `deploy-dev.yml` が実行される。
- 審査: **mainのworkflow**から `deploy-judging.yml` を手動起動し、main履歴上の40桁commit SHAを指定する。タグ・短縮SHA・別ブランチのcommitは使わない。
- 同じ環境の配信は直列化し、進行中ジョブを後続配信でcancelしない。

秘密なしのbuild jobで指定SHAをcheckoutし、format/test/buildとLinux image buildを実行する。image tarだけを1日保持artifactとして次jobへ渡す。deploy jobはworkflow実行時の信頼されたmainをcheckoutする。過去SHAのnpm scriptやアプリをSecrets/OIDC付きjobで実行しない。tarはload/pushするだけで、そのjobで起動しない。

配信スクリプトは `tools/deploy.ts`。固定版AWS CLI/LightsailctlでSHA labelのimageをpushし、返されたimage識別子を用いる。既存サービスでは `/healthz` のversion/bootIdを取得し、運用tokenでdrainする。120秒以内に全終了を確認できなければ配信を止める。version/bootIdが途中で変わった場合も止める。初回はcurrentDeploymentが存在しないことと `INITIAL_DEPLOYMENT=true` の両方を確認してdrainを省略する。

秘密入りdeployment JSONは権限制限付きの一時ファイルだけに書き、CLI呼び出し後は成功・失敗とも削除する。JSON、AWS CLIの全文、HTTP本文、環境変数一覧をログ・artifactへ出さない。10分以内にactive deploymentのimageと公開`/healthz`のSHAが一致した時だけ配信成功とする。ログには確認したversionとimage識別子を残す。同SHAの再buildは同digestを保証しない。

固定値の取得元（2026-09-13）: Node公式 `node:22-bookworm-slim` pull digest（実v22.23.2）、各Actions公式repositoryのtag ref、[AWS CLI 2.36.44](https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.36.44.zip)、[Lightsailctl v1.0.8 release](https://github.com/aws/lightsailctl/releases/tag/v1.0.8)。Actionsは40桁SHA、CLI配布物はSHA256照合で固定している。これらはAWS実配信の成功を示さない。

## 配信失敗からの復旧

自動resumeは行わない。まず対象account/region/serviceを確認し、AWSのcurrent/next deploymentと公開 `/healthz` のversion/bootIdを照合する。終了未確認のLiveがある場合は、予約を強制解放したりプロセスを再起動して隠したりしない。運営が上流の接続状態を確認する。

旧版が残り、旧版へのdrainが完了していて、未確認Live・pending create等が0なら、運営の信頼された端末から同じOPS_TOKENで `POST /api/ops/resume` を行える。bodyは `{ "expectedVersion": "確認した40桁SHA", "expectedBootId": "確認したbootId" }`。tokenはAuthorization Bearerヘッダーに入れ、Originは送らない。プレイヤーcookie・合言葉では管理APIを操作できない。tokenをブラウザconsoleやshell履歴に貼らず、秘密を表示しない管理スクリプト等から呼ぶ。現在のversion/bootが変わった場合は再確認してから操作する。

失敗した新版がactiveになった場合は、その版をdrainしてから確認済みのmain履歴SHAを審査workflowで指定する。開発環境では修正/revertをmainへ反映し、通常の自動更新を使う。直接の無条件rollbackや二重受付はしない。

## 公開前に確認すること

自動fakeテストと、以下の実確認を分けて記録する。

- AWS account/region/service、OIDCの実sub、main以外からEnvironment資格を使えないこと、CLIの必要権限。
- Micro scale1で5人の独立プレイ、6人目の拒否、写真変換時のメモリ/CPU/health/応答時間。Nano縮小は同条件で再測定後に判断する。
- 標準HTTPSで実GPT-Live、実機撮影復帰、再読み込み、Cookie、操作権、60秒復帰猶予/10分上限。
- 30秒程度の上流遅延とHTTP再試行でも二重行動・二重API作成にならないこと。
- dev自動、judging手動、失敗配信、旧新切替中の受付と実音声停止。AWSのSIGTERM猶予とshutdown所要時間。
- image・静的配信・Actions/AWSログにキー、合言葉、写真、会話、SDPが入らないこと。

強制kill、OOM、プラットフォーム障害ではメモリのLive IDが失われるため、外部音声接続終了や課金停止を完全には保証しない。正常drainの確認と混同しない。上流側の独立期限・回収方法は実公開前に確認する。未確認のAPI仕様を保証として説明しない。

## 期間終了時

1. GitHubの両配信workflowを無効化し、新しい配信が起きないことを確認する。
2. 環境ごとにdrainし、全Liveの終了確認を取る。必要な非秘密の検証記録だけ保存する。
3. account/region/service nameを再確認し、運営権限で開発・審査サービスを削除する。削除するとURL、image、deployment履歴、ログは失われる。[AWS削除手順](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-deleting-container-services.html)
4. 残存サービス・image・ログ・請求対象を確認する。無効化しただけで終わらせない。
5. この企画専用のOpenAIキー、GitHub Secrets、OIDC roleを整理する。共用資格や他サービスを巻き込んで失効・削除しない。

現時点の自動検証結果はticket07を参照。AWSアカウント設定、実配信、実音声/実機、Micro負荷、削除の実行は未実施。
