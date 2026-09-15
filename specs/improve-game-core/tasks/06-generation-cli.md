# T06 既存ストーリー拡充モードと静的検証

Issue: #63 / Status: completed (T06単体)

- [x] 固定倉庫構成・13日用品・Astra生成設定
- [x] 構造化生成・固定条件検査・mock fixture
- [x] 生成前draft予約と候補一度固定
- [x] 厳密CLI解析と既存分岐保持
- [x] T06単体10/10・旧CLI回帰2/2成功
- [x] T07 runner統合（課金なしfresh実CLI3→6通し）

実API未実行。生成の意味評価と実pilot完了は未報告。

T07接続・continue/retry・評価/描画/採用のCLI接続は後続統合作業として継続。T06単体の成功を本編模擬play成功や実生成成功として扱わない。

## CLI統合検証（2026-09-15）

- 実CLI mainでexpand --config config/auto-mission/expand-default.json --mockを新規実行。初回3件・評価367 calls、exit 0 / pilot_reportedで停止。続いてexpand-continue --input <manifest> --mockを明示実行し、残6件と最終評価792 callsを追加。累積1159 calls、exit 0 / ready_for_adoption。
- 保存: runs/mission-expansion/ffeead6b-25e3-4e54-aaf3-a834c3d373ef/manifest.json、同report.html（2,749,025 bytes）。全9件mock25turn uncleared、3reviewers・9検証判定、全calls completed。実AI/実クリア/面白さの成功ではない。
- codeRevision 127db6d8e7621e531c84691e471751a085b344d6、dirtyDigest 755dd58531c247a0b4c4ec0fa65b325c9c95fb28f81c20a1e3a61ac0057fac92。続行完了後にcodeIdentity再取得して一致を確認。
- 評価中断からの明示再開、完了play非再演、旧evaluation-history保持、追加予算executions独立記録を追加。CLI再開5テスト成功、npm run check成功。旧未完了評価と通信予約を成功・ゼロへ書き換えない。
- 検証途中のINPUT_LIMITは未完了として保持し、評価入力の可逆共有参照と分割検証を実装後、新規runで再確認した。
- 全体最終gateはT10担当が実施。実API・採用・commit/push未実施。
