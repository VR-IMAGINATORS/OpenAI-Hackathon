# P3: 物語・判定・画像

対象: plan.md P3、spec.md S03〜S08。担当ファイル: apps/local-server/story.ts、live.ts、hosted-runtime.ts、core-intent-ai.ts、game-ai.ts、game.ts、packages/server/image-service.ts、tests/story-runtime.test.ts。

DoD: 日英で舞台固有の導入と謎、完全解除数による語り、相談に必要な世界観、現在障害の機構・ヒント、完了factの検査、画像の後続障害先出し防止。既存音声・部分進展・道具再利用を保持。動画やEndingPacketを作らない。工程ごとにチェックを記録する。前提の矛盾・範囲拡大があれば親へ報告する。

## 実施記録（2026-09-14）

- [x] StoryContextから日英の導入、公開文脈、完全解除数に対応する語りの方向性を構成。
- [x] 最初の表示メッセージとLiveのopeningMessageに同じ舞台・メイ・初期の手がかりを使用。導入は通信と道具具現化の短い説明へ絞り、世界設定全文は相談文脈に保持。生の演出指示を表示履歴へ登録しない。
- [x] 完全解除後だけLiveへ物語段階の更新と短い自然な反応の指示を渡し、現在の障害の観察を通知。
- [x] 世界観相談を公開文脈に限定し、明示的に求めた場合のみ現在障害の1段階分のヒントを渡す。ヒント段階は部分進展をまたいで保持し、次の障害でリセット。
- [x] 判定へ現在障害の機構・ヒント・completionFactを渡す。successと完了factが矛盾する応答、後続障害のfact変更は行動消費前に拒否。
- [x] 画像生成・検査のfactを公開済み障害までに絞り、選出舞台・人物・表示済み初期の手がかりを画像生成へ渡す。
- [x] `npx.cmd tsc --noEmit` 成功。
- [x] 担当ファイルをPrettierで整形。
- [x] `npx.cmd tsx --test tests/story-runtime.test.ts tests/core-game.test.ts tests/core-consult.test.ts tests/core-runtime.test.ts`：44件成功。全10障害の部分→完了、3解除・4行動、初期表示の日英、世界設定を増やしても導入が長くならないこと、後続ヒント/機構/factの非送信、現在障害の音声通知、ヒント段階、既存音声予約フローを模擬AIで検証。
- [ ] 実AIによる物語の自然さ・実音声・実機・生成画像の内容は未検証。
- [ ] 別担当の動画・EndingPacket・提示済み証拠台帳との統合検証は別工程。

統合時の接点: `storyOpening()`を実際の最初のscene本文に使用する。`storyContext()`は公開済みの初期文脈、`storyNarration()`はLive用の演出指示であり、後者の生データを提示済み証拠として記録しない。物語段階は`completionFact`の確定値で数え、別担当の終了種別は実装しない。
