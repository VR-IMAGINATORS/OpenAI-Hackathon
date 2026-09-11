# 実装計画

状態: ユーザー承認済みの事前整理と追加回答を具体化。重要な実装・安全性は別Solがレビューする。

## 構成

skills/call-to-past/にSKILL.md、agents/openai.yaml、assets/masters.json、references、scripts、testsを置く。Python3.10+の標準ライブラリを基本とし、画像確認にはPillow、動画送信には同梱H3ランタイムとfal_client、動画QCにはffprobe/ffmpegを使う。イベント画像は同梱Flare CLIからOpenAI Images APIを使う。CLIは隔離した検証済みSDK範囲、無課金preflight、OpenAI用キーの厳密選択、承認manifest照合、max_retries=0、新規出力の排他的予約、PNG検証を担当する。

game.pyはローカルCLIとimport可能なAPI。開始→prepare→認識確認→判定→commit→画像添付→次行動、終端では物語→H3→動画提示→リザルト。pending ID、revision、現在障害を照合し、ファイルロック下の原子的置換で状態を確定する。新規画像はセッションへコピーしハッシュを保存。判定JSONには新規物、合成、状態変化、成功boolean、根拠を記載する。回数や結末の値は受け付けない。

media.pyはH3用の正確な送信プラン作成・承認記録・一度だけ送信・同じrequest IDの回収を提供する。既存h3-videoを依存として利用し、その基本スクリプトの不足する素材/価格ハッシュ束縛を補う。取得時のreceiptに承認マニフェスト・request ID・開始/終了画像・実動画のハッシュを記録し、liveの動画添付時に照合する。ネットワークはsubmit/status/resultのみ。ローカルリハーサルの完了を実生成合格とは記録しない。

イベント画像は次の行動や物語作成へ進む前に確定し、それ以後の差替え・イベント免除を拒否する。物語packetは最後のイベント画像と最終在庫を含み、最後の画像が免除なら過去画像へ勝手に戻らない。保存先はresolve前の入力と既存の親ディレクトリを検査し、symlink/junction経由の書込みを拒否する。

## 分担と検証

Astra: 要件統合、仕様、会話スキル、接続と配布。Sol実装: 状態機械と判定契約、メディア送信制御。Terra: 合意済みスキーマのマスター作成。別Sol: 仕様/安全性/コードと独立手順確認。各編集先を分離する。

テストはunittestで境界、公開範囲、冪等性、持越し・複合物、4行動、全エンド、同設定リトライ、不正入力と外部送信スタブを検証。全抽選候補は各障害を独立した新規道具1〜2枚で解ける代表解を持つため3手で成立し、組み合わせ依存を抽選の前提にしない。創意解法の納得感は別の会話評価で確認。

SpecWorkflowのcreate-feature-spec→plan→tasks本文を取得して適用。取得元はspec-workflow plugin2.5.0、commit ebfca8698eec718f67bae005a5518ea6a27cf048。プラグインのインストール/フック稼働は未確認。タスクはプロジェクトAGENTS.mdと承認済みローカル案を優先し、GitHub Issueへ投稿しない。dev-workflowのモデル/保存場所の一般既定より今回のAGENTS.mdのAstra/Sol分担とspecs配下を優先。review-orchestrator一式の実行完了を主張せず、独立Solレビューの実測結果を記録する。
