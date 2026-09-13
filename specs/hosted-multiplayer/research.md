# 公開・複数人対応の技術調査

調査日: 2026-09-12

対象: 合意済みの公開構成を実装計画に落とすための公式資料調査。AWSへのデプロイ、課金、実API、負荷試験の成功を示す資料ではない。秘密環境ファイルは参照していない。

## 1. Lightsail Containersと料金

### Decision

開発用・審査用それぞれLightsail Containers Micro、scale=1、アプリのNode.js単一プロセスで開始する。審査用は審査前に追加する。公開URLは標準HTTPS URLを使う。Microで同時5人を検証し、余裕が確認できればNanoへの縮小を検討する。

### Rationale

- Microは1GB RAM、共有0.25 vCPU、基本月額10 USD／ノード。2環境で基本月額20 USD。
- Nanoは512MB RAM、共有0.25 vCPU、基本月額7 USD／ノード。縮小による差額は3 USD／環境。
- 上記はサーバー基本料金の比較。OpenAI API、税、為替、転送量超過、追加サービス等は別。無料枠を前提にしない。
- scaleを増やすとコンテナが複製され、ノード間に通信が分散される。ゲーム状態と人数制限をメモリに持つ今回はscale=1を制約とする。プロセスを複数化するNode clusterも使用しない。
- Microの仕様だけで5人の動作を保証しない。特に写真変換のCPU・メモリは実測する。

### Alternatives

- Nanoから開始: 最安だが写真変換時のメモリ余裕が減るため、合意どおりMicroで先に検証する。
- 複数ノード・外部状態ストア: 可用性向上には有効だが、今回は再起動によるゲーム消失を許容し、導入しない。
- ECS等: 実行時IAM roleなどの選択肢は増えるが、今回の簡潔な公開構成から広げない。

Sources:

