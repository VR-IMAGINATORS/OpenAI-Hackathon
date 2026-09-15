# 実装前調査

- GameSession が時計・結果・写真受領、GameRuntime が再送キャッシュと音声の意味分類を所有する。残高は GameSession の台帳に集約する。
- Live受信契約には input/output transcript.delta と delegation.created があるが、確定turnIdはない。delta件数を課金単位にせず、既存の IntentCoordinator の有効 evidenceSeq と consult/execute を使う。雑談もconsultの対象にする。委譲欠落救済も同じ精算経路を使う。
- 写真は認識後の非同期 processPhoto から自動行動する。写真費用を予約し、自動行動の確定まで0による終了を待つ。AI失敗は予約解除、完了したゲーム内の失敗行動は消費する。
- 既存の ended コールバックは解除数から結果を作る。credits_exhausted を内部理由に加え、リザルトの構成・評価は変更しない。
- 通常の承認・ブランチ作成は今回の明示実装指示と現ブランチ指定を優先。AGENTS.md に従いマルチレビューは実施しない。会話境界の読み取り専用技術調査にサブエージェントを使用。
