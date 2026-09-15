# T10 / Issue #67 — 課金なし統合検証

状態: 課金なし範囲の検証完了、T10全体はlive/実機未実施（2026-09-15）。実API・課金・実機・マルチレビューは実施しない。

## 実行サブタスク

- [x] npm run check
- [x] npm test
- [x] npm run build
- [x] T06/T08担当のmock初回3→明示continue6→評価→report、およびretry/新版の個別テスト結果を確認
- [x] mock通信台帳から処理規模と予約上限の参考値を整理
- [x] 失敗・未検証項目を区別して親へ共有

## 統合状況

CLI統合はT06/T08担当が作業中。一連確認の結果共有を依頼済み。単体テストの成功をCLI統合の成功として扱わない。verification.mdは親が管理する。

## ゲート結果（2026-09-15・CLI最終統合前）

- npm run check: 成功。TypeScript、v1/v2シナリオ、18構成のv3カタログ、core configを検証。
- npm test: 841/841成功、fail/cancel/skipすべて0（約12秒）。
- npm run build: 成功。check、Vite UI、tsconfig.server.jsonのサーバービルド。
- T08対象テスト: 担当報告7/7成功。実25ターンCLI評価入力の64KiB超過に対し、sharedValues/$refで可逆重複排除を追加済み。CLI一連はT06で実行中。

## 制限の参考（コード固定値）

| scope | call上限 | 出力token上限 | 全体期限 | 1リクエスト期限 | 1リクエスト入力 |
|---|---:|---:|---:|---:|---:|
| static | 12 | 60,000 | 10分 | 3分 | 65,536 bytes |
| play | 200 | 100,000 | 20分 | 3分 | 65,536 bytes |
| pilot | 650 | 350,000 | 75分 | 3分 | 65,536 bytes |
| remaining | 1,250 | 650,000 | 150分 | 3分 | 65,536 bytes |

これらは最大制限であり期待使用量ではない。費用は送信前に保守的入力token数×input単価×cache-write倍率とmax_output_tokens×output単価を予約し、実usage確定時に精算する。不明usageは予約を保持する。mock台帳のusage値は合成値であり、実費やliveの必要予算には使わない。role別予約規模は統合runの結果待ち。

## CLI統合の未完了結果（中間）

T06担当のrun `1d74081c-109a-41e7-bd2f-a7b445a2f3ad` は、3プレイ各25ターン（各100 call）完了後、独立評価中にINPUT_LIMITでexit 2 / incomplete。残り6件や最終評価の成功を記録しない。T08担当が入力サイズを再調査中。

参照元は担当の一時ディレクトリ `C:/Users/edo_m/AppData/Local/Temp/expand-integrated-xeLpBX/1d74081c-109a-41e7-bd2f-a7b445a2f3ad/manifest.json`。この中間集計は以下表に保持。`10-mock-reservations.json` は後述の成功した最終runで更新済み。

| 処理 | call数 | 最大1call事前予約 USD | 全call予約額の単純合算 USD |
|---|---:|---:|---:|
| 生成 | 1 | 1.4048625 | 1.4048625 |
| player | 75 | 0.069975 | 2.257358 |
| 本編分類 | 75 | 0.0719425 | 4.831620 |
| 開示選択 | 75 | 0.0198825 | 1.4911875 |
| 調査回答 | 75 | 0.0275575 | 2.0668125 |
| 独立評価（途中） | 48 | 0.490495 | 12.0213995 |
| 全体（未完了） | 349 | 1.4048625 | 24.07324 |

**この金額は実費見積ではない。** 固定された料金表にUTF-8 byte+1024の保守的入力上限と要求最大出力を掛けた事前予約額の合算で、usage精算前の参考規模。全callを同時予約する意味でもなく、今後必要な評価・検証・修正の額も含まない。mockの実usageは合成値のため、live予算の推薦や実モデル費用の断言には使用しない。

## 残る検証

- CLI一連のサイズ境界解消、残り6件、最終評価・report・retry・新版の確認。
- 実API初回拡充＋3プレイ計測、必要なら明示継続の6プレイ。
- PC Chrome/スマホ実機のGPT-Live・実写真・初期説明・調査・訂正・警告・画像。
- 人間による面白さの確認。

T10全体はlive/実機を含むため未完了。今回担当は課金なし検証だけを実施する。

## サイズ境界の解消（T08担当報告）

保存済み3×25turn記録に対し、独立3roleは各15segments＋同role統合、Astraは各未クリアplayを5segments＋統合へ分割。66評価callでstatus complete、最大input65,442 bytes（上限65,536）。元記録の全turn coverage guard成功。CLI全体再実行はT06側で継続中。この再実行で先の未完了runを成功へ書き換えたわけではない。

git diff --check成功（既存Windows改行警告のみ、空白エラーなし）。

## 最終検証（全担当コード固定後）

- npm run check: exit 0。
- npm test: exit 0、848/848成功、fail/cancel/skipすべて0（約11.5秒）。
- npm run build: exit 0、UI 127 modulesとサーバービルド成功。
- 新規mock run: `runs/mission-expansion/ffeead6b-25e3-4e54-aaf3-a834c3d373ef/manifest.json`。実codeIdentityの保存値と再取得値が一致（T06確認）。
- 初回CLI: exit 0、pilot_reported、3plays、367calls。
- 明示expand-continue: exit 0、ready_for_adoption、9plays、1,159calls（追加792）。全playは25turnの通常未クリア、全call completed。独立評価3reviews＋9verifiedFindings complete。
- report.html 2,749,025 bytesを保存。実際のadoptは実施していない。
- retryはsimulation/budgetの別attempt・原記録不変テスト、評価API失敗からの再開と完了play非再演・旧評価履歴・追加予算履歴はT06追加5テストで確認。新版はT08のconfirmed defectだけ最大2回・immutable revision・awaiting_pilot停止テストで確認。新規9件runの中で故意に失敗/修正を起こしたものではない。

### 成功runの参考規模

| 区間 | call数 | 予約額単純合算 USD | 最大1call予約 USD |
|---|---:|---:|---:|
| 初回3＋独立評価/検証 | 367 | 49.2266775 | 1.430825 |
| 明示継続6＋9件最終評価/検証 | 792 | 132.19287675 | 1.43085 |
| 全体 | 1,159 | 181.41955425 | 1.43085 |

初回は生成1、player/分類/開示選択/調査回答が各75、独立評価48、検証18。継続はplayer/分類/開示選択/調査回答が各150、独立評価138、検証54。詳細は `10-mock-reservations.json`。合成usageを使うmockのため、これらは実費・必要live予算の予測ではない。全callの最大予約額を足した参考規模であり、同時予約額でもない。

残項目のCLI一連サイズ制限は解消済み。live初回/残り6、PC/スマホ音声/実写真、人間の面白さは未実施として保持。
