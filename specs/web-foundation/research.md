# 技術調査

2026-09-12。

| 決定 | 理由 | 代替 |
|---|---|---|
| React/Vite/TypeScript | 音声/写真UIを分担しやすい。既存Node22.15.1はViteのNode.js22.12+要件内 | SSRは不要なのでNext.jsは不採用 |
| Express5 + tsx | local/relayを同じ言語で独立。Node22.15でもTS実行 | Firebase認証/DBは初回不要 |
| 単一npm/Zod/Node test | install一回、JSON編集を検証、HTTPテストは課金不要 | workspacesや専用UI E2E基盤は後続 |
| モック経路を先行 | キーを扱わず層間通信を確認 | 実AIと本編の同時実装は土台範囲を超える |

一次資料:
- [Vite Getting Started](https://vite.dev/guide/): Node20.19+/22.12+、React/TS。
- [Express Installing](https://expressjs.com/en/starter/installing/): Express5と型の導入。
- [GPT-Live](https://developers.openai.com/api/docs/guides/live): 音声とbackend delegation。キーはtrusted server。
- [GPT-Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live): localhost/HTTPS、マイク、サーバーによるSDP交換、POST /v1/live/sessions。

LiveをRealtimeで置換しない。Realtime短期キーを画像/動画に使える万能キーと扱わない。Liveアカウント権限、実モデル/費用、運営先、審査規定は未確認で後続の実API提供条件。実APIは未接続。
