# 統合時の判断

- 実機でsession.modelが拒否され、除去すると音声会話と委譲が動いた。ユーザー合意によりLive経路成立としてゲーム統合へ進む。
- 固定版のThreadRealtimeStartParamsではrealtimeStartInstructionsはバックエンドCodexへの指示で、音声の指示と同一視しない。初期化はゲームの公開liveInstructionsを既存のsession.instructions.append経路へ送る。startのprompt/model/voiceの上書きはしない。
- WebRTCのoai-eventsはブラウザから音声接続へ直接つながる。既存のsession入力文字起こし・client delegation・thinking/commentary outboxを使う。thread/realtime通知から委譲や文字起こしを捏造しない。
- 同一worker上で音声threadと判断threadを分離。音声threadの通知を専用consumerで保持し、判断journalの消去や上限と干渉させない。判断は既存のread-only JSON schema応答を維持。
- APIなしの保証は専用transportがpublic APIの実装を持たないことと、画像・動画・結末生成を開始しないことで担保する。音声と判断の利用枠の内訳は未確定。
- [Liveの委譲仕様](https://developers.openai.com/api/docs/guides/live-delegation): instructions/thinking/commentary append、委譲ID、結果の言い換え。Codex経路の実機互換性は別途確認する。

マルチレビューはAGENTS.mdに従い未実施。読み取り専用のプロトコル調査を1エージェントに委譲し、既存コードと生成型の根拠を確認した。
