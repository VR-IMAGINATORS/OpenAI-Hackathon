# データモデル・CLI境界

master: version, scenes[], gimmicks[], items[]。sceneはid/name/description/anchor/mystery/sequences（3つのgimmick IDの配列の配列）。gimmickはid/name/observation/hints（3段階）/mechanism/acceptance/rejection/examples。itemはid/name/properties/uses。

session: version, id, mode, seed, master_snapshot, scenario（scene・order・mystery）, revision, attempts, cleared, inventory, pending, events, ending。inventoryには一意ID、name/properties、origin/構成元、available/broken/consumed/combined状態。eventは一意ID、対象障害、intent、photo情報、判定、前後の状態、画像レコード。

CLIはstart/context/prepare/commit/cancel-pending/attach-image/ending-packet/attach-ending/attach-video/mark-video-shown/result/retryを想定。実際の構文はscripts/game.py --helpとreferences/cli.mdを正とし実装後同期する。キャンセルは記録してpendingを終了させるだけで保存済み写真を削除しない。liveでは画像欠落中に次行動へ進まず、動画未提示のresultは結果種別を出さない。rehearsalは実生成と区別した上でテスト用の進行を可能にする。

recognitionはphoto indexごとに名前、観察できる物性、confidenceと確認必要性。judge入力は現在障害、pending行動、認識、指定された在庫。出力はpending event_id/revision/gimmick_id、success:boolean、新規具現化物、combine指定と構成元、inventory updates、reason。正確なフィールドはcore実装とともにJSON例で固定する。未来の全障害や秘密のエンド種別を各ターン画像担当へ渡さない。

WebサーバーなしのためOpenAPIは適用外。CLIのJSON入出力例と厳密な実行時検証を契約とする。

設計レビュー追補: gimmick.reference_solutionsはitem_ids、required_properties、use、photo_count、preconditions、consumes、breaks、clears、postconditionsを持つ。独立基準解のpreconditionsは空とし、各sceneの全許可順序を機械検証する。pending認識→新規物のphoto indexを一致確認し、指定されていない在庫更新は拒否する。

メディアはpending/ready/failed/waivedを記録し、利用者の明示選択による文章代替を許可する。waivedは実生成達成ではない。保存先IDのallowlist、解決後境界、symlink/reparse拒否、対応画像形式とサイズ上限は実装契約に含める。

物語・タイトル・工夫への評価は履歴から都度作成してattach-storyに保存する。エンド種別・行動数・解除数はその文章から変更できない。イベント画像の修正版は次のprepareや物語作成へ進む前に限り、過去ファイルを保持して同じeventに追記し、回数は変えない。個別イベントの画像waiveも同じ期限で明示理由を記録して文章版へ進む。ending-packetは最後のイベント画像と最終在庫を含む。

H3 resultのreceiptはversion/endpoint/request_id/manifest_sha256/start_image_sha256/end_image_sha256/video（file/sha256/bytes）/completed_atを持つ。送信時のsubmission-attempt.approval_sha256と現approval.json、saved request ID、success記録、承認素材を照合。live attach-videoはh3-runとreceiptを要求し、動画本体と終了画像を検証する。
