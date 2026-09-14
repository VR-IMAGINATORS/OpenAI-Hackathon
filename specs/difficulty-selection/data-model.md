# データモデル

- Difficulty: `normal | hard | nightmare`。
- 表示名は Normal / Hard / HELL（日本語: ノーマル / ハード / ヘル）。HELLの内部IDは既存プレイ・API互換性のため `nightmare` を維持。
- ScenarioSnapshot.difficulty?: Difficulty。指定時のscenarioV2.rulesにプリセットのtotalTimeSeconds/maxPhotoSendsを適用。digestにdifficultyを含める。
- PublicGameState.difficulty?: Difficulty。再読込で選択復元。
- AuthSession.lastCreateDifficulty?: Difficulty。requestId/clientId/localeと合わせて再送一致を検証。
- 省略時は既存シナリオ設定。プレイ作成後の難易度変更APIは提供しない。