- [AWS Lightsail料金](https://aws.amazon.com/lightsail/pricing/)
- [コンテナサービスのscale・power・課金](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-container-services.html)

## 2. HTTPS、音声経路、ヘルスチェック

### Decision

Nodeはコンテナ内でHTTPを提供し、Lightsailのpublic endpointでHTTPS終端する。UIとAPIを同一originにする。音声は現在のブラウザとOpenAI間のWebRTC経路を維持する。

ヘルスチェックは外部API、認証、ゲームの空き人数に依存しない軽量な`/healthz`とする。初期案はinterval=10秒、timeout=5秒、healthyThreshold=2、unhealthyThreshold=3、successCodes=`200`。

### Rationale

標準HTTPS URLが提供され、コンテナとの内部通信をHTTPにできる。public endpointはHTTP(S)であり、TCP/UDPを直接公開する用途ではない。音声をアプリで中継しない現行構成なら、この制約と両立する。ヘルスチェックはプロセスが要求を処理できることを測り、満員や一時的なOpenAI障害をコンテナ故障と混同しない。

### Alternatives

独自ドメイン・独自TLS設定は今回は不要。ヘルスチェックから課金APIを呼ぶ設計は採用しない。

Sources:

- [デプロイのpublic endpoint・health check設定](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-container-services-deployments.html)

## 3. 更新時の旧版・新版とメモリ状態

### Decision

デプロイ前に認証付きdrainを行い、旧版の新規受付を停止し、進行中ゲームを終了して全Live接続の終了を確認する。終了確認に失敗したらデプロイを中止する。外部から新版への切替を確認するまで旧版は受付を再開しない。失敗後の旧版再開は確認済みの復旧手順で明示的に行い、タイマーで自動再開しない。

drain用認証はプレイヤーの共通合言葉と分ける。drain API・進捗確認の具体的な認証、冪等性、切替判定はplanとcontractで定義する。通常プレイの上限を変更せず、更新のために旧版と新版へ新規参加を二重に受け付けない。

### Rationale

公式資料ではactive deploymentは一つとされる一方、旧版と次のdeploymentの状態が存在し、新版起動失敗時は旧版が維持される。更新中のプロセスの寿命や全接続の終了時点まで保証する説明は確認できなかった。したがって「scale=1なので更新中もプロセスが重ならない」と仮定しない。

メモリ上の人数制限は単一稼働プロセス内の制限であり、更新時はdrainにより新規受付を制御する。更新・再起動でゲーム状態が失われることは合意済み。ブラウザは旧セッションの失効を案内して最初から参加し直す。

**MVP制約:** OOM、強制kill、基盤障害等ではshutdown処理を実行できない場合がある。メモリだけの構成で、すでに作成された外部Liveの終了や課金額を厳密に保証しない。正常なdrainと異常終了を検証・報告で区別し、外部サービス側の終了条件に依存する残余リスクを運用資料に記載する。

### Alternatives

- 通常のローリング更新に任せる: 旧版の音声と新版の受付が重なる可能性を排除できないため、採用しない。
- 外部永続ストアで接続・上限を管理する: 障害時の復旧設計を強化できるが、今回は追加しない。

Sources:

- [deployment失敗時の旧版維持](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-container-services-deployments.html)
- [currentDeployment・nextDeployment](https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_ContainerService.html)

## 4. GitHub ActionsとOIDC

### Decision

mainへの反映で開発環境を自動更新し、審査環境は検証済みコミットSHAを指定する手動更新とする。GitHub ActionsからAWSへはOIDCを使用し、長期AWSアクセスキーを保存しない。開発・審査のGitHub EnvironmentとIAM roleを分離する。

### Rationale

`id-token: write`と`contents: read`を必要なジョブに設定し、`aws-actions/configure-aws-credentials`で短期認証情報を取得できる。trust policyではaudとsubを限定する。Environmentを使う場合、subはbranch形式ではなくEnvironmentを参照する。開発・審査の両Environmentはmainに限定する。審査workflow自体もmainから実行し、過去アプリ版は入力SHAで選ぶ。対象SHAのbuildは秘密なしで行い、Secrets/OIDCを使用する配信処理には保護されたmainのスクリプトを用いる。

2026-07-15以降作成のリポジトリ等ではimmutable owner/repository IDを含むsub形式が使われる場合がある。初期設定時に本リポジトリが使用する形式を確認し、古い名前だけの例を無条件に転記しない。OIDCトークン自体をログに出す必要はない。

### Alternatives

GitHub Secretsへの長期AWSキー保存は採用しない。審査環境をmain更新へ連動させる方法も採用しない。

Sources:

- [GitHub公式: AWSでのOIDC設定](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)

## 5. アプリの秘密設定

### Decision

OpenAI APIキー、合言葉、運用認証等はGitHub Environment Secretsで環境ごとに管理し、デプロイ時にコンテナのenvironmentへ注入する。環境変数から構造化した一時JSONを生成し、CLIの出力は非秘密フィールドのみに限定する。一時JSONはログ、artifact、Git、Docker build context／imageへ含めない。

### Rationale

LightsailのContainer APIはenvironmentの文字列mapを提供する。ECSの`secrets/valueFrom`相当やアプリ用task roleは今回の調査では確認できない。ECR image puller roleはイメージ取得のためのroleであり、アプリからSecrets Managerを読むroleとして扱わない。

この案は秘密専用ストアから実行時取得する構成ではない。Lightsailのデプロイ情報にはenvironmentが含まれるので、その閲覧権限も秘密へアクセスする権限として扱う。デプロイ履歴にも注意し、ローテーション時は旧キーを失効させる。

### Alternatives

Secrets Managerを導入し、OIDCを使うCI側で取得してenvへ注入する方法は可能だが、今回の最小構成では必須にしない。アプリへAWS長期キーを配って実行時取得する構成は採用しない。

Sources:

- [Container APIのenvironment](https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_Container.html)
- [ECR image puller roleの用途](https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_ContainerServiceECRImagePullerRole.html)

## 6. イメージ配布とデプロイ権限

### Decision

LinuxコンテナイメージをLightsailのregistryへpushし、返却されたイメージ識別子をデプロイに使用する。SHAラベルとデプロイしたSHAを記録し、浮動のlatestだけで審査版を選ばない。AWS CLIと必要なlightsailctlの版を固定する。

### Rationale

別のECR構築を省ける。認可表に従い、`CreateContainerServiceDeployment`と`RegisterContainerImage`は対象ContainerService ARNへ限定する。`CreateContainerServiceRegistryLogin`、`GetContainerServices`、実際に使用する`GetContainerImages`や`GetContainerAPIMetadata`はリソース指定非対応のため別statementで扱う。使わないAPIの権限は与えない。通常のdeploy roleにサービス削除やIAM管理の権限を付けず、初期作成・廃止は運営手順として分ける。

これは必要権限の候補であり、CLIの実呼び出しを初回検証し、アクション単位で不足を調整する。

### Alternatives

ECR private repositoryも使用できるが、追加のrepositoryとpuller role設定を要するため、今回の初期構成では採用しない。

Sources:

- [Lightsailへのイメージpush](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-pushing-container-images.html)
- [Lightsailのアクションとリソース指定](https://docs.aws.amazon.com/service-authorization/latest/reference/list_lightsail.html)
- [一時registry login](https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_CreateContainerServiceRegistryLogin.html)

## 7. リクエストのタイムアウト

### Decision

ヘルスチェックのtimeoutを通常HTTPリクエストのtimeoutと混同しない。長時間の写真認識・判定は、planで非同期処理とpollingの採否を決める。同期処理を維持する場合は、AWS標準URLを通した遅延とタイムアウト後の再試行を公開前の必須確認にする。

### Rationale

今回参照したLightsail公式資料ではpublic endpointの通常HTTP要求の上限秒数を確認できなかった。別サービスのALB設定値をそのままLightsailへ適用できると仮定しない。クライアントがタイムアウトしてもサーバーや外部API側で処理が続く可能性があり、再試行による行動・課金要求の重複を防ぐ必要がある。

### Alternatives

非同期job＋pollingなら長い1本のHTTP接続への依存を減らせる。採用時はゲームごとのjob所有権、同時数、期限、再起動時の失効を定義する。

Sources:

- [public endpointとhealth checkの設定項目](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-container-services-deployments.html)

## 8. 期間終了時の削除

### Decision

期間終了後は開発・審査のcontainer serviceを削除し、残存リソースと課金対象を確認する。OpenAIキーの失効、GitHub Secrets、不要なOIDC roleの整理も廃止手順に含める。

### Rationale

Lightsail Containersは無効化中・デプロイなしでも課金され、停止だけでは終了しない。サービス削除でURL、イメージ、デプロイ履歴、ログも失われるので、必要な非秘密の検証記録は事前にリポジトリへ残す。

### Alternatives

サービスを無効化して保持する案は費用削減の目的を満たさないため採用しない。

Sources:

- [課金と削除の必要性](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-container-services.html)
- [サービス削除](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-deleting-container-services.html)

## 未検証ゲート

- Micro上の同時5人でCPU・メモリ・応答時間と写真変換を確認する。
- 標準HTTPS URL上で音声、実機撮影復帰、Cookie、セッション分離、6人目の拒否を確認する。
- 再読み込み、60秒の切断猶予、10分の体験期限、再起動失効を確認する。
- 認証付きdrainが全Live終了を確認でき、失敗時にdeployが中止されることを確認する。
- 旧版から新版への切替中に新規受付が重複しないこと、旧版音声が残らないことを確認する。強制kill時に同等の終了保証がないことを別に記録する。
- 写真認識・判定の遅延、HTTPタイムアウトと再試行、二重実行防止をAWS上で確認する。
- 本リポジトリのOIDC subject形式、対象Environment、最小IAM権限と実際のCLI操作を確認する。
- build context、静的配布物、CIログ、artifactに秘密がないことを確認する。
- AWSアカウント・リージョン・サービス名は実装時の運営設定で確定する。料金表の確認だけでリソース作成済みと扱わない。
- 削除手順を用意し、期間終了時に実削除と残存課金対象を確認する。
