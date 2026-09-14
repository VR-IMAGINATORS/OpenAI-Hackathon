# 調査結果

- 会話版v2は6舞台、10障害、各3順序。Python状態を移行せず、Web用JSONから既存ScenarioV2へコンパイルする。
- 既存ScenarioCatalogは新規プレイごとに設定を読み、凍結する。この境界で抽選する。bootstrapもcurrentを呼ぶため、概要専用のpreviewを設ける。
- 既存game facts・factKeys・allowedTransitionsは部分進展に適合する。追加の完了条件で、successとclearedの矛盾を防ぐ。
- 現行画像promptは未公開障害のfactsも渡す。新カタログのみ公開済み障害へ制限する。
- 終了担当は別チェックアウトでEndingPacketとStoryEvidenceLedgerを作成中。こちらは既存の表示・音声出力経路を使い、型の重複定義を避ける。
- 既存AI/Node/React/認証を使うローカル統合で、新しいサービス・SDK選定や外部送信は不要。実APIの性能・品質はこの調査から推定しない。
