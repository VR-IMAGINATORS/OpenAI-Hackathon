from __future__ import annotations
import argparse, base64, importlib.metadata, importlib.util, io, json
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "flare_image.py"
SPEC = importlib.util.spec_from_file_location("flare_image", SCRIPT)
flare = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(flare)
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")

class Images:
    def __init__(self, response=None, error=None):
        self.calls = 0
        self.response = response
        self.error = error
    def generate(self, *, model, prompt, n, size, quality, output_format):
        self.calls += 1
        if self.error:
            raise self.error
        return self.response
    def edit(self, *, image, model, prompt, n, size, quality, output_format):
        self.calls += 1
        if self.error:
            raise self.error
        return self.response

class Client:
    def __init__(self, images):
        self.images = images

def args(command="edit", preflight_only=True):
    return argparse.Namespace(command=command, prompt_file="prompt.txt",
        image=["one.png"] if command == "edit" else [], out="result.png",
        credential_file=None, approval_json=None, timeout=120.0,
        preflight_only=preflight_only)

class FlareImageTests(unittest.TestCase):
    def test_credentials_ignore_unrelated_and_sample_keys(self):
        text = "# Gemini\nsk-other\nexample sk-sample\n#GPT Admin:\nsk-admin\n"
        self.assertEqual([], flare.credential_candidates(text))

    def test_credentials_accept_exact_field_or_heading(self):
        self.assertEqual(["sk-live"], flare.credential_candidates("OPENAI_API_KEY=sk-live"))
        self.assertEqual(["sk-live"], flare.credential_candidates("#GPT：\nsk-live\n#GPT Admin:\nsk-admin"))

    def test_multiple_keys_in_one_heading_remain_ambiguous(self):
        self.assertEqual(2, len(flare.credential_candidates("#OpenAI\nsk-old\nsk-new")))
    def test_duplicate_credentials_remain_ambiguous(self):
        self.assertEqual(2, len(flare.credential_candidates("#OpenAI\nsk-one\nOPENAI_API_KEY=sk-one")))

    def test_existing_output_stops_before_request(self):
        with patch.object(flare.os.path, "lexists", return_value=True):
            with self.assertRaises(SystemExit):
                flare.validate_output(Path("result.png"))

    def test_real_preflight_calls_no_images_api_and_binds_loaded_bytes(self):
        images = Images()
        captured = {}
        def make_client(**kwargs):
            captured.update(kwargs)
            return Client(images)
        def read_bytes(path):
            return b"prompt bytes" if str(path).endswith(".txt") else PNG
        with patch("openai.OpenAI", side_effect=make_client), \
             patch.object(importlib.metadata, "version", side_effect=lambda name: "2.26.0" if name == "openai" else "11.0.0"), \
             patch.object(flare, "load_key", return_value="sk-test"), \
             patch.object(flare, "reject_reparse_chain"), \
             patch.object(flare, "validate_output", return_value=Path("result.png").absolute()), \
             patch.object(flare.Path, "is_file", return_value=True), \
             patch.object(flare.Path, "read_bytes", autospec=True, side_effect=read_bytes):
            result = flare.preflight(args())
        self.assertEqual(0, images.calls)
        self.assertEqual(0, captured["max_retries"])
        self.assertEqual(flare.digest(b"prompt bytes"), result[-1]["prompt_sha256"])
        self.assertEqual(flare.digest(PNG), result[-1]["image_sha256"][0])
        self.assertEqual("edit", result[-1]["command"])
        self.assertEqual("/v1/images/edits", result[-1]["endpoint"])
        self.assertEqual("png", result[-1]["output_format"])
        self.assertEqual(PNG, result[3][0][1])

    def test_dependency_lower_bound_is_enforced(self):
        self.assertLess(flare.version_tuple("2.25.9"), (2, 26, 0))
        self.assertGreaterEqual(flare.version_tuple("2.26.0"), (2, 26, 0))

    def test_approval_rejects_bool_price(self):
        approval = {"approved": True, "approval_note": "yes", "price_source": "https://example.test",
            "estimated_usd": True, "price_checked_at": "2026-09-12T00:00:00Z",
            "approved_at": "2026-09-12T00:01:00Z", "request": {}}
        with patch.object(flare, "reject_reparse_chain"), \
             patch.object(flare.Path, "read_bytes", return_value=json.dumps(approval).encode()):
            with self.assertRaises(SystemExit):
                flare.validate_approval("approval.json", {})

    def test_output_race_uses_exclusive_create_and_stops_before_api(self):
        images = Images()
        manifest = {"model": flare.MODEL}
        with patch.object(flare, "preflight", return_value=(Client(images), object(), "p", [], Path("x"), manifest)), \
             patch.object(flare, "validate_approval", return_value="HASH"), \
             patch.object(flare.os, "open", side_effect=FileExistsError) as opened:
            with self.assertRaises(SystemExit):
                flare.run(args("generate", False))
        self.assertTrue(opened.call_args.args[1] & flare.os.O_EXCL)
        self.assertEqual(0, images.calls)

    def test_api_failure_is_called_once_and_marked_maybe_sent(self):
        images = Images(error=RuntimeError("ambiguous"))
        manifest = {"model": flare.MODEL}
        stderr = io.StringIO()
        with patch.object(flare, "preflight", return_value=(Client(images), object(), "p", [], Path("x"), manifest)), \
             patch.object(flare, "validate_approval", return_value="HASH"), \
             patch.object(flare.os, "open", return_value=99), \
             patch.object(flare.os, "close"), \
             patch("sys.stderr", stderr):
            self.assertEqual(3, flare.run(args("generate", False)))
        self.assertEqual(1, images.calls)
        self.assertEqual("maybe_sent", json.loads(stderr.getvalue())["send_state"])

    def test_invalid_base64_is_rejected(self):
        with self.assertRaises(Exception):
            flare.decode_png("not-base64!", object())

if __name__ == "__main__":
    unittest.main()