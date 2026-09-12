#!/usr/bin/env python3
"""Preflight and make one non-retrying Flare image API request."""
from __future__ import annotations
import argparse, base64, hashlib, inspect, json, math, os, re, sys, time
from contextlib import ExitStack
from datetime import datetime, timezone, timedelta
from io import BytesIO
from pathlib import Path

MODEL = "gpt-image-2.5-flare"
SIZE = "1536x1024"
QUALITY = "low"
KEY_VALUE_RE = re.compile(r"sk-[A-Za-z0-9_-]+")
FIELD_RE = re.compile(r"^\s*(?:export\s+)?OPENAI_API_KEY\s*[:=]\s*['\"]?(sk-[A-Za-z0-9_-]+)['\"]?\s*$", re.I)
REPARSE_ATTRIBUTE = 0x400
PRICE_MAX_AGE = timedelta(hours=24)

class NamedBytesIO(BytesIO):
    def __init__(self, data: bytes, name: str):
        super().__init__(data)
        self.name = name

def emit_error(message: str, **details) -> None:
    payload = {"ready": False, "error": message, "retry_allowed": False}
    payload.update(details)
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)

def fail(message: str) -> None:
    emit_error(message, send_state="not_sent")
    raise SystemExit(2)

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()

def credential_candidates(text: str) -> list[str]:
    candidates = []
    lines = text.splitlines()
    for line in lines:
        match = FIELD_RE.fullmatch(line)
        if match:
            candidates.append(match.group(1))
    for index, line in enumerate(lines):
        heading = re.sub(r"[\s：:]+", "", line).lower()
        if heading not in {"#gpt", "#openai"}:
            continue
        for following in lines[index + 1:]:
            value = following.strip()
            if value.startswith("#"):
                break
            if KEY_VALUE_RE.fullmatch(value):
                candidates.append(value)
    return candidates

def is_reparse(path: Path) -> bool:
    try:
        stat = path.lstat()
    except OSError:
        return False
    return bool(getattr(stat, "st_file_attributes", 0) & REPARSE_ATTRIBUTE) or path.is_symlink()

def reject_reparse_chain(path: Path, label: str) -> None:
    current = path.absolute()
    while True:
        if is_reparse(current):
            fail(f"{label} may not traverse a symlink or reparse point")
        if current.parent == current:
            return
        current = current.parent

def load_key(credential_file: str | None) -> str:
    value = os.getenv("OPENAI_API_KEY", "").strip()
    if value:
        if not KEY_VALUE_RE.fullmatch(value):
            fail("OPENAI_API_KEY has an unsupported format")
        return value
    if not credential_file:
        fail("OPENAI_API_KEY or --credential-file is required")
    path = Path(credential_file)
    reject_reparse_chain(path, "credential file")
    if not path.is_file():
        fail("credential file is not readable")
    candidates = credential_candidates(path.read_text(encoding="utf-8-sig"))
    if len(candidates) != 1:
        fail("credential file must contain exactly one key under OPENAI_API_KEY, #OpenAI, or #GPT")
    return candidates[0]

def validate_output(output: Path) -> Path:
    if os.path.lexists(output):
        fail("output already exists; choose a new path")
    parent = output.parent.absolute()
    if not parent.is_dir() or not os.access(parent, os.W_OK):
        fail("output directory is not writable")
    reject_reparse_chain(parent, "output path")
    return output.absolute()

def version_tuple(value: str) -> tuple[int, ...]:
    match = re.match(r"^(\d+)\.(\d+)(?:\.(\d+))?", value)
    if not match:
        fail("dependency version is not parseable")
    return tuple(int(part or 0) for part in match.groups())

def request_manifest(prompt_bytes: bytes, image_payloads: list[tuple[str, bytes]], output: Path) -> dict:
    command = "edit" if image_payloads else "generate"
    return {
        "command": command,
        "endpoint": "/v1/images/edits" if image_payloads else "/v1/images/generations",
        "model": MODEL, "quality": QUALITY, "size": SIZE, "n": 1,
        "output_format": "png", "max_retries": 0,
        "prompt_sha256": digest(prompt_bytes),
        "image_sha256": [digest(data) for _, data in image_payloads],
        "output": str(output),
    }

