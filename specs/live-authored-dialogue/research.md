# 調査メモ

- OpenAI公式: https://developers.openai.com/api/docs/guides/live-delegation — commentaryは発話させる情報でありLiveが言い換える。thinkingは追加時に発話しない情報。各appendは500 tokensまで。
- OpenAI公式: https://developers.openai.com/api/docs/guides/live-prompting — 短い矛盾のない指示、発音の明示指定、逐語再生を保証しないこと。
- 現行コードの480 UTF-8 bytes上限は維持。長文は内部資料に分割し、発話の起点を一つにする。
- 雑談を完全にサーバー外にするとgame-creditsの応答単位の受付・精算を迂回するため、受付だけ残して台詞生成をLiveへ返す。
- 純粋なthinkingへの置換では返答が開始しないため採用しない。確定結果には最後のcommentaryを使用する。
