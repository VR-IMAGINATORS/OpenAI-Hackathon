# Call to the Past CLI

`scripts/game.py` is the state authority. It prints JSON to stdout, prints a JSON error to stderr, and exits with code `2` for rejected input. Run it with Python 3.10+ and Pillow installed. All examples below assume the repository root as the current directory.

```powershell
$Game = "skills/call-to-past/scripts/game.py"
$Master = "skills/call-to-past/assets/masters.json"
```

## Start and inspect

Create a separate session directory. `--session-id` is optional; when supplied it may contain only letters, digits, `.`, `_`, and `-` and is limited to 64 characters.

```powershell
python -X utf8 $Game start --master $Master --runs-root "runs/call-to-past" --mode live --seed 12345
python -X utf8 $Game context --session "runs/call-to-past/<session-id>"
```

`context` is player-safe. It contains the current obstacle only. Immediately after a commit it stays on the processed obstacle until its event image has been attached; it never exposes the next obstacle inside an event render packet.

Use `--mode rehearsal` only for dry runs. Rehearsal outputs always carry `not_live: true`; mock media never satisfies live acceptance.

## Prepare an action

Write a UTF-8 request file and prepare it:

```json
{
  "event_id": "turn-01",
  "intent": "AIがはさみで椅子の背側にあるロープの外側だけを一か所切る",
  "photo_paths": ["C:/absolute/path/scissors.jpg"],
  "inventory_ids": [],
  "combine": null
}
```

```powershell
python -X utf8 $Game prepare --session "runs/call-to-past/<session-id>" --request-json "request.json"
```

An action must contain 0–2 photos. Zero photos requires at least one currently available `inventory_id`. Photos are read-only inputs: the core verifies their bytes as a single-frame JPEG, PNG, or WebP, copies them under an internal ID, and does not store the source path.

For an explicit combination, identify every component. Every new photo must be included. Components must be unique.

```json
{
  "event_id": "turn-02",
  "intent": "持越したヘアピンを輪ゴムへ固定してフックを作り、非常扉の引き輪へ掛けて正しい方向へ引く",
  "photo_paths": ["C:/absolute/path/rubber-band.png"],
  "inventory_ids": ["obj-turn-00-p0"],
  "combine": {
    "component_refs": ["inventory:obj-turn-00-p0", "photo:0"]
  }
}
```

The response freezes an immutable `event_id`, pending `revision`, `gimmick_id`, internal photo IDs, and a `recognition_packet`. Reusing the same event ID with identical input is idempotent; different input is a conflict.

## Commit or cancel

Recognition and judgment are separate UTF-8 JSON files. Their exact schemas are in [judgment-schema.md](judgment-schema.md).

```powershell
python -X utf8 $Game judge-packet --session "runs/call-to-past/<session-id>" --recognition-json "recognition.json"
python -X utf8 $Game commit --session "runs/call-to-past/<session-id>" --recognition-json "recognition.json" --judgment-json "judgment.json"
```

`judge-packet` first validates recognition, then returns only the current gimmick's physical contract, the intent, recognition, and selected inventory. It contains no later obstacle or ending. Use that packet for the Sol high adjudication prompt.

A valid commit consumes exactly one action, including failure. Invalid schema, stale revision, unclear recognition, or a mismatched object does not consume an action and leaves the pending record available for correction or cancellation. The response includes the event-specific `render_packet` and no new obstacle.

```powershell
python -X utf8 $Game cancel-pending --session "runs/call-to-past/<session-id>" --event-id turn-01 --revision 1 --reason "対象物を確認し直す"
python -X utf8 $Game render-packet --session "runs/call-to-past/<session-id>" --event-id turn-01
```

Cancellation retains copied photos and stores the canceled pending history. It consumes no action.

## Attach event media

Every committed action needs its own result image before another action can be prepared. The image is copied; the supplied original is not modified.

```powershell
python -X utf8 $Game attach-image --session "runs/call-to-past/<session-id>" --event-id turn-01 --file "C:/absolute/path/result.png" --media-kind generated --provenance "Codex native image tool; model name undisclosed"
python -X utf8 $Game context --session "runs/call-to-past/<session-id>"
```

`--media-kind mock` is accepted only in rehearsal. `--provenance` records the actual known source; omit it when unknown rather than naming an unverified model.

