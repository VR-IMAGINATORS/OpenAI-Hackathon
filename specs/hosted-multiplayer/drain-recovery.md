# デプロイ前の終了確認と再実行の復旧

2026-09-16。対象は [失敗した開発環境デプロイ](https://github.com/VR-IMAGINATORS/OpenAI-Hackathon/actions/runs/35009450057)。実装開始時のローカルは `56fcdbe`、作業ブランチは `codex/fix-deploy-drain`。

## 確認できた事実

- マージ `a569f5424bbf705482ee24f9693c92c9fadea166` のbuildは成功し、deployは `Drain unconfirmed; deployment stopped` で停止した。ローカル `56fcdbe` と同マージのファイル内容に差はない。
- 公開 `/healthz` は旧版 `d3c9d9dd783c31a25a28160f01c8d702f4c988bb` を返した。今回の配信はコンテナ切替前に停止した。
- AWS Tokyoの `call-to-the-past-dev` はdeployment 13、image `:call-to-the-past-dev.sha-d3c9d9dd783c31a25a28160f01c8d702f4c988bb.14` のまま。ログは2026-09-15 18:47:50 UTCに `drain_started` と `drain_finished count=1` を記録している。更新待ちを始める前から残留していた可能性が高い。
- AWSログイン後、CloudShellから既存OPS_TOKENをメモリ内で取得し、値を表示せず運用APIをGETした。`readyToDeploy=false, remaining=1, bootId=a3dfff4c-1596-4dea-81b7-6c945248acdd`。旧ログ・運用APIは内訳を返さず、上流の終了状態は確定できない。
- 旧ログには終了待ちの内訳がない。失敗した実行で音声・画像・動画のどれが残ったかは、ログだけでは確定できない。
- `AiService.closeReservation` は待機期限を超えた元Promiseの遅延成功を反映していなかった。さらに `PlayRegistry` は終了未確認のplayを隔離した後、確定終了へ再調停する経路がなかった。
- 再実行は新しいrequest IDでdrainを要求するため、旧版の `DRAIN_ALREADY_STARTED` 応答で止まる。既存のdrainに参加して確認を続ける経路が必要。

## 完了条件

1. サーバーから既存のGPT-Live WebRTCセッションへ認証済みsidebandを接続し、`session.close` に対する `session.closed` を終了の根拠にする。会話や委譲の実行主体は変更しない。
2. 接続切断・タイムアウト・HTTP成功だけで終了扱いにしない。後から確定イベントが届いた場合は一度だけ予約を解放する。終了未確認・作成の受理不明は保持する。
3. 隔離されたplayも、AI通信層で終了が確定すれば終了状態に収束する。破棄済みゲームの再開やデータ復元はしない。
4. デプロイ再実行は `DRAIN_ALREADY_STARTED` の409だけを扱い、同じversion/bootの既存drainを監視する。別の409、認証失敗、version/boot変更は拒否する。
5. `readyToDeploy=true` かつ `remaining=0`、120秒上限、配信後のimage/SHA照合は維持する。自動resume・強制解放・未確認のままの配信は追加しない。
6. 運用APIとActionsログへ残数と種別ごとの数を出す。秘密、写真、音声、会話、provider session IDは出さない。旧版の内訳がない応答も扱えるようにする。

## 一次情報と設計判断

- [OpenAI Server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live): WebRTCで返されたsession IDを使い、サーバーが `/v1/live/sessions/{session_id}/attach` へ接続できる。終了要求と完了イベントを同じ接続で扱う。
- [OpenAI Managing GPT-Live sessions](https://developers.openai.com/api/docs/guides/live-conversations#usage-and-graceful-close): `session.closed` が終了確定を示し、接続切断だけでは確定しない。
- [OpenAI hangup](https://developers.openai.com/api/reference/resources/live/subresources/sessions/methods/hangup): 個別API説明はSIP callの終了を記す。WebRTCで常に失敗するとは断定せず、WebRTCでも明示されているsidebandと完了イベントを使う。

## 検証と配信

- `npm test`: 959/959成功。対象5ファイルの終了・配信回帰は74/74成功。
- `npm run check`、`npm run build`: 成功。
- Prettier: Windows checkoutの既存CRLFにより通常の `format:check` は不一致。既存ファイルを一括変更せず、同じ対象へ `--end-of-line=auto` を指定した整形検査が成功。変更ファイルは通常のPrettierで整形済み。
- 新規テストでは、実装済みtransport + 模擬WebSocket + AiService + PlayRegistryを接続して、3回の待機失敗後の完了、遅い作成応答後の終了、別ID・不正イベントの拒否、監視期限後の未確認保持、早期終了の記録保持を確認した。OpenAIへの有料セッション作成は行っていない。
- sidebandは `ws` 8.21.3を使用。終了待機は1回15秒、監視は最初の要求から120秒で打ち切る。未確認の予約を期限だけで解放しない。完了記録はAiServiceの反映時に解放するため、固定TTLや容量確保による破棄はしない。
- Solによる独立レビューは利用上限で中断し、最終差分の独立レビューは未完了。主担当が差分・実装・公式イベント仕様を照合し、上記の回帰を追加した。

旧プロセスのメモリにすでに残った隔離状態は、新しいコードを書いただけでは変わらない。通常のmainマージだけでは旧版の残数1を待って再び止まる可能性がある。新しいコードの配信成功・実GPT-Liveの終了は未検証である。

一度限りの復旧案は、対象サービスの現在のimageと設定を照合して同じ構成のコンテナを作り直し、残数0と新bootを確認してから通常の修正版配信へ進むこと。これはプレイ状態・Cookie・プロセス単位の利用回数をリセットし、上流の終了確認を証明する操作ではない。実行前にユーザーの判断が必要。コンテナ再作成・強制解放・mainへのpush/merge・Actions再実行は行っていない。
