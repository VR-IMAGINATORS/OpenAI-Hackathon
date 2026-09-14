from __future__ import annotations

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from PIL import Image


GAME_PATH = Path(__file__).parents[1] / "scripts" / "game.py"
SPEC = importlib.util.spec_from_file_location("call_to_past_game", GAME_PATH)
assert SPEC and SPEC.loader
game = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(game)


def sample_master() -> dict:
    gimmicks = []
    for index in range(1, 5):
        gimmicks.append(
            {
                "id": f"g{index}",
                "name": f"障害{index}",
                "observation": f"観察{index}",
                "hints": [f"ヒント{index}a", f"ヒント{index}b", f"ヒント{index}c"],
                "mechanism": f"機構{index}",
                "acceptance": ["物性と意図が機構を満たす。"],
                "rejection": ["物性または意図が不足する。"],
                "examples": ["見本道具以外も物性で評価する。"],
                "reference_solutions": [{"item_ids": ["i1"]}],
            }
        )
    return {
        "version": 1,
        "scenes": [
            {
                "id": "s1",
                "name": "場面1",
                "description": "最初の閉鎖空間。",
                "anchor": "同じ衣装と青い誘導線。",
                "mystery": "最初の謎。",
                "sequences": [["g1", "g2", "g3"], ["g2", "g3", "g4"]],
            },
            {
                "id": "s2",
                "name": "場面2",
                "description": "別の閉鎖空間。",
                "anchor": "同じ衣装と赤い誘導線。",
                "mystery": "別の謎。",
                "sequences": [["g4", "g1", "g2"]],
            },
        ],
        "gimmicks": gimmicks,
        "items": [{"id": "i1", "name": "楔", "properties": ["硬い"], "uses": ["圧力を逃がす"]}],
    }


class GameCoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.master_path = self.root / "master.json"
        self.master_path.write_text(json.dumps(sample_master(), ensure_ascii=False), encoding="utf-8")
        self.photo = self.root / "misleading.txt"
        Image.new("RGB", (3, 2), (20, 40, 60)).save(self.photo, format="PNG")
        self.mock_video = self.root / "clip.bin"
        self.mock_video.write_bytes(b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isom")
        self.counter = 0

    def tearDown(self) -> None:
        self.temp.cleanup()

    def session(self, *, mode: str = "rehearsal", seed: int = 5, session_id: str | None = None) -> Path:
        self.counter += 1
        sid = session_id or f"session-{self.counter}"
        result = game.start_game(self.master_path, self.root / "runs", mode=mode, seed=seed, session_id=sid)
        return Path(result["session"])

    def prepare(
        self,
        session: Path,
        *,
        event_id: str,
        photo_count: int = 1,
        inventory_ids: list[str] | None = None,
        combine: dict | None = None,
    ) -> dict:
        return game.prepare_action(
            session,
            {
                "event_id": event_id,
                "intent": "観察した物性を現在の機構へ安全に使う",
                "photo_paths": [str(self.photo)] * photo_count,
                "inventory_ids": inventory_ids or [],
                "combine": combine,
            },
        )

    def commit(
        self,
        session: Path,
        prepared: dict,
        *,
        success: bool,
        combine_name: str | None = None,
        updates: list[dict] | None = None,
    ) -> dict:
        pending = prepared["pending"]
        recognized = [
            {
                "photo_index": photo["photo_index"],
                "photo_id": photo["photo_id"],
                "name": f"道具{photo['photo_index']}",
                "properties": ["硬い", "非導電"],
                "confidence": 0.9,
                "needs_confirmation": False,
            }
            for photo in pending["photos"]
        ]
        recognition = {
            "event_id": pending["event_id"],
            "revision": pending["revision"],
            "gimmick_id": pending["gimmick_id"],
            "photos": recognized,
        }
        combination = None
        if pending["combine"] is not None:
            combination = {
                "component_refs": pending["combine"]["component_refs"],
                "name": combine_name or "複合道具",
                "properties": ["固定された複合構造"],
            }
        judgment = {
            "event_id": pending["event_id"],
            "revision": pending["revision"],
            "gimmick_id": pending["gimmick_id"],
            "success": success,
            "new_objects": [
                {"photo_index": item["photo_index"], "name": item["name"], "properties": item["properties"]}
                for item in recognized
            ],
            "combine": combination,
            "updates": updates or [],
            "reason": "現在の機構と物性だけを照合した結果。",
        }
        return game.commit_action(session, recognition, judgment)

    def attach(self, session: Path, event_id: str, *, kind: str = "mock") -> None:
        game.attach_event_image(session, event_id=event_id, source=self.photo, media_kind=kind, provenance="unit-test")

    def story(self, session: Path, *, title: str = "未来からの返事") -> None:
        game.attach_story(session, {"title": title, "story": "確定した履歴だけから生成した短い物語。", "evaluation": "物性を生かした工夫が記録された。"})

    def h3_receipt(self, session: Path, *, with_end: bool = True) -> tuple[Path, Path]:
        state = json.loads((session / "state.json").read_text(encoding="utf-8"))
        end_source = session / state["ending"]["ending_image"]["file"] if with_end else None
        run = self.root / f"h3-run-{self.counter}"
        snapshots = run / "approval-snapshot"
        retrieval = run / "h3" / "retrievals" / "retrieval-001"
        snapshots.mkdir(parents=True)
        retrieval.mkdir(parents=True)
        start_snapshot = snapshots / "start.png"
        end_snapshot = snapshots / "end.png"
        start_snapshot.write_bytes(self.photo.read_bytes())
        if with_end:
            end_snapshot.write_bytes(end_source.read_bytes())
        upper_sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest().upper()
        manifest = {
            "schema": "call-to-past.h3-approval-manifest.v1",
            "endpoint": game.H3_ENDPOINT,
            "settings": {"mode": "i2v", "duration_seconds": 15, "resolution": "768P", "request_count": 1},
            "start_image": {"snapshot": "approval-snapshot/start.png", "sha256": upper_sha(start_snapshot)},
            "end_image": {"snapshot": "approval-snapshot/end.png", "sha256": upper_sha(end_snapshot)} if with_end else None,
        }
        manifest_path = run / "approval-manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        manifest_sha = upper_sha(manifest_path)
        approval_path = run / "approval.json"
        approval_path.write_text(
            json.dumps({"schema": "call-to-past.h3-approval.v1", "manifest_sha256": manifest_sha, "approved_at": "2026-09-12T00:00:00Z", "approval_evidence_verbatim": "user approved exact manifest"}),
            encoding="utf-8",
        )
        (run / "submission-attempt.json").write_text(
            json.dumps(
                {
                    "schema": "call-to-past.h3-submission-attempt.v1",
                    "manifest_sha256": manifest_sha,
                    "approval_sha256": upper_sha(approval_path),
                    "endpoint": game.H3_ENDPOINT,
                }
            ),
            encoding="utf-8",
        )
        request_id = "request-001"
        (run / "h3" / "request-id.json").write_text(json.dumps({"endpoint": game.H3_ENDPOINT, "request_id": request_id}), encoding="utf-8")
        (run / "submission-success.json").write_text(
            json.dumps(
                {
                    "manifest_sha256": manifest_sha,
                    "endpoint": game.H3_ENDPOINT,
                    "request_id": request_id,
                    "submitted_at": "2026-09-12T00:00:00Z",
                    "captured_output": {"sha256": "0" * 64, "bytes": 0},
                }
            ),
            encoding="utf-8",
        )
        receipt_video = retrieval / "ending.mp4"
        receipt_video.write_bytes(self.mock_video.read_bytes())
        receipt = {
            "version": 1,
            "endpoint": game.H3_ENDPOINT,
            "request_id": request_id,
            "manifest_sha256": manifest_sha,
            "start_image_sha256": upper_sha(start_snapshot),
            "end_image_sha256": upper_sha(end_snapshot) if with_end else None,
            "video": {"file": "ending.mp4", "sha256": upper_sha(receipt_video), "bytes": receipt_video.stat().st_size},
            "completed_at": "2026-09-12T00:00:01Z",
        }
        receipt_path = retrieval / "receipt.json"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        return run, receipt_path

    def play_action(self, session: Path, event_id: str, success: bool) -> dict:
        prepared = self.prepare(session, event_id=event_id)
        result = self.commit(session, prepared, success=success)
        self.attach(session, event_id)
        return result

    def test_same_seed_is_deterministic_and_retries_are_separate(self) -> None:
        first = self.session(seed=42, session_id="det-a")
        second = self.session(seed=42, session_id="det-b")
        state_a = json.loads((first / "state.json").read_text(encoding="utf-8"))
        state_b = json.loads((second / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state_a["scenario"], state_b["scenario"])
        self.assertEqual(state_a["master_snapshot"]["sha256"], state_b["master_snapshot"]["sha256"])

        for index in range(4):
            self.play_action(first, f"lose-{index}", False)
        self.story(first)
        same = game.retry_game(first, kind="same", session_id="retry-same", rehearsal_bypass=True)
        new = game.retry_game(first, kind="new", session_id="retry-new", rehearsal_bypass=True)
        same_state = json.loads((Path(same["session"]) / "state.json").read_text(encoding="utf-8"))
        new_state = json.loads((Path(new["session"]) / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(same_state["seed"], state_a["seed"])
        self.assertEqual(same_state["scenario"], state_a["scenario"])
        self.assertEqual(same_state["inventory"], [])
        self.assertNotEqual((new_state["scenario"]["scene_id"], new_state["scenario"]["order"]), (state_a["scenario"]["scene_id"], state_a["scenario"]["order"]))

    def test_prepare_requires_photo_or_available_inventory_and_limits_two(self) -> None:
        session = self.session()
        with self.assertRaises(game.GameError):
            self.prepare(session, event_id="empty", photo_count=0)
        with self.assertRaises(game.GameError):
            game.prepare_action(
                session,
                {"event_id": "too-many", "intent": "使う", "photo_paths": [str(self.photo)] * 3, "inventory_ids": [], "combine": None},
            )
        with self.assertRaises(game.GameError):
            self.prepare(session, event_id="unknown", photo_count=0, inventory_ids=["obj-missing"])

    def test_actual_image_content_controls_format_and_invalid_content_is_rejected(self) -> None:
        session = self.session()
        prepared = self.prepare(session, event_id="actual-format")
        self.assertEqual(prepared["pending"]["photos"][0]["format"], "PNG")
        self.assertTrue(prepared["pending"]["photos"][0]["file"].endswith(".png"))
        game.cancel_pending(session, event_id="actual-format", revision=prepared["pending"]["revision"], reason="test")
        bad = self.root / "bad.jpg"
        bad.write_bytes(b"not an image")
        with self.assertRaises(game.GameError):
            game.prepare_action(session, {"event_id": "bad-image", "intent": "使う", "photo_paths": [str(bad)], "inventory_ids": [], "combine": None})

    def test_session_and_runs_root_symlink_are_rejected_before_resolve(self) -> None:
        real_session = self.session(session_id="real-session")
        session_link = self.root / "session-link"
        runs_target = self.root / "runs-target"
        runs_target.mkdir()
        runs_link = self.root / "runs-link"
        try:
            os.symlink(real_session, session_link, target_is_directory=True)
            os.symlink(runs_target, runs_link, target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            simulated = self.root / "simulated-reparse-parent"
            simulated.mkdir()
            original_check = game._is_reparse_or_link
            with mock.patch.object(game, "_is_reparse_or_link", side_effect=lambda path: Path(path) == simulated or original_check(Path(path))):
                with self.assertRaises(game.GameError):
                    game.public_context(simulated / "unresolved-session")
                with self.assertRaises(game.GameError):
                    game.start_game(self.master_path, simulated / "nested", mode="rehearsal", seed=1, session_id="blocked")
            self.assertIsInstance(exc, (OSError, NotImplementedError))
            return
        with self.assertRaises(game.GameError):
            game.public_context(session_link)
        with self.assertRaises(game.GameError):
            game.start_game(self.master_path, runs_link / "nested", mode="rehearsal", seed=1, session_id="blocked")

    def test_unclear_or_stale_recognition_does_not_consume_action(self) -> None:
        session = self.session()
        prepared = self.prepare(session, event_id="unclear")
        pending = prepared["pending"]
        recognition = {
            "event_id": "unclear",
            "revision": pending["revision"],
            "gimmick_id": pending["gimmick_id"],
            "photos": [{"photo_index": 0, "photo_id": pending["photos"][0]["photo_id"], "name": "不明物", "properties": ["不明"], "confidence": 0.2, "needs_confirmation": True}],
        }
        judgment = {"event_id": "unclear", "revision": pending["revision"], "gimmick_id": pending["gimmick_id"], "success": True, "new_objects": [{"photo_index": 0, "name": "不明物", "properties": ["不明"]}], "combine": None, "updates": [], "reason": "曖昧"}
        with self.assertRaises(game.GameError):
            game.commit_action(session, recognition, judgment)
        state = json.loads((session / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["attempts"], 0)
        self.assertEqual(state["pending"]["event_id"], "unclear")
        recognition["photos"][0].update({"confidence": 0.9, "needs_confirmation": False})
        recognition["revision"] += 1
        with self.assertRaises(game.GameError):
            game.commit_action(session, recognition, judgment)
        self.assertEqual(json.loads((session / "state.json").read_text(encoding="utf-8"))["attempts"], 0)

    def test_revision_rejects_bool_float_and_corrupt_state_bool(self) -> None:
        session = self.session()
        prepared = self.prepare(session, event_id="strict-revision")
        pending = prepared["pending"]
        recognition = {
            "event_id": pending["event_id"], "revision": True, "gimmick_id": pending["gimmick_id"],
            "photos": [{"photo_index": 0, "photo_id": pending["photos"][0]["photo_id"], "name": "板", "properties": ["硬い"], "confidence": 0.9, "needs_confirmation": False}],
        }
        judgment = {
            "event_id": pending["event_id"], "revision": pending["revision"], "gimmick_id": pending["gimmick_id"],
            "success": False, "new_objects": [{"photo_index": 0, "name": "板", "properties": ["硬い"]}],
            "combine": None, "updates": [], "reason": "型境界のテスト",
        }
        with self.assertRaises(game.GameError):
            game.commit_action(session, recognition, judgment)
        recognition["revision"] = pending["revision"]
        judgment["revision"] = float(pending["revision"])
        with self.assertRaises(game.GameError):
            game.commit_action(session, recognition, judgment)
        with self.assertRaises(game.GameError):
            game.cancel_pending(session, event_id=pending["event_id"], revision=True, reason="型境界")
        self.assertEqual(json.loads((session / "state.json").read_text(encoding="utf-8"))["attempts"], 0)

        state_path = session / "state.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["revision"] = True
        state_path.write_text(json.dumps(state), encoding="utf-8")
        with self.assertRaises(game.GameError):
            game.public_context(session)

        for field in ("version", "seed", "attempts"):
            with self.subTest(field=field):
                typed_session = self.session(session_id=f"bool-{field}")
                typed_path = typed_session / "state.json"
                typed_state = json.loads(typed_path.read_text(encoding="utf-8"))
                typed_state[field] = True
                typed_path.write_text(json.dumps(typed_state), encoding="utf-8")
                with self.assertRaises(game.GameError):
                    game.public_context(typed_session)

    def test_judge_cannot_change_recognized_object_or_update_unselected_id(self) -> None:
        session = self.session()
        prepared = self.prepare(session, event_id="bound")
        pending = prepared["pending"]
        recognition = {"event_id": "bound", "revision": pending["revision"], "gimmick_id": pending["gimmick_id"], "photos": [{"photo_index": 0, "photo_id": pending["photos"][0]["photo_id"], "name": "木片", "properties": ["硬い"], "confidence": 0.9, "needs_confirmation": False}]}
        judgment = {"event_id": "bound", "revision": pending["revision"], "gimmick_id": pending["gimmick_id"], "success": True, "new_objects": [{"photo_index": 0, "name": "万能鍵", "properties": ["魔法"]}], "combine": None, "updates": [], "reason": "変換"}
        with self.assertRaises(game.GameError):
            game.commit_action(session, recognition, judgment)
        judgment["new_objects"] = [{"photo_index": 0, "name": "木片", "properties": ["硬い"]}]
        judgment["updates"] = [{"target": "inventory:invented", "available": False, "broken": False, "consumed": True}]
        with self.assertRaises(game.GameError):
            game.commit_action(session, recognition, judgment)
        self.assertEqual(json.loads((session / "state.json").read_text(encoding="utf-8"))["attempts"], 0)

    def test_failure_consumes_action_but_keeps_two_photo_objects_and_commit_is_idempotent(self) -> None:
        session = self.session()
        prepared = self.prepare(session, event_id="two", photo_count=2)
        first = self.commit(session, prepared, success=False)
        state = json.loads((session / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["attempts"], 1)
        self.assertEqual(state["cleared"], [])
        self.assertEqual(len(state["inventory"]), 2)
        self.assertTrue(all(item["available"] for item in state["inventory"]))
        recognition = state["events"][0]["recognition"]
        judgment = state["events"][0]["judgment"]
        duplicate = game.commit_action(session, recognition, judgment)
        self.assertEqual(duplicate["status"], "already_committed")
        self.assertEqual(first["render_packet"]["event_id"], duplicate["render_packet"]["event_id"])
        self.assertEqual(json.loads((session / "state.json").read_text(encoding="utf-8"))["attempts"], 1)

    def test_explicit_combination_derives_ids_and_prevents_component_reuse(self) -> None:
        session = self.session()
        prepared = self.prepare(session, event_id="combo", photo_count=2, combine={"component_refs": ["photo:0", "photo:1"]})
        self.commit(session, prepared, success=False)
        state = json.loads((session / "state.json").read_text(encoding="utf-8"))
        combo = next(item for item in state["inventory"] if item["id"] == "obj-combo-combo")
        self.assertTrue(combo["available"])
        self.assertEqual(combo["component_ids"], ["obj-combo-p0", "obj-combo-p1"])
        self.assertTrue(all(not item["available"] for item in state["inventory"] if item["id"] != combo["id"]))
        self.attach(session, "combo")
        carried = self.prepare(session, event_id="carried", photo_count=0, inventory_ids=[combo["id"]])
        self.commit(session, carried, success=True, updates=[{"target": f"inventory:{combo['id']}", "available": False, "broken": False, "consumed": True}])
        self.attach(session, "carried")
        with self.assertRaises(game.GameError):
            self.prepare(session, event_id="reuse", photo_count=0, inventory_ids=[combo["id"]])

    def test_broken_form_can_remain_available_but_consumed_form_cannot(self) -> None:
        session = self.session()
        prepared = self.prepare(session, event_id="break-bottle")
        self.commit(
            session,
            prepared,
            success=False,
            updates=[{"target": "photo:0", "available": True, "broken": True, "consumed": False, "condition": "安全に包んだ鋭い破片"}],
        )
        self.attach(session, "break-bottle")
        state = json.loads((session / "state.json").read_text(encoding="utf-8"))
        fragment = state["inventory"][0]
        self.assertTrue(fragment["available"])
        self.assertTrue(fragment["broken"])
        self.assertEqual(fragment["condition"], "安全に包んだ鋭い破片")
        carried = self.prepare(session, event_id="use-fragment", photo_count=0, inventory_ids=[fragment["id"]])
        self.assertEqual(carried["pending"]["inventory_ids"], [fragment["id"]])
        game.cancel_pending(session, event_id="use-fragment", revision=carried["pending"]["revision"], reason="test complete")

        other = self.prepare(session, event_id="invalid-consumed")
        pending = other["pending"]
        recognition = {"event_id": pending["event_id"], "revision": pending["revision"], "gimmick_id": pending["gimmick_id"], "photos": [{"photo_index": 0, "photo_id": pending["photos"][0]["photo_id"], "name": "道具", "properties": ["固体"], "confidence": 0.9, "needs_confirmation": False}]}
        judgment = {"event_id": pending["event_id"], "revision": pending["revision"], "gimmick_id": pending["gimmick_id"], "success": False, "new_objects": [{"photo_index": 0, "name": "道具", "properties": ["固体"]}], "combine": None, "updates": [{"target": "photo:0", "available": True, "broken": False, "consumed": True}], "reason": "invalid"}
        with self.assertRaises(game.GameError):
            game.commit_action(session, recognition, judgment)

    def test_live_blocks_next_action_until_image_and_packet_never_reveals_next_gimmick(self) -> None:
        session = self.session(mode="live")
        order = json.loads((session / "state.json").read_text(encoding="utf-8"))["scenario"]["order"]
        prepared = self.prepare(session, event_id="first")
        committed = self.commit(session, prepared, success=True)
        packet_text = json.dumps(committed["render_packet"], ensure_ascii=False)
        self.assertNotIn(order[1], packet_text)
        context = game.public_context(session)
        self.assertEqual(context["phase"], "awaiting_event_image")
        self.assertNotIn(order[1], json.dumps(context, ensure_ascii=False))
        with self.assertRaises(game.GameError):
            self.prepare(session, event_id="blocked")
        self.attach(session, "first", kind="generated")
        next_context = game.public_context(session)
        self.assertEqual(next_context["current_gimmick"]["id"], order[1])

    def test_judge_packet_contains_only_current_gimmick_and_selected_inventory(self) -> None:
        session = self.session()
        order = json.loads((session / "state.json").read_text(encoding="utf-8"))["scenario"]["order"]
        prepared = self.prepare(session, event_id="judge")
        pending = prepared["pending"]
        recognition = {
            "event_id": "judge", "revision": pending["revision"], "gimmick_id": pending["gimmick_id"],
            "photos": [{"photo_index": 0, "photo_id": pending["photos"][0]["photo_id"], "name": "板", "properties": ["硬い"], "confidence": 0.9, "needs_confirmation": False}],
        }
        packet = game.judgment_packet(session, recognition)
        self.assertEqual(packet["current_gimmick"]["id"], order[0])
        self.assertNotIn(order[1], json.dumps(packet, ensure_ascii=False))
        self.assertNotIn("order", packet)

    def test_cancel_retains_copied_photo_and_event_id_is_idempotent(self) -> None:
        session = self.session()
        prepared = self.prepare(session, event_id="cancel-me")
        photo_file = session / prepared["pending"]["photos"][0]["file"]
        result = game.cancel_pending(session, event_id="cancel-me", revision=prepared["pending"]["revision"], reason="認識確認をやり直す")
        self.assertTrue(photo_file.exists())
        self.assertEqual(result["photos_retained"], 1)
        again = game.cancel_pending(session, event_id="cancel-me", revision=prepared["pending"]["revision"], reason="different ignored")
        self.assertEqual(again["status"], "already_canceled")
        self.assertEqual(json.loads((session / "state.json").read_text(encoding="utf-8"))["attempts"], 0)

    def test_event_image_can_be_versioned_or_explicitly_waived_without_recommit(self) -> None:
        session = self.session(mode="live")
        prepared = self.prepare(session, event_id="media-revision")
        self.commit(session, prepared, success=True)
        self.attach(session, "media-revision", kind="generated")
        revised = self.root / "revision.png"
        Image.new("RGB", (3, 2), (80, 40, 20)).save(revised, format="PNG")
        game.attach_event_image(session, event_id="media-revision", source=revised, media_kind="generated", provenance="revision")
        state = json.loads((session / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["attempts"], 1)
        self.assertEqual(len(state["events"][0]["media"]["versions"]), 2)
        self.assertEqual(state["events"][0]["media"]["selected"]["provenance"], "revision")

        next_prepared = self.prepare(session, event_id="waive-this")
        self.commit(session, next_prepared, success=False)
        waiver = game.waive_media(session, event_id="waive-this", reason="ユーザーがこの画像を省略して続行すると明示")
        self.assertTrue(waiver["not_media_complete"])
        self.assertEqual(game.public_context(session)["phase"], "action")

    def test_past_or_ending_frozen_event_media_rejects_changes_but_same_hash_is_read_only(self) -> None:
        session = self.session()
        first = self.prepare(session, event_id="frozen-first")
        self.commit(session, first, success=False)
        self.attach(session, "frozen-first")
        second = self.prepare(session, event_id="frozen-second")
        same = game.attach_event_image(session, event_id="frozen-first", source=self.photo, media_kind="mock", provenance="repeat")
        self.assertEqual(same["status"], "already_attached")
        changed = self.root / "changed-event.png"
        Image.new("RGB", (3, 2), (200, 30, 20)).save(changed, format="PNG")
        with self.assertRaises(game.GameError):
            game.attach_event_image(session, event_id="frozen-first", source=changed, media_kind="mock", provenance="late")
        with self.assertRaises(game.GameError):
            game.waive_media(session, event_id="frozen-first", reason="too late")
        self.commit(session, second, success=False)
        self.attach(session, "frozen-second")
        for index in range(2, 4):
            event_id = f"frozen-{index}"
            prepared = self.prepare(session, event_id=event_id)
            self.commit(session, prepared, success=False)
            self.attach(session, event_id)
        self.story(session)
        with self.assertRaises(game.GameError):
            game.attach_event_image(session, event_id="frozen-3", source=changed, media_kind="mock", provenance="after-story")
        with self.assertRaises(game.GameError):
            game.waive_media(session, event_id="frozen-3", reason="after story")

    def test_all_endings_and_early_happy_are_derived(self) -> None:
        expected = {0: ("bad", 4), 1: ("bad", 4), 2: ("normal", 4), 3: ("happy", 3)}
        for successes, (kind, attempts) in expected.items():
            session = self.session(session_id=f"ending-{successes}")
            for index in range(attempts):
                self.play_action(session, f"event-{successes}-{index}", index < successes)
            state = json.loads((session / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["ending"]["type"], kind)
            self.assertEqual(state["ending"]["attempts"], attempts)
            with self.assertRaises(game.GameError):
                game.prepare_action(session, {"event_id": "extra", "intent": "続ける", "photo_paths": [str(self.photo)], "inventory_ids": [], "combine": None})

    def test_ending_evidence_distinguishes_unattempted_obstacles_and_escape(self) -> None:
        for outcomes in ([False, True, False, True], [True, True, True], [False] * 4):
            session = self.session()
            with self.assertRaises(game.GameError):
                game.ending_packet(session)
            for index, success in enumerate(outcomes):
                self.play_action(session, f"evidence-{index}", success)
            evidence = game.ending_packet(session)["escape_evidence"]
            state = json.loads((session / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(evidence["escaped"], sum(outcomes) == 3)
            self.assertEqual(evidence["action_limit_reached"], len(outcomes) == 4)
            remaining = evidence["remaining_obstacles"]
            self.assertEqual([item["id"] for item in remaining], state["scenario"]["order"][sum(outcomes):])
            if outcomes == [False, True, False, True]:
                self.assertEqual(len(remaining), 1)
                self.assertFalse(remaining[0]["attempted"])
                expected = next(g for g in sample_master()["gimmicks"] if g["id"] == remaining[0]["id"])
                self.assertEqual(remaining[0]["mechanism"], expected["mechanism"])
                self.assertEqual(remaining[0]["observation"], expected["observation"])
            if outcomes == [False] * 4:
                self.assertEqual([item["attempted"] for item in remaining], [True, False, False])

    def test_ending_packet_uses_only_final_event_image_as_start_frame(self) -> None:
        session = self.session(session_id="final-frame")
        final_image = self.root / "final-event.png"
        Image.new("RGB", (3, 2), (120, 10, 200)).save(final_image, format="PNG")
        for index in range(4):
            event_id = f"frame-{index}"
            prepared = self.prepare(session, event_id=event_id)
            self.commit(session, prepared, success=False)
            game.attach_event_image(
                session,
                event_id=event_id,
                source=final_image if index == 3 else self.photo,
                media_kind="mock",
                provenance="unit-test",
            )
        state = json.loads((session / "state.json").read_text(encoding="utf-8"))
        packet = game.ending_packet(session)
        self.assertEqual(packet["start_frame"]["sha256"], state["events"][-1]["media"]["selected"]["sha256"])
        self.assertNotEqual(packet["start_frame"]["sha256"], state["events"][0]["media"]["selected"]["sha256"])
        self.assertEqual(len(packet["inventory"]), 4)
        self.assertTrue({"condition", "available", "broken", "consumed", "combined_into", "component_ids"} <= set(packet["inventory"][-1]))

        waived_session = self.session(session_id="waived-final-frame")
        for index in range(4):
            event_id = f"waived-frame-{index}"
            prepared = self.prepare(waived_session, event_id=event_id)
            self.commit(waived_session, prepared, success=False)
            self.attach(waived_session, event_id)
            if index == 3:
                game.waive_media(waived_session, event_id=event_id, reason="ユーザーが最終イベント画像を省略")
        waived_packet = game.ending_packet(waived_session)
        self.assertIsNone(waived_packet["start_frame"])

    def test_ending_mutations_wait_for_final_event_media_without_side_effects(self) -> None:
        session = self.session(session_id="pending-final-media")
        for index in range(3):
            self.play_action(session, f"pending-final-{index}", False)
        prepared = self.prepare(session, event_id="pending-final-3")
        self.commit(session, prepared, success=False)
        before = (session / "state.json").read_bytes()

        with self.assertRaises(game.GameError):
            self.story(session)
        self.assertEqual((session / "state.json").read_bytes(), before)

        with self.assertRaises(game.GameError):
            game.attach_video(session, failed_reason="生成失敗")
        self.assertEqual((session / "state.json").read_bytes(), before)

        self.attach(session, "pending-final-3")
        self.story(session)
        failed = game.attach_video(session, failed_reason="生成失敗")
        self.assertEqual(failed["status"], "failed")

    def test_result_gate_live_video_display_and_explicit_waiver(self) -> None:
        live = self.session(mode="live", session_id="live-result")
        for index in range(4):
            prepared = self.prepare(live, event_id=f"live-{index}")
            self.commit(live, prepared, success=False)
            self.attach(live, f"live-{index}", kind="generated")
        with self.assertRaises(game.GameError):
            game.get_result(live)
        self.story(live, title="失敗の向こう側")
        game.attach_ending_image(live, source=self.photo, media_kind="generated", provenance="native-model-undisclosed")
        with self.assertRaises(game.GameError):
            game.attach_video(live, source=self.mock_video, media_kind="generated", provenance="free-text-is-insufficient")
        h3_run, receipt = self.h3_receipt(live)
        approval_path = h3_run / "approval.json"
        original_approval = approval_path.read_bytes()
        changed_approval = json.loads(original_approval.decode("utf-8"))
        changed_approval["approval_evidence_verbatim"] = "changed after submit"
        approval_path.write_text(json.dumps(changed_approval), encoding="utf-8")
        with mock.patch.object(game, "_probe_live_video", return_value={"duration_seconds": 15.0, "width": 1366, "height": 768, "audio": True}):
            with self.assertRaises(game.GameError):
                game.attach_video(
                    live,
                    source=self.mock_video,
                    media_kind="generated",
                    provenance="tampered approval",
                    h3_run=h3_run,
                    receipt=receipt,
                )
        approval_path.write_bytes(original_approval)
        success_path = h3_run / "submission-success.json"
        original_success = success_path.read_bytes()
        changed_success = json.loads(original_success.decode("utf-8"))
        changed_success["request_id"] = "request-tampered"
        success_path.write_text(json.dumps(changed_success), encoding="utf-8")
        with mock.patch.object(game, "_probe_live_video", return_value={"duration_seconds": 15.0, "width": 1366, "height": 768, "audio": True}):
            with self.assertRaises(game.GameError):
                game.attach_video(
                    live,
                    source=self.mock_video,
                    media_kind="generated",
                    provenance="tampered successful submission",
                    h3_run=h3_run,
                    receipt=receipt,
                )
        success_path.write_bytes(original_success)
        with mock.patch.object(game, "_probe_live_video", return_value={"duration_seconds": 15.0, "width": 1366, "height": 768, "audio": True}):
            game.attach_video(
                live,
                source=self.mock_video,
                media_kind="generated",
                provenance="H3 receipt verified",
                h3_run=h3_run,
                receipt=receipt,
            )
        with self.assertRaises(game.GameError):
            game.get_result(live)
        game.mark_video_shown(live)
        result = game.get_result(live)
        self.assertTrue(result["media_complete"])
        self.assertFalse(result["not_live"])
        self.assertEqual(result["title"], "失敗の向こう側")
        self.assertIn("物性", result["evaluation"])

        waived = self.session(mode="live", session_id="waived-result")
        for index in range(4):
            prepared = self.prepare(waived, event_id=f"waive-{index}")
            self.commit(waived, prepared, success=False)
            self.attach(waived, f"waive-{index}", kind="generated")
        self.story(waived)
        game.attach_video(waived, failed_reason="ユーザーが有料生成を見送った")
        game.waive_media(waived, reason="ユーザーがテキスト結果への移行を明示選択")
        fallback = game.get_result(waived)
        self.assertFalse(fallback["media_complete"])
        self.assertEqual(fallback["media_status"], "waived")

    def test_start_only_live_ending_completes_without_end_image(self) -> None:
        for outcome, successes, label in (("happy", [True]*3, "SUCCESS!!"), ("normal", [True, True, False, False], "to be continued..."), ("bad", [False]*4, "to be continued...")):
            with self.subTest(outcome=outcome):
                live = self.session(mode="live", session_id="start-only-"+outcome)
                for index, success in enumerate(successes):
                    eid = f"action-{index}"
                    prepared = self.prepare(live, event_id=eid)
                    self.commit(live, prepared, success=success)
                    self.attach(live, eid, kind="generated")
                packet = game.ending_packet(live)
                self.assertEqual(packet["production"]["ending_title"], label)
                self.assertTrue(packet["production"]["generate_end_frame"])
                self.assertEqual(packet["production"]["input_mode"], "start_and_end_frames")
                self.assertEqual(packet["production"]["title_mode"], "end_frame_embedded")
                self.assertEqual(packet["production"]["title_position"], "lower_center" if outcome == "happy" else "lower_right")
                self.assertEqual(packet["production"]["title_transition"], "brief_amber_light_sweep_then_stable_hold")
                self.assertEqual(packet["production"]["continuity_reference"], packet["start_frame"])
                self.story(live)
                run, receipt = self.h3_receipt(live, with_end=False)
                original = receipt.read_bytes()
                broken = json.loads(original)
                broken["end_image_sha256"] = "A"*64
                receipt.write_text(json.dumps(broken), encoding="utf-8")
                before = (live/"state.json").read_bytes()
                with self.assertRaises(game.GameError):
                    game.attach_video(live, source=self.mock_video, h3_run=run, receipt=receipt)
                self.assertEqual(before, (live/"state.json").read_bytes())
                receipt.write_bytes(original)
                broken = json.loads(original)
                del broken["end_image_sha256"]
                receipt.write_text(json.dumps(broken), encoding="utf-8")
                with self.assertRaises(game.GameError):
                    game.attach_video(live, source=self.mock_video, h3_run=run, receipt=receipt)
                receipt.write_bytes(original)
                start = run/"approval-snapshot/start.png"
                original_start = start.read_bytes()
                start.write_bytes(b"tampered")
                with self.assertRaises(game.GameError):
                    game.attach_video(live, source=self.mock_video, h3_run=run, receipt=receipt)
                start.write_bytes(original_start)
                self.assertEqual(before, (live/"state.json").read_bytes())
                with mock.patch.object(game, "_probe_live_video", return_value={"duration_seconds": 15, "width": 1344, "height": 768, "audio": True}):
                    game.attach_video(live, source=self.mock_video, h3_run=run, receipt=receipt)
                with self.assertRaises(game.GameError):
                    game.get_result(live)
                with self.assertRaises(game.GameError):
                    game.attach_ending_image(live, source=self.photo, media_kind="generated")
                game.mark_video_shown(live)
                result = game.get_result(live)
                self.assertTrue(result["media_complete"])
                self.assertIsNone(json.loads((live/"state.json").read_text())["ending"]["ending_image"])

    def test_rehearsal_requires_explicit_bypass_and_reports_not_live(self) -> None:
        session = self.session(session_id="rehearsal-result")
        for index in range(4):
            self.play_action(session, f"rehearse-{index}", False)
        with self.assertRaises(game.GameError):
            game.get_result(session)
        self.story(session)
        result = game.get_result(session, rehearsal_bypass=True)
        self.assertTrue(result["not_live"])
        self.assertFalse(result["media_complete"])

    def test_unknown_state_fields_are_rejected(self) -> None:
        session = self.session()
        state_path = session / "state.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["model_controls_attempts"] = True
        state_path.write_text(json.dumps(state), encoding="utf-8")
        with self.assertRaises(game.GameError):
            game.public_context(session)


if __name__ == "__main__":
    unittest.main()