Before the next action is prepared, attaching a different valid image to the latest event appends a version and selects it. Earlier files and records remain. Once the next action is prepared, or ending story/image/video work starts, past event media is frozen. Rechecking the already-selected identical hash is a read-only idempotent operation. If the user explicitly chooses to continue without a valid latest-event image, record an event-specific waiver before preparing the next action:

```powershell
python -X utf8 $Game waive-media --session "runs/call-to-past/<session-id>" --event-id turn-01 --reason "user explicitly chose to continue without this event image"
```

The next action is then available, but final `media_complete` remains `false` unless a later valid image supersedes the waiver.

## Ending, video, and result release

After three clears or four committed actions:

```powershell
python -X utf8 $Game ending-packet --session "runs/call-to-past/<session-id>"
python -X utf8 $Game attach-story --session "runs/call-to-past/<session-id>" --story-json "story.json"
python -X utf8 $Game attach-ending --session "runs/call-to-past/<session-id>" --file "C:/absolute/path/ending.png" --media-kind generated --provenance "Codex native image tool; model name undisclosed"
python -X utf8 $Game attach-video --session "runs/call-to-past/<session-id>" --file "C:/absolute/path/ending.mp4" --media-kind generated --h3-run "C:/absolute/path/h3-run" --receipt "h3/retrievals/<retrieval-id>/receipt.json" --provenance "H3 Turbo receipt verified"
```

`story.json` is exact UTF-8 JSON. Its title, story, and evaluation must be generated from the derived outcome and committed event history:

```json
{
  "title": "過去から届いた灯り",
  "story": "確定した四つの行動に沿うエンディング本文…",
  "evaluation": "反射面を持ち越して別の機構へ応用した工夫が印象的だった。"
}
```

The outcome type and counts remain code-derived. The first accepted story is stored with a hash and cannot be silently replaced. A live result has no static title fallback and stays unavailable until this story exists.

For live attachment, free-text provenance is insufficient. The core requires the receipt saved by `media.py result` and binds it to the H3 run's manifest, approval, saved request ID, input snapshots, receipt-adjacent video, current source video, and game ending-image hash. SHA casing is normalized. It also runs `ffprobe` and requires 15 seconds ±0.25, a 768-pixel frame dimension, and at least one audio stream. Motion, face framing, continuity, and overall visual quality still require human review. Rehearsal media remains separate and must not supply live H3 evidence.

After the caller actually displays the attached video to the user, explicitly record that fact, then reveal the result:

```powershell
python -X utf8 $Game mark-video-shown --session "runs/call-to-past/<session-id>"
python -X utf8 $Game result --session "runs/call-to-past/<session-id>"
```

If generation is not performed or cannot complete, record failure if applicable, obtain the user's explicit choice to continue with text, and then waive media. Waiver unlocks the text result and retry but returns `media_complete: false`; it does not satisfy live media acceptance.

```powershell
python -X utf8 $Game attach-video --session "runs/call-to-past/<session-id>" --failed-reason "generation request failed and was not reposted"
python -X utf8 $Game waive-media --session "runs/call-to-past/<session-id>" --reason "user explicitly chose text fallback"
python -X utf8 $Game result --session "runs/call-to-past/<session-id>"
```

An explicit rehearsal-only bypass is available for deterministic tests:

```powershell
python -X utf8 $Game result --session "runs/call-to-past/<session-id>" --rehearsal-bypass
```

## Retry

Retries always create a new directory and preserve the completed session. `same` keeps the seed, exact master snapshot, scene, obstacle order, anchor, and mystery while clearing progress and inventory. `new` uses the same snapshot but derives a different seed and requires a distinct scene/order combination.

```powershell
python -X utf8 $Game retry --session "runs/call-to-past/<session-id>" --kind same
python -X utf8 $Game retry --session "runs/call-to-past/<session-id>" --kind new
```

Use `--session-id <safe-id>` to choose the new directory name. Rehearsal sessions that have no shown or waived media require `--rehearsal-bypass` here as well.

## Importable API

The module exposes `start_game`, `public_context`, `prepare_action`, `judgment_packet`, `commit_action`, `cancel_pending`, `event_render_packet`, `attach_event_image`, `ending_packet`, `attach_story`, `attach_ending_image`, `attach_video`, `mark_video_shown`, `waive_media`, `get_result`, and `retry_game`. Mutating calls lock the session and atomically replace `state.json`.
