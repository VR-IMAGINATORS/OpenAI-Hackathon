# 導入画像と対話チュートリアル

ユーザー要望により追加。固定のダミー画像で、リアルタイム生成や現在のシナリオの正確な状態を示すものではない。

## 動作
音声接続のタップとマイク許可後、session.startedを待ち約1.5秒でlocal生成のsession.commentary.appendを送る。最初は「聞こえる…？」と呼びかけて返事を待つ。Liveの指示は状況説明→撮影→使い方の相談を一つずつ案内する。ユーザーが先に話した場合は呼びかけを重ねない。
同じゲームの呼びかけ送信済みをsessionStorageに記録し、再接続/同一タブの再読み込みで繰り返さない。再生がブラウザにブロックされた場合は再生ボタンを表示する。
briefing中も写真を送れるが時計は開始しない。本編開始ボタンで時計を開始し、Liveへ導入終了の状態を伝える。攻略実行は本編の明示ボタンだけ。

## 画像
保存先: apps/web/public/images/trapped-silhouette.png
生成方式: 内蔵image_gen。生成後にコピーし、元画像も保持。

生成プロンプト:
> Use case: stylized-concept. Create a landscape cinematic game illustration to use as a small mobile web escape-game opening still. A single anonymous adult human silhouette trapped inside a dark storage room, standing near a firmly closed industrial door, holding a faintly glowing phone as if calling for help. Face unreadable in silhouette. Restrained desaturated green-black and soft mint light matching a dark green phone-call UI. Light leaks through a narrow high window; restrained atmospheric grain, strong readable silhouette, suspenseful but not horror or violent. Center composition usable in a wide 16:9 crop, human and closed door both clearly visible. No text, no logo, no UI, no watermark. This is a temporary fictional scene asset, not a screenshot.

## 検証
54件の自動テストとビルド成功。Playwrightのfake Liveで初回commentary送信・再接続/再読み込みの重複防止・画像読込・本編前の撮影と時計据置を確認。スマホ幅の画面を目視確認。今回の導入音声の実API/実機検証は未実施。
ユーザーから、変更前のスマホアクセス・マイク入力・GPT-Live音声応答は動作確認済みとの報告あり。これを今回のチュートリアル音声の検証完了とは扱わない。