def parse_time(value, name: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        fail(f"approval JSON {name} must be a non-empty ISO 8601 string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail(f"approval JSON {name} is not ISO 8601")
    if parsed.tzinfo is None:
        fail(f"approval JSON {name} must include a timezone")
    return parsed.astimezone(timezone.utc)

def validate_approval(path_value: str | None, manifest: dict) -> str:
    if not path_value:
        fail("--approval-json is required for an API request")
    path = Path(path_value)
    reject_reparse_chain(path, "approval JSON")
    try:
        raw = path.read_bytes()
        approval = json.loads(raw.decode("utf-8"))
    except Exception:
        fail("approval JSON is unreadable or invalid")
    if not isinstance(approval, dict):
        fail("approval JSON top level must be an object")
    if approval.get("approved") is not True:
        fail("approval JSON does not record explicit approval")
    for name in ("approval_note", "price_source"):
        value = approval.get(name)
        if not isinstance(value, str) or not value.strip():
            fail(f"approval JSON {name} must be a non-empty string")
    if not approval["price_source"].startswith("https://"):
        fail("approval JSON price_source must be an HTTPS URL")
    price = approval.get("estimated_usd")
    if type(price) not in (int, float) or not math.isfinite(price) or price < 0:
        fail("approval JSON estimated_usd is invalid")
    price_at = parse_time(approval.get("price_checked_at"), "price_checked_at")
    approved_at = parse_time(approval.get("approved_at"), "approved_at")
    now = datetime.now(timezone.utc)
    if approved_at < price_at or approved_at > now + timedelta(minutes=5):
        fail("approval time must follow price check and not be in the future")
    if now - price_at > PRICE_MAX_AGE:
        fail("price check is older than 24 hours")
    if approval.get("request") != manifest:
        fail("approval JSON does not match this exact request")
    return digest(raw)

def decode_png(encoded: str, Image) -> bytes:
    if not isinstance(encoded, str) or not encoded:
        raise ValueError("image response has no base64 payload")
    raw = base64.b64decode(encoded, validate=True)
    with Image.open(BytesIO(raw)) as image:
        image.verify()
        if image.format != "PNG":
            raise ValueError("image response is not PNG")
    return raw

def preflight(args: argparse.Namespace):
    if sys.version_info < (3, 10):
        fail("Python 3.10 or newer is required")
    try:
        import importlib.metadata
        from openai import OpenAI
        from PIL import Image
    except ImportError as exc:
        fail(f"missing dependency: {exc.name}; use the documented uv command")
    openai_version = version_tuple(importlib.metadata.version("openai"))
    pillow_version = version_tuple(importlib.metadata.version("pillow"))
    if not ((2, 26, 0) <= openai_version < (3, 0, 0)):
        fail("OpenAI SDK must satisfy >=2.26,<3")
    if not ((11, 0, 0) <= pillow_version < (13, 0, 0)):
        fail("Pillow must satisfy >=11,<13")
    key = load_key(args.credential_file)
    prompt_path = Path(args.prompt_file)
    reject_reparse_chain(prompt_path, "prompt file")
    if not prompt_path.is_file():
        fail("prompt file is missing")
    prompt_bytes = prompt_path.read_bytes()
    try:
        prompt = prompt_bytes.decode("utf-8")
    except UnicodeDecodeError:
        fail("prompt file is not UTF-8")
    if not prompt.strip():
        fail("prompt file is empty")
    image_paths = [Path(value) for value in args.image]
    if args.command == "generate" and image_paths:
        fail("generate does not accept --image")
    if args.command == "edit" and not image_paths:
        fail("edit requires at least one --image")
    image_payloads = []
    for path in image_paths:
        reject_reparse_chain(path, "input image")
        if not path.is_file():
            fail(f"image is missing: {path}")
        data = path.read_bytes()
        try:
            with Image.open(BytesIO(data)) as image:
                image.verify()
        except Exception:
            fail(f"image validation failed: {path}")
        image_payloads.append((path.name, data))
    output = validate_output(Path(args.out))
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        fail("--timeout must be a positive finite number")
    client = OpenAI(api_key=key, max_retries=0, timeout=args.timeout)
    method = client.images.edit if args.command == "edit" else client.images.generate
    required = {"model", "prompt", "n", "size", "quality", "output_format"}
    if args.command == "edit":
        required.add("image")
    if not required.issubset(inspect.signature(method).parameters):
        fail("installed OpenAI SDK lacks required Images API parameters")
    manifest = request_manifest(prompt_bytes, image_payloads, output)
    return client, Image, prompt, image_payloads, output, manifest

def run(args: argparse.Namespace) -> int:
    client, Image, prompt, image_payloads, output, manifest = preflight(args)
    report = {"ready": True, "send_state": "not_sent", "request": manifest}
    if args.preflight_only:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    approval_sha256 = validate_approval(args.approval_json, manifest)
    try:
        output_fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        fail("output was created after preflight; API request not sent")
    started = time.monotonic()
    response = None
    send_state = "maybe_sent"
    try:
        common = dict(model=MODEL, prompt=prompt, n=1, size=SIZE, quality=QUALITY, output_format="png")
        with ExitStack() as stack:
            streams = [stack.enter_context(NamedBytesIO(data, name)) for name, data in image_payloads]
            response = client.images.edit(image=streams, **common) if streams else client.images.generate(**common)
        send_state = "response_received"
        raw = decode_png(response.data[0].b64_json, Image)
        with os.fdopen(output_fd, "wb") as target:
            output_fd = -1
            target.write(raw)
            target.flush()
            os.fsync(target.fileno())
    except Exception as exc:
        if output_fd >= 0:
            os.close(output_fd)
        request_id = getattr(response, "_request_id", None) if response is not None else getattr(exc, "request_id", None)
        emit_error("API request or response recovery failed", send_state=send_state,
                   request_id=request_id, reserved_output=str(output))
        return 3
    report.update({"send_state": "response_received", "endpoint": "/v1/images/edits" if image_payloads else "/v1/images/generations",
                   "elapsed_seconds": round(time.monotonic() - started, 3), "bytes": len(raw),
                   "sha256": digest(raw), "request_id": getattr(response, "_request_id", None),
                   "approval_sha256": approval_sha256})
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0

def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("command", choices=("generate", "edit"))
    result.add_argument("--prompt-file", required=True)
    result.add_argument("--image", action="append", default=[])
    result.add_argument("--out", required=True)
    result.add_argument("--credential-file")
    result.add_argument("--approval-json")
    result.add_argument("--timeout", type=float, default=120.0)
    result.add_argument("--preflight-only", action="store_true")
    return result

if __name__ == "__main__":
    raise SystemExit(run(parser().parse_args()))