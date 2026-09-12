# Call to the Past: Flare preflight runtime

2026-09-12。ユーザーから、画像生成前にOpenAI SDKの事前準備をスキルへ組み込む提案を受け、イベント画像について旧native経路を置き換える。

- uv runの隔離環境で検証済み範囲のOpenAI SDKとPillowを生成前に用意する。常設Pythonへ依存しない。
- scripts/flare_image.py --preflight-onlyは画像APIを呼ばず、Python、依存版、OpenAI用キー、プロンプト、参照画像、出力先、SDK引数を検査する。
- 資格情報ファイルは OPENAI_API_KEY、完全一致の #OpenAI または #GPT 見出しだけを認め、任意の sk-* 探索をしない。候補0件・複数件は拒否する。
- preflight結果のモデル・設定・素材hash・出力先と、最新価格・出典・確認日時を提示して具体的承認を得る。実送信は一致する承認JSONを必須にする。
- gpt-image-2.5-flare、low、1536x1024、1枚、max_retries=0を固定する。出力は新規パスを排他的に予約し、リンク経路を拒否する。
- API例外は自動再送せず、request IDと予約出力を残して要確認とする。応答は厳密Base64とPNG検証後に保存する。
- preflightはモデルが当該アカウントで利用可能かを保証しない。これは実リクエスト時にのみ確定する。

H3動画の送信・承認・回収契約は変更しない。