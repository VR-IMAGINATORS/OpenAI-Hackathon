from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest import mock

from PIL import Image


SCRIPT = Path(__file__).parents[1] / "scripts" / "media.py"
SPEC = importlib.util.spec_from_file_location("call_to_past_media", SCRIPT)
assert SPEC and SPEC.loader
media = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(media)

TEST_KEY = "TEST_ONLY_NOT_REAL_1234567890:TEST_ONLY_NOT_REAL_SECRET_9876543210"


def namespace(**values: object) -> argparse.Namespace:
    return argparse.Namespace(**values)


def quiet_call(function, *args):
    with contextlib.redirect_stdout(io.StringIO()):
        return function(*args)


class MediaBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        # Retain every fixture directory for inspection; project policy forbids test cleanup.
        self.root = Path(tempfile.mkdtemp(prefix="call-to-past-media-test-"))
        self.prompt = self.root / "ending-prompt.txt"
        self.prompt.write_text(
            "integrated_multimodal_description:\n"
            "[Shot 1] The survivor reaches the sealed door.\n\n"
            "overall_soundscape:\nMetal, air, and quiet footsteps.\n\n"
            "non_diegetic_music:\nN/A\n",
            encoding="utf-8",
        )
        self.start = self.root / "start.png"
        self.end = self.root / "end.png"
        Image.new("RGB", (320, 180), (10, 20, 30)).save(self.start)
        Image.new("RGB", (320, 180), (30, 20, 10)).save(self.end)
        self.cost_plan = self.root / "cost-plan.json"
        self.write_cost_plan()
        self.credentials = self.root / "credentials.md"
        self.credentials.write_text(
            "# unrelated:\nNOT_A_REAL_KEY_OUTSIDE_FAL\n\n"
            f"#fal.ai：\n{TEST_KEY}\n\n"
            "# next:\nANOTHER_NON_FAL_VALUE\n",
            encoding="utf-8",
        )
        self.real_resolve_h3_skill = media.resolve_h3_skill
        self.h3_skill = self.make_fake_h3_skill()
        self.resolve_h3_patch = mock.patch.object(
            media, "resolve_h3_skill", return_value=self.h3_skill
        )
        self.resolve_h3_patch.start()
        self.addCleanup(self.resolve_h3_patch.stop)

    def test_default_h3_runtime_is_bundled_with_call_to_past(self) -> None:
        nonexistent_home = self.root / "codex-home-without-h3-video"
        with mock.patch.dict(os.environ, {"CODEX_HOME": str(nonexistent_home)}, clear=False):
            skill = self.real_resolve_h3_skill()
        self.assertEqual(skill, SCRIPT.parents[1].resolve())
        for name in ("estimate_cost.py", "generate_h3.py"):
            self.assertTrue((skill / "scripts" / name).is_file(), name)

    def test_isolated_copy_runs_submit_status_result_from_bundled_runtime(self) -> None:
        copied_skill = self.root / "isolated-call-to-past"
        shutil.copytree(
            SCRIPT.parents[1],
            copied_skill,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        copied_script = copied_skill / "scripts" / "media.py"
        copied_spec = importlib.util.spec_from_file_location(
            "call_to_past_media_isolated", copied_script
        )
        assert copied_spec and copied_spec.loader
        copied_media = importlib.util.module_from_spec(copied_spec)
        copied_spec.loader.exec_module(copied_media)

        calls: list[list[str]] = []

        def fake_run(command, *, cwd, fal_key, scrub_root):
            calls.append(command)
            self.assertEqual(
                Path(command[1]).resolve(),
                (copied_skill / "scripts" / "generate_h3.py").resolve(),
            )
            action = command[2]
            output_dir = Path(command[command.index("--output-dir") + 1])
            output_dir.mkdir(parents=True, exist_ok=True)
            if action == "submit":
                (output_dir / "request-id.json").write_text(
                    json.dumps(
                        {
                            "endpoint": copied_media.ENDPOINT,
                            "request_id": "isolated-request-id-001",
                            "submitted_at": "2026-09-12T00:00:00Z",
                        }
                    ),
                    encoding="utf-8",
                )
            elif action == "status":
                (output_dir / "status-isolated.json").write_text(
                    json.dumps({"position": 1}), encoding="utf-8"
                )
            elif action == "result":
                video = Path(command[command.index("--video-output") + 1])
                video.write_bytes(b"isolated-fake-mp4")
            return mock.Mock(returncode=0, stdout=b"", stderr=b"")

        run_dir = self.root / "isolated-run"
        quiet_call(
            copied_media.prepare,
            namespace(
                run_dir=run_dir,
                prompt_file=self.prompt,
                start_image=self.start,
                end_image=self.end,
                cost_plan=self.cost_plan,
                seed=None,
            ),
        )
        manifest_hash = copied_media.sha256_file(run_dir / "approval-manifest.json")
        quiet_call(
            copied_media.approve,
            namespace(
                run_dir=run_dir,
                manifest_sha256=manifest_hash,
                approval_text="同梱ランタイムのテスト送信を承認します。",
                approval_evidence_file=None,
            ),
        )
        runtime_args = namespace(run_dir=run_dir, credentials_file=self.credentials)
        missing_h3_home = self.root / "codex-home-without-h3-video"
        with mock.patch.dict(
            os.environ,
            {"CODEX_HOME": str(missing_h3_home), "FAL_KEY": ""},
            clear=False,
        ):
            with mock.patch.object(copied_media, "run_dependency", side_effect=fake_run):
                self.assertEqual(quiet_call(copied_media.submit, runtime_args), 0)
                for action in ("status", "result"):
                    args = namespace(
                        command=action,
                        run_dir=run_dir,
                        credentials_file=self.credentials,
                    )
                    self.assertEqual(quiet_call(copied_media.recovery, args), 0)
        self.assertEqual([command[2] for command in calls], ["submit", "status", "result"])
    def write_cost_plan(
        self,
        *,
        checked_at=None,
        total_usd: str = "0.60",
        total_jpy: str = "90.00",
        reference_tokens: int = 0,
    ) -> None:
        checked = checked_at or media.utc_now()
        plan = {
            "mode": "i2v",
            "resolution": "768P",
            "durations_seconds": [15],
            "request_count": 1,
            "total_seconds": 15,
            "video_rate_usd_per_second": "0.04",
            "video_cost_usd": "0.60",
            "reference_images": [],
            "reference_tokens_per_request": reference_tokens,
            "reference_allowance_per_request": 4096,
            "billable_reference_tokens_per_request": 0,
            "reference_cost_usd_per_request": "0.000",
            "reference_cost_usd_total": "0.000",
            "total_cost_usd": total_usd,
            "usd_jpy": "150",
            "total_cost_jpy": total_jpy,
            "pricing_source": "https://fal.ai/models/minimax/h3-max-turbo/image-to-video",
            "pricing_checked_at": media.iso_utc(checked),
        }
        self.cost_plan.write_text(
            json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    def make_fake_h3_skill(self) -> Path:
        skill = self.root / "fake-h3-video"
        scripts = skill / "scripts"
        scripts.mkdir(parents=True)
        generate = scripts / "generate_h3.py"
        generate.write_text(
            """#!/usr/bin/env python3
import json
import os
import pathlib
import sys

root = pathlib.Path(__file__).parents[1]
args = sys.argv[1:]
command = args[0]
with (root / 'calls.log').open('a', encoding='utf-8') as handle:
    handle.write(json.dumps(args) + '\\n')
output_dir = pathlib.Path(args[args.index('--output-dir') + 1])
output_dir.mkdir(parents=True, exist_ok=True)
key = os.environ['FAL_KEY']
print(key)
print(key, file=sys.stderr)
if command == 'submit' and (root / 'fail-submit').exists():
    (output_dir / 'submission-uncertain.json').write_text(
        json.dumps({'message': key}), encoding='utf-8'
    )
    raise SystemExit(2)
if command == 'submit':
    if not (root / 'omit-request-id').exists():
        (output_dir / 'request-id.json').write_text(
            json.dumps({
                'endpoint': 'minimax/h3-max-turbo/image-to-video',
                'request_id': 'fake-request-id-001',
                'submitted_at': '2026-09-12T00:00:00Z'
            }), encoding='utf-8'
        )
elif command == 'status':
    (output_dir / 'status-fake.json').write_text(
        json.dumps({'position': 2}), encoding='utf-8'
    )
elif command == 'result':
    video = pathlib.Path(args[args.index('--video-output') + 1])
    if (root / 'fail-result-once').exists() and not (root / 'result-failed-once').exists():
        (root / 'result-failed-once').write_text('failed once', encoding='utf-8')
        video.with_suffix(video.suffix + '.part').write_bytes(b'partial')
        raise SystemExit(2)
    video.write_bytes(b'fake-mp4-for-offline-test')
    (output_dir / 'result-fake.json').write_text(
        json.dumps({'video': {'path': str(video)}}), encoding='utf-8'
    )
""",
            encoding="utf-8",
        )
        return skill

    def prepare(self, run_name: str = "run", *, seed=None, resolution="768P") -> Path:
        run_dir = self.root / run_name
        result = quiet_call(
            media.prepare,
            namespace(
                run_dir=run_dir,
                prompt_file=self.prompt,
                start_image=self.start,
                end_image=self.end,
                cost_plan=self.cost_plan,
                seed=seed,
                resolution=resolution,
            ),
        )
        self.assertEqual(result, 0)
        return run_dir

    def approve(self, run_dir: Path, evidence: str = "この内容でH3へ1本送信してください。") -> None:
        manifest_hash = media.sha256_file(run_dir / "approval-manifest.json")
        result = quiet_call(
            media.approve,
            namespace(
                run_dir=run_dir,
                manifest_sha256=manifest_hash,
                approval_text=evidence,
                approval_evidence_file=None,
            ),
        )
        self.assertEqual(result, 0)

    def submit_args(self, run_dir: Path) -> argparse.Namespace:
        return namespace(
            run_dir=run_dir,
            credentials_file=self.credentials,
        )

    def submit(self, run_dir: Path) -> int:
        return quiet_call(media.submit, self.submit_args(run_dir))

    def recover_result(self, run_dir: Path) -> tuple[dict[str, object], Path]:
        result_args = namespace(
            command="result",
            run_dir=run_dir,
            credentials_file=self.credentials,
        )
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(media.recovery(result_args), 0)
        report = json.loads(output.getvalue())
        return report, Path(report["receipt_file"])

    def test_start_only_submission_and_receipt_preserve_absent_end(self) -> None:
        self.end = None
        run_dir = self.prepare("start-only")
        manifest_path = run_dir / "approval-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertIsNone(manifest["end_image"])
        self.assertFalse(list((run_dir / "approval-snapshot").glob("end*")))
        self.approve(run_dir)
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            self.assertEqual(self.submit(run_dir), 0)
            _, receipt_path = self.recover_result(run_dir)
        calls = [json.loads(line) for line in (self.h3_skill / "calls.log").read_text(encoding="utf-8").splitlines()]
        self.assertIn("--start-image", calls[0])
        self.assertNotIn("--end-image", calls[0])
        receipt = media.validate_result_receipt(run_dir, receipt_path)
        self.assertIsNone(receipt["end_image_sha256"])
        receipt["end_image_sha256"] = "A" * 64
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        with self.assertRaisesRegex(media.BridgeError, "end image hash"):
            media.validate_result_receipt(run_dir, receipt_path)

    def test_removing_approved_end_image_is_rejected(self) -> None:
        run_dir = self.prepare("remove-end")
        self.approve(run_dir)
        path = run_dir / "approval-manifest.json"
        manifest = json.loads(path.read_text(encoding="utf-8"))
        manifest["end_image"] = None
        path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaises(media.BridgeError):
            self.submit(run_dir)
        self.assertFalse((run_dir / "submission-attempt.json").exists())

    def test_prepare_snapshots_exact_inputs_and_exposes_cost_prompt_and_hashes(self) -> None:
        run_dir = self.prepare(seed=42)
        manifest_path = run_dir / "approval-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["endpoint"], media.ENDPOINT)
        self.assertEqual(manifest["settings"]["duration_seconds"], 15)
        self.assertEqual(manifest["settings"]["resolution"], "768P")
        self.assertEqual(manifest["settings"]["request_count"], 1)
        self.assertEqual(manifest["settings"]["prompt_expansion_mode"], "balanced")
        self.assertEqual(manifest["settings"]["seed"], 42)
        self.assertEqual(manifest["prompt"]["text"], self.prompt.read_text(encoding="utf-8"))
        self.assertEqual(manifest["start_image"]["aspect_ratio"], "16:9")
        self.assertFalse(manifest["cost"]["native_or_codex_costs_included"])
        for field in ("prompt", "start_image", "end_image"):
            snapshot = run_dir / manifest[field]["snapshot"]
            self.assertEqual(media.sha256_file(snapshot), manifest[field]["sha256"])
        cost_snapshot = run_dir / manifest["cost"]["snapshot"]
        self.assertEqual(media.sha256_file(cost_snapshot), manifest["cost"]["sha256"])

    def test_prepare_rejects_mismatched_image_dimensions(self) -> None:
        Image.new("RGB", (321, 180), (1, 2, 3)).save(self.end)
        run_dir = self.root / "mismatch"
        with self.assertRaisesRegex(media.BridgeError, "identical dimensions"):
            self.prepare("mismatch")
        self.assertFalse(run_dir.exists())

    def test_prepare_rejects_stale_price_before_creating_run(self) -> None:
        self.write_cost_plan(checked_at=media.utc_now() - timedelta(hours=24, seconds=1))
        run_dir = self.root / "stale"
        with self.assertRaisesRegex(media.BridgeError, "older than 24 hours"):
            self.prepare("stale")
        self.assertFalse(run_dir.exists())

    def test_prepare_rejects_malformed_or_r2v_costs(self) -> None:
        self.write_cost_plan(total_usd="0.61")
        with self.assertRaisesRegex(media.BridgeError, "USD cost fields"):
            self.prepare("bad-usd")
        self.write_cost_plan(reference_tokens=1)
        with self.assertRaisesRegex(media.BridgeError, "must be zero"):
            self.prepare("r2v-token")

    def test_cost_plan_rejects_bool_and_float_for_fixed_integer_fields(self) -> None:
        for run_name, field, value in (
            ("bool-count", "request_count", True),
            ("float-duration", "durations_seconds", [15.0]),
            ("bool-total", "total_seconds", True),
        ):
            self.write_cost_plan()
            plan = json.loads(self.cost_plan.read_text(encoding="utf-8"))
            plan[field] = value
            self.cost_plan.write_text(json.dumps(plan), encoding="utf-8")
            with self.assertRaises(media.BridgeError):
                self.prepare(run_name)

    def test_show_allows_inspection_after_price_expires_but_approve_does_not(self) -> None:
        run_dir = self.prepare("later-inspection")
        future = media.utc_now() + timedelta(hours=25)
        with mock.patch.object(media, "utc_now", return_value=future):
            self.assertEqual(
                quiet_call(media.show, namespace(run_dir=run_dir)),
                0,
            )
            with self.assertRaisesRegex(media.BridgeError, "older than 24 hours"):
                self.approve(run_dir)

    def test_credentials_parser_reads_only_one_fal_section_candidate(self) -> None:
        self.assertEqual(media.parse_fal_key_file(self.credentials), TEST_KEY)
        cross_section = self.root / "cross-section.md"
        cross_section.write_text(
            f"# another:\n{TEST_KEY}\n\n#fal.ai：\nno key here\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(media.BridgeError, "exactly one unambiguous"):
            media.parse_fal_key_file(cross_section)
        ambiguous = self.root / "ambiguous.md"
        ambiguous.write_text(
            f"#fal.ai：\n{TEST_KEY}\nFAL_KEY={TEST_KEY}x\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(media.BridgeError, "exactly one unambiguous"):
            media.parse_fal_key_file(ambiguous)

    def test_approval_hash_tamper_blocks_submit_without_consuming_attempt(self) -> None:
        run_dir = self.prepare("tamper")
        self.approve(run_dir)
        with (run_dir / "approval-manifest.json").open("a", encoding="utf-8") as handle:
            handle.write(" \n")
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            with self.assertRaisesRegex(media.BridgeError, "not bound"):
                media.submit(self.submit_args(run_dir))
        self.assertFalse((run_dir / "submission-attempt.json").exists())

    def test_approve_preserves_verbatim_evidence_and_binds_manifest_hash(self) -> None:
        run_dir = self.prepare("verbatim-approval")
        evidence = "表示内容を確認しました。\n15秒・768P・1本の送信を承認します。  \n"
        self.approve(run_dir, evidence)
        approval = json.loads((run_dir / "approval.json").read_text(encoding="utf-8"))
        self.assertEqual(approval["approval_evidence_verbatim"], evidence)
        self.assertEqual(
            approval["manifest_sha256"],
            media.sha256_file(run_dir / "approval-manifest.json"),
        )

    def test_submit_without_override_invokes_bundled_runtime(self) -> None:
        run_dir = self.prepare("bundled-runtime")
        self.approve(run_dir)
        expected_script = SCRIPT.parents[1].resolve() / "scripts" / "generate_h3.py"

        def fake_run(command, *, cwd, fal_key, scrub_root):
            self.assertEqual(Path(command[1]).resolve(), expected_script)
            self.assertEqual(cwd, run_dir)
            output_dir = Path(command[command.index("--output-dir") + 1])
            output_dir.mkdir(parents=True, exist_ok=False)
            (output_dir / "request-id.json").write_text(
                json.dumps(
                    {
                        "endpoint": media.ENDPOINT,
                        "request_id": "bundled-request-id-001",
                        "submitted_at": "2026-09-12T00:00:00Z",
                    }
                ),
                encoding="utf-8",
            )
            return mock.Mock(returncode=0, stdout=b"", stderr=b"")

        args = namespace(run_dir=run_dir, credentials_file=self.credentials)
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            with mock.patch.object(media, "resolve_h3_skill", side_effect=self.real_resolve_h3_skill):
                with mock.patch.object(media, "run_dependency", side_effect=fake_run):
                    self.assertEqual(quiet_call(media.submit, args), 0)
        self.assertTrue((run_dir / "submission-success.json").is_file())
    def test_480p_preview_submits_approved_resolution_and_recovers(self) -> None:
        plan = json.loads(self.cost_plan.read_text(encoding="utf-8"))
        plan["resolution"] = "480P"
        self.cost_plan.write_text(json.dumps(plan), encoding="utf-8")
        run_dir = self.prepare("preview-480", resolution="480P")
        self.approve(run_dir)
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            self.assertEqual(self.submit(run_dir), 0)
            self.assertEqual(quiet_call(media.recovery, namespace(
                command="result", run_dir=run_dir, credentials_file=self.credentials)), 0)
        calls = [json.loads(line) for line in
                 (self.h3_skill / "calls.log").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(calls[0][calls[0].index("--resolution") + 1], "480P")
        self.assertTrue(list((run_dir / "h3" / "retrievals").glob("*/receipt.json")))

    def test_480p_requires_matching_explicit_resolution(self) -> None:
        plan = json.loads(self.cost_plan.read_text(encoding="utf-8"))
        plan["resolution"] = "480P"
        self.cost_plan.write_text(json.dumps(plan), encoding="utf-8")
        with self.assertRaisesRegex(media.BridgeError, "resolution must match"):
            self.prepare("mismatched-default")
        self.assertFalse((self.root / "mismatched-default").exists())

    def test_manifest_resolution_must_match_cost_snapshot(self) -> None:
        run_dir = self.prepare("resolution-tamper")
        path = run_dir / "approval-manifest.json"
        manifest = json.loads(path.read_text(encoding="utf-8"))
        manifest["settings"]["resolution"] = "480P"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(media.BridgeError, "resolution differs"):
            media.load_manifest(run_dir, fresh_price=False)

    def test_submit_is_one_attempt_and_replay_is_blocked(self) -> None:
        run_dir = self.prepare("replay")
        self.approve(run_dir, "表示された同一ハッシュの15秒動画1本を承認します。")
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            self.assertEqual(self.submit(run_dir), 0)
            with self.assertRaisesRegex(media.BridgeError, "replay is blocked"):
                self.submit(run_dir)
        calls = (self.h3_skill / "calls.log").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(calls), 1)
        self.assertTrue((run_dir / "submission-attempt.json").is_file())
        self.assertTrue((run_dir / "submission-success.json").is_file())

    def test_upload_failure_is_uncertain_and_dependency_key_output_is_redacted(self) -> None:
        run_dir = self.prepare("upload-failure")
        self.approve(run_dir)
        (self.h3_skill / "fail-submit").write_text("fail\n", encoding="utf-8")
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            with self.assertRaisesRegex(media.BridgeError, "uncertain"):
                media.submit(self.submit_args(run_dir))
        self.assertTrue((run_dir / "submission-attempt.json").is_file())
        uncertain = json.loads(
            (run_dir / "submission-uncertain.json").read_text(encoding="utf-8")
        )
        self.assertEqual(uncertain["state"], "uncertain")
        self.assertFalse((run_dir / "submission-success.json").exists())
        for path in (run_dir / "h3").rglob("*"):
            if path.is_file() and path.suffix in {".json", ".txt", ".log"}:
                self.assertNotIn(TEST_KEY, path.read_text(encoding="utf-8"))

    def test_success_without_request_id_is_marked_uncertain(self) -> None:
        run_dir = self.prepare("missing-request-id")
        self.approve(run_dir)
        (self.h3_skill / "omit-request-id").write_text("omit\n", encoding="utf-8")
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            with self.assertRaisesRegex(media.BridgeError, "saved request ID"):
                self.submit(run_dir)
        self.assertTrue((run_dir / "submission-attempt.json").is_file())
        self.assertTrue((run_dir / "submission-uncertain.json").is_file())

    def test_status_and_result_use_only_saved_request_id(self) -> None:
        run_dir = self.prepare("recovery")
        self.approve(run_dir)
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            self.assertEqual(self.submit(run_dir), 0)
            status_args = namespace(
                command="status",
                run_dir=run_dir,
                    credentials_file=self.credentials,
            )
            result_args = namespace(
                command="result",
                run_dir=run_dir,
                    credentials_file=self.credentials,
            )
            status_output = io.StringIO()
            with contextlib.redirect_stdout(status_output):
                self.assertEqual(media.recovery(status_args), 0)
            self.assertEqual(
                json.loads(status_output.getvalue())["provider_status"]["state"],
                "QUEUED",
            )
            result_output = io.StringIO()
            with contextlib.redirect_stdout(result_output):
                self.assertEqual(media.recovery(result_args), 0)
            result_report = json.loads(result_output.getvalue())
        calls = [json.loads(line) for line in (self.h3_skill / "calls.log").read_text(encoding="utf-8").splitlines()]
        self.assertEqual([call[0] for call in calls], ["submit", "status", "result"])
        for call in calls[1:]:
            self.assertEqual(call[call.index("--request-id") + 1], "fake-request-id-001")
        videos = list((run_dir / "h3" / "retrievals").glob("*/ending.mp4"))
        self.assertEqual(len(videos), 1)
        receipt_path = Path(result_report["receipt_file"])
        self.assertEqual(receipt_path, videos[0].parent / "receipt.json")
        receipt = media.validate_result_receipt(run_dir, receipt_path)
        self.assertEqual(
            set(receipt),
            {
                "version",
                "endpoint",
                "request_id",
                "manifest_sha256",
                "start_image_sha256",
                "end_image_sha256",
                "video",
                "completed_at",
            },
        )
        self.assertEqual(receipt["version"], 1)
        self.assertEqual(receipt["video"]["file"], "ending.mp4")
        self.assertEqual(receipt["video"]["sha256"], media.sha256_file(videos[0]))
        self.assertEqual(receipt["video"]["bytes"], videos[0].stat().st_size)

    def test_result_receipt_tamper_is_rejected(self) -> None:
        run_dir = self.prepare("receipt-tamper")
        self.approve(run_dir)
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            self.assertEqual(self.submit(run_dir), 0)
            _, receipt_path = self.recover_result(run_dir)
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["manifest_sha256"] = "0" * 64
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        with self.assertRaisesRegex(media.BridgeError, "manifest hash"):
            media.validate_result_receipt(run_dir, receipt_path)

    def test_result_receipt_rejects_downloaded_video_tamper(self) -> None:
        run_dir = self.prepare("receipt-video-tamper")
        self.approve(run_dir)
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            self.assertEqual(self.submit(run_dir), 0)
            _, receipt_path = self.recover_result(run_dir)
        with (receipt_path.parent / "ending.mp4").open("ab") as handle:
            handle.write(b"tampered")
        with self.assertRaisesRegex(media.BridgeError, "size or hash changed"):
            media.validate_result_receipt(run_dir, receipt_path)

    def test_result_receipt_rejects_saved_request_id_mismatch(self) -> None:
        run_dir = self.prepare("receipt-id-mismatch")
        self.approve(run_dir)
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            self.assertEqual(self.submit(run_dir), 0)
            _, receipt_path = self.recover_result(run_dir)
        saved_id_path = run_dir / "h3" / "request-id.json"
        saved_id = json.loads(saved_id_path.read_text(encoding="utf-8"))
        saved_id["request_id"] = "different-request-id"
        saved_id_path.write_text(json.dumps(saved_id), encoding="utf-8")
        with self.assertRaisesRegex(media.BridgeError, "request ID"):
            media.validate_result_receipt(run_dir, receipt_path)

    def test_result_rejects_approval_changed_after_submission(self) -> None:
        run_dir = self.prepare("receipt-approval-tamper")
        self.approve(run_dir)
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            self.assertEqual(self.submit(run_dir), 0)
        approval_path = run_dir / "approval.json"
        approval = json.loads(approval_path.read_text(encoding="utf-8"))
        approval["approval_evidence_verbatim"] = "送信後に差し替えた承認文"
        approval_path.write_text(json.dumps(approval), encoding="utf-8")
        result_args = namespace(
            command="result",
            run_dir=run_dir,
            credentials_file=self.credentials,
        )
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            with self.assertRaisesRegex(media.BridgeError, "locked submission attempt"):
                media.recovery(result_args)
        calls = [
            json.loads(line)
            for line in (self.h3_skill / "calls.log").read_text(encoding="utf-8").splitlines()
        ]
        self.assertEqual([call[0] for call in calls], ["submit"])

    def test_result_receipt_rejects_symlinked_video(self) -> None:
        run_dir = self.prepare("receipt-video-symlink")
        self.approve(run_dir)
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            self.assertEqual(self.submit(run_dir), 0)
            _, original_receipt = self.recover_result(run_dir)
        linked_retrieval = run_dir / "h3" / "retrievals" / "linked-video-case"
        linked_retrieval.mkdir()
        (linked_retrieval / "receipt.json").write_bytes(original_receipt.read_bytes())
        outside_video = self.root / "outside-ending.mp4"
        outside_video.write_bytes((original_receipt.parent / "ending.mp4").read_bytes())
        linked_video = linked_retrieval / "ending.mp4"
        try:
            os.symlink(outside_video, linked_video)
        except OSError:
            # Windows may deny symlink creation without Developer Mode. Exercise the
            # same lstat/reparse rejection branch deterministically in that environment.
            linked_video.write_bytes(outside_video.read_bytes())
            original_check = media.is_reparse_or_link

            def simulated_reparse(path: Path) -> bool:
                return path == linked_video or original_check(path)

            with mock.patch.object(media, "is_reparse_or_link", side_effect=simulated_reparse):
                with self.assertRaisesRegex(media.BridgeError, "symlink|reparse"):
                    media.validate_result_receipt(run_dir, linked_retrieval / "receipt.json")
        else:
            with self.assertRaisesRegex(media.BridgeError, "symlink|reparse"):
                media.validate_result_receipt(run_dir, linked_retrieval / "receipt.json")

    def test_provider_status_inference_matches_fal_dataclass_shapes(self) -> None:
        cases = {
            "queued": ({"position": 2}, "QUEUED"),
            "progress": ({"logs": []}, "IN_PROGRESS"),
            "completed": (
                {"logs": [], "metrics": {}, "error": None, "error_type": None},
                "COMPLETED",
            ),
            "failed": (
                {
                    "logs": [],
                    "metrics": {},
                    "error": "provider detail must not be repeated",
                    "error_type": "ProviderError",
                },
                "FAILED",
            ),
            "unknown": ({"new_field": 1}, "UNKNOWN"),
        }
        for name, (payload, expected) in cases.items():
            path = self.root / f"status-{name}.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            summary = media.provider_status_summary(path)
            self.assertEqual(summary["state"], expected)
            self.assertNotIn("error", summary)

    def test_partial_result_retry_uses_new_directory_and_same_saved_id(self) -> None:
        run_dir = self.prepare("partial-recovery")
        self.approve(run_dir)
        result_args = namespace(
            command="result",
            run_dir=run_dir,
            credentials_file=self.credentials,
        )
        with mock.patch.dict(os.environ, {"FAL_KEY": ""}, clear=False):
            self.assertEqual(self.submit(run_dir), 0)
            (self.h3_skill / "fail-result-once").write_text("once\n", encoding="utf-8")
            with self.assertRaisesRegex(media.BridgeError, "saved request ID"):
                quiet_call(media.recovery, result_args)
            self.assertEqual(quiet_call(media.recovery, result_args), 0)
        retrievals = sorted((run_dir / "h3" / "retrievals").iterdir())
        self.assertEqual(len(retrievals), 2)
        self.assertEqual(len(list(retrievals[0].glob("*.part"))), 1)
        self.assertTrue((retrievals[1] / "ending.mp4").is_file())
        calls = [json.loads(line) for line in (self.h3_skill / "calls.log").read_text(encoding="utf-8").splitlines()]
        result_calls = [call for call in calls if call[0] == "result"]
        self.assertEqual(len(result_calls), 2)
        for call in result_calls:
            self.assertEqual(call[call.index("--request-id") + 1], "fake-request-id-001")

    def test_environment_key_takes_precedence_without_reading_credentials_file(self) -> None:
        missing = self.root / "does-not-exist.md"
        args = namespace(credentials_file=missing)
        with mock.patch.dict(os.environ, {"FAL_KEY": TEST_KEY}, clear=False):
            key, source = media.credentials(args)
        self.assertEqual(key, TEST_KEY)
        self.assertEqual(source, "environment:FAL_KEY")


if __name__ == "__main__":
    unittest.main()
