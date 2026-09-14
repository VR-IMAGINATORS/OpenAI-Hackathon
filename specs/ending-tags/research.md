# 調査結果

- 初期案はcreateEndingDesignでタグも同時生成していたが、脚本生成・検証失敗でタグが失われた。修正ではcreateEndingText→保存→createEndingDesignの順に分離する。後者は保存済み文章と同じ抽出済み証拠を使用し、伏線抽出を繰り返さない。
- 現行EndingJobs.prepareは画像生成後に文章を返す。文章公開を画像生成前に移す必要がある。
- EndingVideoはshowStoryで再生終了/操作待ち。これを自動表示にする。
- 既存AiService.registerEndingはfal設定とは独立し、story最大1回・全体Responses予算を持つ。文章のみでも同じpermitを利用できる。
- 動画無効時は結果保持が通常300秒、設定上最小150秒。文章のみのジョブ期限は最大120秒にする。
- 既存タグなしEndingStoryも表示可能にし、移行途中や既存fixtureの読み取りを壊さない。

ローカルコード調査のみ。実APIの成功・文章品質は未検証。
