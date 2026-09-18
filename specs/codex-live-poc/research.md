# 調査結果（2026-09-18）

## 結論

App Serverの実験的音声RPCを使う接続PoCは実装可能。プレイヤーのChatGPT認証でgpt-live-1が動くこと、請求先/利用枠、本編の制御互換性は実測待ち。現在の公開Live APIにCodexログイントークンを転用する根拠は確認できておらず、その方式は実装しない。

## 根拠

- [GPT-Live公式ガイド](https://developers.openai.com/api/docs/guides/live): 公開APIのWebRTC構成は信頼できるサーバーとOpenAI project API keyを前提とする。既存ゲームのpackages/server/openai.tsもlive/sessionsへAPIキーで接続する。
- [ChatGPT Voice公式資料](https://learn.chatgpt.com/docs/features/voice): デスクトップのChat/Work/Codex音声はGPT-Live。対象プランとrollout/workspace条件がある。製品内での提供は、独自Webゲームへの埋込契約や任意アカウントの利用権を保証しない。
- [App Server公式資料](https://learn.chatgpt.com/docs/app-server): 認証と実験的APIの仕組みは説明されるが、参照時のページにはthread/realtimeの個別記述がない。
- ローカル固定版codex-cli 0.154.0-alpha.6.2の生成型（runs/codex-poc-schema）にはThreadRealtimeStartParams、WebRTC SDP、v3、model override、clientManagedHandoffs、appendText、appendSpeech、stop、started/sdp/error/closed通知が存在する。これは実装版の契約であり、安定した公開サポート保証ではない。
- 実バイナリのthread/realtime/listVoicesを未ログイン状態で実行し応答を確認。v1/v2のvoice配列を返した。音声RPCの存在確認であり、GPT-Live音声接続やv3の利用成功を示すものではない。

## 差分と未確定点

ユーザー実測で、モデル指定除去後の音声対話が成功。モデルを尋ねた際に `delegation.created` を観測し、その後の応答が止まった。委譲結果を音声へ戻す処理はPoCに未実装。相槌でも発話が継続し、自己申告にはLiveという語があったが、これだけでモデルを確定しない。

`appendSpeech` の生成型の説明は「append speakable text」であり、逐語読み上げの保証はない。ユーザー実測では固定文送信後に「聞こえてるよ」などの内容への返答となった。現行経路で確定セリフをそのまま読ませられるとは扱わず、送信への音声反応として評価する。ゲーム判断の結果を自然な音声へ反映できるか、確定事実を保持するか、委譲応答として返せるかは別途検証が必要。

実機で `Field session.model is not allowed for this Codex realtime session` を確認したため、音声のmodel指定を除去した。先に除去した独自promptが禁止されているという根拠は得られていない。音声はサービス標準のモデル・指示で接続を試し、ゲームのキャラクター・振る舞い指定への対応可否は別途検証する。v3は維持する。このエラーだけで全アカウント・全バージョンに同じ制限があるとは判断しない。

既存ブラウザはsession.started、session.*_transcript.delta、session.delegation.createdを使う。App Serverはthread-scoped通知とSDPの非同期応答で、Liveのsession.close確認とは異なる停止契約を持つ。単にURLやBearerを差し替えて同等とは扱えない。

PoCは音声モデルを指定せず、versionをv3に固定。接続先が報告するモデルが取れれば併記し、取れなければ「未報告」とする。gpt-live-1系列以外が報告されたら停止する。音が出ただけでモデル同定やサブスク枠内課金を証明したとは扱わない。
