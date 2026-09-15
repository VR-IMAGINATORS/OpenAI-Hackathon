# 実装前リサーチ

調査日: 2026-09-15。コードの読取と公式資料の確認。実API・音声計測は未実施。

## 規模・前提

合意済みのハッカソン向け改善。既存の統合サーバー、メモリ状態、React/WebRTCを維持する。新インフラ、永続DB、モデルの追加常駐は導入しない。既存の認証・所有権・上限を維持し、状態競合と秘密非公開を自動検証、聴感を実機確認する。

## R1: 写真を実行根拠として扱う

Decision: 実行根拠を音声と受信済み写真の判別共用体に拡張する。写真の認識終了後、共通の意図判断・行動処理へ入れる。架空のLive委譲を作らない。
Rationale: executeIntentSchema/actionTicketSchemaは音声evidenceSeq必須、IntentCoordinator.executeもDelegationRequest必須。現状の型のまま空の根拠や架空IDを渡すと重複抑止が壊れる。
Alternatives: 必ずLiveの再委譲を待つ方式は、写真だけで自然に進む要求を再び取りこぼす可能性がある。写真専用の別ゲームループは重複と状態不一致を増やす。
参照: packages/shared/conversation.ts、apps/local-server/intent-coordinator.ts、hosted-runtime.tsのphotos。

## R2: 結果確定前の訂正

Decision: 行動結果を計算してから同期的に確定する境界を設ける。判定中の発話は制御判断へ別に配送し、未解決の訂正候補があれば確定を保留する。
Rationale: 現行ConversationLedgerはjudging中の発話を実行不適格とし、IntentCoordinatorも判定終了まで待つ。プロンプト変更だけでは処理中の訂正を拾えない。
Alternatives: 音声割り込みだけでバックエンドを止めたと扱う方式は不可。すべての発話で行動を破棄すると「聞こえてる？」でも実行を失うため、保留と取り消しを区別する。
制約: サーバーへ未到着の発話を遡って保証しない。実際の発話から配送までの遅延はPC/モバイルで測る。

## R3: 秘密の分離

Decision: 設定の既知情報と開示条件を構造化し、サーバーが開示済み集合を所有する。会話モデルへの入力は一つの公開投影関数から構築する。
Rationale: storyNarrationにはmysteryToExploreとdirectionがあり、現在Liveへ送る経路がある。game-aiはmechanism等を必要とする一方、その自由文をそのまま読み上げると境界を越える。
Alternatives: 秘密を渡して「言わないで」と指示するだけではH13を満たさない。全ての情報を隠すと質問にも答えられない。
対策: 秘密を扱う判定は構造化された状態差分を出す。発話生成は開示済み事実・検証済み行動結果から別に行い、隠し設定由来の自由文を直接読まない。

## R4: Liveの通知と発話の区切り

公式資料で確認: delegation_id:nullは一般文脈のappendに使用できる。既存IDは実際の委譲に対応させる。instructionsの途中追加は発話へ割り込む可能性があり、appendのackは再生終了ではない。文字起こし間隔も無音や確定ターンの根拠にはならない。バックエンド処理はアプリ側で制御する。

Decision: 新しいLiveの発話終了イベントを仮定せず、Web Audio AnalyserNodeで入出力の音声活動をブラウザ内で推定する。元のWebRTCトラックとAudio要素による再生は維持し、分析分岐をスピーカーに接続しない。通常警告は両者の短い無音待ち、最終警告は有限待機と短い切替表現。毎回のinstructions.appendをやめ、開始時に口調規則を与え、警告内容だけcommentaryで送る。
Rationale: 実音声の活動は文字起こし到着より発話中かの判断に適する。ただし息継ぎと文末の厳密な区別・ネットワーク伝送後の割り込み回避は保証できない。
Alternatives: 音声を止めて警告を流す、TTSへ置き換える、文字起こしだけで無音判定する方式は採らない。全文バッファリングは会話遅延を増やす。
未実測への対応: 実装の最初にPC Chromeとスマホで分析分岐の動作・自動再生制約・警告聴感を確認する。失敗時に無音と偽装しない。unknownとして扱い、通常警告は保留、最終警告は待機上限で通知を試みる。完全に切れない保証はしない。

## R5: コストと再試行

Decision: 判定と発話生成を役割で分けるが、毎ターン多数のモデルを呼ぶ委員会方式は使わない。写真認識→意図判断→必要時のみ行動判定→公開情報だけの発話生成。質問は必要時のみ開示選択を行う。
Rationale: 隠し機構を知る判定器から自由文を直接Liveへ返す方式を止めるため、行動結果の発話生成は追加呼出しになりうる。精度・応答時間・利用量は実測対象。
再試行は同一operationにつき追加一度。分類、判定、発話生成のどこで失敗しても無制限に掛け合わせない。行動が確定していれば発話だけ回復する。上流の自動再試行も予算内へ含め、既存絶対期限・費用上限を延長しない。

## 参照

- [OpenAI: Managing GPT-Live sessions](https://developers.openai.com/api/docs/guides/live-conversations)
- [OpenAI: Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation)
- [W3C: Web Audio AnalyserNode](https://www.w3.org/TR/webaudio/#AnalyserNode)
- apps/web/src/live.ts: Audio要素、WebRTC、転送するイベントの限定
- apps/local-server/hosted-runtime.ts: tick、event、photos、speak、sendFacts
- apps/local-server/live-outbox.ts: 有限outbox、ackはブラウザ送信済み位置

未決定の製品要件はなし。APIの聴感・分析の実機成立性は上記の検証ゲートで扱う。調査結果を実装成功と記録しない。
