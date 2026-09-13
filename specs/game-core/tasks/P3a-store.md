# P3a ResultStore / P5 retention component

Status: implemented; component fake tests passed (2026-09-13). HTTP/runtime/session integration is owned by the main task and is not claimed complete here.

- Owner-only feed and JPEG assets; independent per-play locale and retention.
- Incremental upserts, stable message IDs/creation order, removals, stale cursor reset and future cursor rejection.
- Original transcript deltas are concatenated without translating or rewriting. Speaker/generation/time grouping is display-only; source ledger and action eligibility remain independent.
- Transcript groups are removed first at 128 messages/48KiB text. JSON escaping has a separate 240KiB message budget to leave room within the 256KiB response envelope. Non-transcript-only overflow is rejected, preserving photo/result rows.
- Photo thumbnails are re-encoded to JPEG <=32KiB/384px; scenes <=256KiB/1024px. Input JPEG signature, decoder, pixel and byte limits are checked. Normalization runs serially within the store. Scene inspection must already pass before callers publish a scene asset.
- Ended results retain for 300 seconds by default, at most 10 ended entries; configurable 8MiB per-entry/128MiB total caps. Read access never extends retention. Old ended entries are evicted first, active entries are never evicted to make room, and onEvict cancels related work through the main integration.
- Safe result snapshots are supplied by the runtime; this component must not receive provider secrets or raw prompts.

Validation: `npx tsx --test tests/core-result-store.test.ts` 9 tests passed; `npx tsc --noEmit` passed before final test-only additions. No real API, microphone, mobile or AWS verification performed by this subtask.

Integration APIs: `create`, `appendTranscript`, `appendMessage`, `updateMessage`, async `putAsset`, `feed(owner,playId,after)`, `asset(owner,playId,assetId)`, `end`, `result`, `retainUntil`, `has`, `hasOwner`, `evict`, `sweep`, `clear`. ResultStoreError carries HTTP `status` and stable `code`.

Follow-up HTTP validation: `npx tsx --test tests/core-result-http.test.ts` 3 tests passed. Checks unauthenticated and cross-owner feed/assets rejection, owner reads without control headers, no-store/nosniff, JPEG delivery, locale idempotency conflict, stateVersion stability/change, expired-auth read-only retention, new-play rejection and exact retention expiry. Provider boundary remains mock; images in these tests are synthetic JPEG fixtures.
