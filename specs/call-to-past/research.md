# 調査・採用判断

- Codex native imagegenの公開引数はpromptと参照画像。モデル指定欄なし。Flare指定はできない。native生成として実際の経路をログへ残す。
- collaborationはgpt-5.6-solとhigh指定を公開。クリーンなSol subagentを判定に使い、指定できない環境ではその制約を説明する。
- H3 Turbo image-to-videoは開始画像と任意終了画像、15秒に対応。既存h3-videoは768Pに対応。https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api
- 既存generate_h3.pyは送信前に台帳を確保、request IDでstatus/resultを取得。ラッパーで承認と素材/条件のハッシュを追加照合。https://fal.ai/docs/documentation/model-apis/inference/queue
- 価格を固定しない。実送信時に公式価格と換算日時を確認。Codex利用枠は動画API料金に含まれず、動画価格を1プレイ総額とは呼ばない。
- Python3.13、fal_client、Pillowをローカルで確認済み。OpenAI API SDKは初回不要。認証値は文書へ保存しない。
