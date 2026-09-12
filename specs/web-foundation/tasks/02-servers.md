# 02 ローカルと中継
spec.md F04〜F09、plan.md 2/3、contracts/openapi.yamlを参照。依存01の共通型。
DoD: 起動と通信、auth required/none、失効/上限/サイズ/timeout/Host/Origin、秘密非露出をHTTPで確認。
## 工程
- [x] config/app/indexの作成
- [x] 認証/通信のテスト
- [x] mainへの結果報告
## 実行サブタスク
- [x] 安全な環境設定とHTTP共通処理
- [x] 中継の認証・期限・上限・モック
- [x] ローカルの公開設定・中継通信・画面配信
- [x] configと実HTTPの境界テスト



## 検証記録
2026-09-12: `tsx --test tests/server-config.test.ts tests/servers.test.ts` 19件成功。実HTTPはすべてephemeral loopback portを使用。required/none・失効・token/全体/認証上限・Host/Origin・32KB要求/応答・redirect拒否・不正応答・停止・2操作と本文読込を含むtimeout・秘密非露出・環境設定分離を確認。
`tsc --noEmit`でも型エラー出力なし。全体build、ブラウザUI、起動/子プロセス停止はmain担当。実APIは呼び出していない。
