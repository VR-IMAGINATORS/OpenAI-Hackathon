#!/usr/bin/env python3
"""Prepare, approve, submit, and recover one bounded H3 ending video."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal, DecimalException, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Iterable


ENDPOINT = "minimax/h3-max-turbo/image-to-video"
MODE = "i2v"
RESOLUTION = "768P"
DURATION_SECONDS = 15
REQUEST_COUNT = 1
PROMPT_EXPANSION_MODE = "balanced"
MANIFEST_SCHEMA = "call-to-past.h3-approval-manifest.v1"
APPROVAL_SCHEMA = "call-to-past.h3-approval.v1"
ATTEMPT_SCHEMA = "call-to-past.h3-submission-attempt.v1"
RECEIPT_VERSION = 1
MAX_PRICE_AGE = timedelta(hours=24)
CENT = Decimal("0.01")
MOJIBAKE_MARKERS = ("縺", "繧", "菴", "蜿", "逡", "�")
FAL_HEADING = re.compile(r"^fal(?:\s*\.\s*|\s+)ai$|^fal$", re.IGNORECASE)
MARKDOWN_HEADING = re.compile(r"^\s{0,3}(#{1,6})\s*(.*?)\s*$")
LABELED_KEY = re.compile(
    r"^\s*(?:[-*]\s*)?(?:`?FAL_KEY`?|fal(?:\.ai)?\s+(?:api\s+)?key|(?:api\s+)?key)"
    r"\s*[:=]\s*(.*?)\s*$",
    re.IGNORECASE,
)
BARE_FAL_KEY = re.compile(r"^[A-Za-z0-9_-]{8,}:[A-Za-z0-9_.-]{8,}$")
LABELED_FAL_KEY = re.compile(r"^[A-Za-z0-9_.:-]{20,512}$")


class BridgeError(RuntimeError):
    """Safe user-facing failure from the media bridge."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def is_reparse_or_link(path: Path) -> bool:
    try:
        stat = path.lstat()
    except FileNotFoundError:
        return False
    if path.is_symlink():
        return True
    attrs = getattr(stat, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attrs & reparse)


def assert_no_reparse_chain(path: Path, label: str) -> Path:
    """Inspect the unresolved path and each existing ancestor for links/reparse points."""

    absolute = Path(os.path.abspath(os.fspath(path)))
    chain: list[Path] = []
    cursor = absolute
    while True:
        chain.append(cursor)
        parent = cursor.parent
        if parent == cursor:
            break
        cursor = parent
    for candidate in reversed(chain):
        if is_reparse_or_link(candidate):
            raise BridgeError(f"{label} contains a symlink, junction, or reparse point")
    return absolute


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def write_bytes_new(path: Path, data: bytes) -> None:
    """Create a new durable file without an overwrite window."""

    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        # The retained partial file intentionally prevents unsafe replay.
        raise


def write_json_new(path: Path, value: Any) -> None:
    write_bytes_new(path, json_bytes(value))


def load_json_object(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise BridgeError(f"{label} is missing: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BridgeError(f"{label} is not valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise BridgeError(f"{label} must be a JSON object")
    return value


def parse_timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise BridgeError(f"{field} must be an ISO-8601 timestamp")
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise BridgeError(f"{field} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise BridgeError(f"{field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def decimal_field(
    value: Any,
    field: str,
    *,
    positive: bool = False,
    non_negative: bool = False,
) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise BridgeError(f"{field} must be an exact decimal string or integer")
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise BridgeError(f"{field} is not a valid decimal") from exc
    if not result.is_finite():
        raise BridgeError(f"{field} must be finite")
    if positive and result <= 0:
        raise BridgeError(f"{field} must be positive")
    if non_negative and result < 0:
        raise BridgeError(f"{field} must be non-negative")
    return result


def money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def require_zero(data: dict[str, Any], field: str) -> None:
    if field in data and decimal_field(data[field], field, non_negative=True) != 0:
        raise BridgeError(f"{field} must be zero for I2V")


def validate_cost_plan(
    plan: dict[str, Any],
    *,
    now: datetime | None = None,
    enforce_fresh: bool = True,
) -> dict[str, Any]:
    """Validate the exact one-request estimate approved by this game."""

    current = (now or utc_now()).astimezone(timezone.utc)
    required = {
        "mode",
        "resolution",
        "durations_seconds",
        "request_count",
        "video_rate_usd_per_second",
        "video_cost_usd",
        "reference_tokens_per_request",
        "total_cost_usd",
        "usd_jpy",
        "total_cost_jpy",
        "pricing_source",
        "pricing_checked_at",
    }
    missing = sorted(required - set(plan))
    if missing:
        raise BridgeError(f"cost plan is missing required fields: {', '.join(missing)}")
    if plan["mode"] != MODE or plan["resolution"] != RESOLUTION:
        raise BridgeError("cost plan must be I2V at 768P")
    durations = plan["durations_seconds"]
    request_count = plan["request_count"]
    if (
        not isinstance(durations, list)
        or len(durations) != 1
        or isinstance(durations[0], bool)
        or not isinstance(durations[0], int)
        or durations[0] != DURATION_SECONDS
        or isinstance(request_count, bool)
        or not isinstance(request_count, int)
        or request_count != 1
    ):
        raise BridgeError("cost plan must contain exactly one 15-second request")
    if "total_seconds" in plan:
        total_seconds = plan["total_seconds"]
        if (
            isinstance(total_seconds, bool)
            or not isinstance(total_seconds, int)
            or total_seconds != DURATION_SECONDS
        ):
            raise BridgeError("cost plan total_seconds is inconsistent")
    if "reference_images" in plan and plan["reference_images"] != []:
        raise BridgeError("I2V cost plan must not contain R2V references")
    require_zero(plan, "reference_tokens_per_request")
    for field in (
        "billable_reference_tokens_per_request",
        "reference_cost_usd_per_request",
        "reference_cost_usd_total",
    ):
        require_zero(plan, field)

    source = plan["pricing_source"]
    if not isinstance(source, str):
        raise BridgeError("pricing_source must be the official fal URL")
    try:
        parsed_url = urllib.parse.urlparse(source)
        hostname = (parsed_url.hostname or "").lower()
    except ValueError as exc:
        raise BridgeError("pricing_source must be the official H3 Turbo I2V fal URL") from exc
    expected_path = "/models/minimax/h3-max-turbo/image-to-video"
    if (
        parsed_url.scheme.lower() != "https"
        or hostname not in {"fal.ai", "www.fal.ai"}
        or parsed_url.path.rstrip("/") not in {expected_path, f"{expected_path}/api"}
        or parsed_url.username is not None
        or parsed_url.password is not None
    ):
        raise BridgeError("pricing_source must be the official H3 Turbo I2V fal URL")

    checked_at = parse_timestamp(plan["pricing_checked_at"], "pricing_checked_at")
    age = current - checked_at
    if age < timedelta(0):
        raise BridgeError("pricing_checked_at must not be in the future")
    if enforce_fresh and age > MAX_PRICE_AGE:
        raise BridgeError("pricing is older than 24 hours; create a new cost plan")

    rate = decimal_field(
        plan["video_rate_usd_per_second"],
        "video_rate_usd_per_second",
        positive=True,
    )
    usd_jpy = decimal_field(plan["usd_jpy"], "usd_jpy", positive=True)
    video_cost = decimal_field(plan["video_cost_usd"], "video_cost_usd", positive=True)
    total_usd = decimal_field(plan["total_cost_usd"], "total_cost_usd", positive=True)
    total_jpy = decimal_field(plan["total_cost_jpy"], "total_cost_jpy", positive=True)
    try:
        raw_usd = rate * Decimal(DURATION_SECONDS)
        expected_usd = money(raw_usd)
        expected_jpy = money(raw_usd * usd_jpy)
    except (DecimalException, OverflowError) as exc:
        raise BridgeError("cost arithmetic is outside the supported decimal range") from exc
    if video_cost != expected_usd or total_usd != expected_usd:
        raise BridgeError("USD cost fields are inconsistent with rate and duration")
    if total_jpy != expected_jpy:
        raise BridgeError("JPY cost is inconsistent with USD cost and exchange rate")

    return {
        "pricing_checked_at": iso_utc(checked_at),
        "price_age_seconds": int(age.total_seconds()),
        "video_rate_usd_per_second": str(rate),
        "total_cost_usd": str(total_usd),
        "usd_jpy": str(usd_jpy),
        "total_cost_jpy": str(total_jpy),
    }


def read_prompt(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        raise BridgeError("prompt must be a readable UTF-8 text file") from exc
    if not text.strip():
        raise BridgeError("prompt is empty")
    marker_count = sum(text.count(marker) for marker in MOJIBAKE_MARKERS)
    if "�" in text or marker_count >= 2:
        raise BridgeError("prompt contains probable mojibake")
    return text


def image_dimensions(path: Path) -> tuple[int, int]:
    try:
        from PIL import Image
    except ImportError as exc:
        raise BridgeError("Pillow is required to validate H3 images") from exc
    try:
        with Image.open(path) as image:
            width, height = image.size
            image.verify()
    except Exception as exc:
        raise BridgeError(f"image is unreadable: {path}") from exc
    if width <= 0 or height <= 0:
        raise BridgeError(f"image has invalid dimensions: {path}")
    return width, height


def safe_suffix(path: Path) -> str:
    suffix = path.suffix.lower()
    return suffix if re.fullmatch(r"\.[a-z0-9]{1,8}", suffix) else ".image"


def copy_snapshot(source: Path, destination: Path) -> str:
    if not source.is_file():
        raise BridgeError(f"input file is missing: {source}")
    digest = hashlib.sha256()
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with source.open("rb") as reader, os.fdopen(descriptor, "wb") as writer:
            for chunk in iter(lambda: reader.read(1024 * 1024), b""):
                digest.update(chunk)
                writer.write(chunk)
            writer.flush()
            os.fsync(writer.fileno())
    except Exception:
        raise
    return digest.hexdigest().upper()


def ensure_file(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file():
        raise BridgeError(f"{label} is missing: {resolved}")
    return resolved


def prepare(args: argparse.Namespace) -> int:
    prompt_source = ensure_file(args.prompt_file, "prompt")
    start_source = ensure_file(args.start_image, "start image")
    end_source = ensure_file(args.end_image, "end image")
    cost_source = ensure_file(args.cost_plan, "cost plan")
    prompt_text = read_prompt(prompt_source)
    start_size = image_dimensions(start_source)
    end_size = image_dimensions(end_source)
    if start_size != end_size:
        raise BridgeError(
            "start and end images must have identical dimensions and aspect ratio"
        )
    plan = load_json_object(cost_source, "cost plan")
    cost_summary = validate_cost_plan(plan)

    run_dir = args.run_dir.resolve()
    run_dir.mkdir(parents=True, exist_ok=False)
    snapshot_dir = run_dir / "approval-snapshot"
    snapshot_dir.mkdir()
    prompt_snapshot = snapshot_dir / "prompt.txt"
    start_snapshot = snapshot_dir / f"start{safe_suffix(start_source)}"
    end_snapshot = snapshot_dir / f"end{safe_suffix(end_source)}"
    cost_snapshot = snapshot_dir / "cost-plan.json"
    prompt_hash = copy_snapshot(prompt_source, prompt_snapshot)
    start_hash = copy_snapshot(start_source, start_snapshot)
    end_hash = copy_snapshot(end_source, end_snapshot)
    cost_hash = copy_snapshot(cost_source, cost_snapshot)

    divisor = math.gcd(*start_size)
    aspect_ratio = f"{start_size[0] // divisor}:{start_size[1] // divisor}"
    manifest: dict[str, Any] = {
        "schema": MANIFEST_SCHEMA,
        "created_at": iso_utc(utc_now()),
        "endpoint": ENDPOINT,
        "settings": {
            "mode": MODE,
            "duration_seconds": DURATION_SECONDS,
            "resolution": RESOLUTION,
            "request_count": REQUEST_COUNT,
            "request_slot": 1,
            "prompt_expansion_mode": PROMPT_EXPANSION_MODE,
            "safety_checker": True,
            "seed": args.seed,
        },
        "prompt": {
            "source": str(prompt_source),
            "snapshot": str(prompt_snapshot.relative_to(run_dir)),
            "sha256": prompt_hash,
            "text": prompt_text,
        },
        "start_image": {
            "source": str(start_source),
            "snapshot": str(start_snapshot.relative_to(run_dir)),
            "sha256": start_hash,
            "width": start_size[0],
            "height": start_size[1],
            "aspect_ratio": aspect_ratio,
        },
        "end_image": {
            "source": str(end_source),
            "snapshot": str(end_snapshot.relative_to(run_dir)),
            "sha256": end_hash,
            "width": end_size[0],
            "height": end_size[1],
            "aspect_ratio": aspect_ratio,
        },
        "cost": {
            "snapshot": str(cost_snapshot.relative_to(run_dir)),
            "sha256": cost_hash,
            "plan": plan,
            "validated": cost_summary,
            "estimate_scope": "H3 video request only",
            "native_or_codex_costs_included": False,
            "native_or_codex_costs_note": (
                "Native image generation, Codex usage, and other provider costs are not included."
            ),
        },
        "approval_notice": (
            "This manifest is preparation only. The approve command records an explicit "
            "user approval already obtained for this exact hash; it cannot grant approval."
        ),
    }
    manifest_path = run_dir / "approval-manifest.json"
    write_json_new(manifest_path, manifest)
    output = {"manifest_sha256": sha256_file(manifest_path), "manifest": manifest}
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


def load_manifest(run_dir: Path, *, fresh_price: bool) -> tuple[Path, dict[str, Any]]:
    manifest_path = run_dir / "approval-manifest.json"
    manifest = load_json_object(manifest_path, "approval manifest")
    if manifest.get("schema") != MANIFEST_SCHEMA or manifest.get("endpoint") != ENDPOINT:
        raise BridgeError("approval manifest schema or endpoint is invalid")
    expected_settings = {
        "mode": MODE,
        "duration_seconds": DURATION_SECONDS,
        "resolution": RESOLUTION,
        "request_count": REQUEST_COUNT,
        "request_slot": 1,
        "prompt_expansion_mode": PROMPT_EXPANSION_MODE,
        "safety_checker": True,
    }
    settings = manifest.get("settings")
    if not isinstance(settings, dict):
        raise BridgeError("approval manifest settings are invalid")
    for field, expected in expected_settings.items():
        actual = settings.get(field)
        if type(actual) is not type(expected) or actual != expected:
            raise BridgeError(f"approval manifest setting changed: {field}")
    seed = settings.get("seed")
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int)):
        raise BridgeError("approval manifest seed is invalid")

    for label in ("prompt", "start_image", "end_image"):
        record = manifest.get(label)
        if not isinstance(record, dict):
            raise BridgeError(f"approval manifest {label} is invalid")
        snapshot = resolve_snapshot(run_dir, record.get("snapshot"), label)
        if sha256_file(snapshot) != record.get("sha256"):
            raise BridgeError(f"{label} snapshot hash changed")
        if label == "prompt":
            if read_prompt(snapshot) != record.get("text"):
                raise BridgeError("prompt snapshot text changed")
        else:
            width, height = image_dimensions(snapshot)
            recorded_width = record.get("width")
            recorded_height = record.get("height")
            if (
                isinstance(recorded_width, bool)
                or not isinstance(recorded_width, int)
                or isinstance(recorded_height, bool)
                or not isinstance(recorded_height, int)
                or [width, height] != [recorded_width, recorded_height]
            ):
                raise BridgeError(f"{label} dimensions changed")
    if (
        manifest["start_image"].get("width") != manifest["end_image"].get("width")
        or manifest["start_image"].get("height") != manifest["end_image"].get("height")
        or manifest["start_image"].get("aspect_ratio")
        != manifest["end_image"].get("aspect_ratio")
    ):
        raise BridgeError("start/end image dimensions or aspect ratio do not match")

    cost = manifest.get("cost")
    if not isinstance(cost, dict):
        raise BridgeError("approval manifest cost is invalid")
    if cost.get("native_or_codex_costs_included") is not False:
        raise BridgeError("approval manifest must state that native/Codex costs are excluded")
    cost_snapshot = resolve_snapshot(run_dir, cost.get("snapshot"), "cost plan")
    if sha256_file(cost_snapshot) != cost.get("sha256"):
        raise BridgeError("cost plan snapshot hash changed")
    plan = load_json_object(cost_snapshot, "cost plan snapshot")
    if plan != cost.get("plan"):
        raise BridgeError("cost plan snapshot no longer matches the approval manifest")
    validate_cost_plan(plan, now=utc_now(), enforce_fresh=fresh_price)
    return manifest_path, manifest


def resolve_snapshot(run_dir: Path, value: Any, label: str) -> Path:
    if not isinstance(value, str) or not value:
        raise BridgeError(f"{label} snapshot path is invalid")
    candidate = (run_dir / value).resolve()
    try:
        candidate.relative_to(run_dir.resolve())
    except ValueError as exc:
        raise BridgeError(f"{label} snapshot escapes the run directory") from exc
    if not candidate.is_file():
        raise BridgeError(f"{label} snapshot is missing")
    return candidate


def show(args: argparse.Namespace) -> int:
    run_dir = args.run_dir.resolve()
    manifest_path, manifest = load_manifest(run_dir, fresh_price=False)
    print(
        json.dumps(
            {"manifest_sha256": sha256_file(manifest_path), "manifest": manifest},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def approval_evidence(args: argparse.Namespace) -> str:
    if args.approval_text is not None:
        evidence = args.approval_text
    else:
        try:
            evidence = args.approval_evidence_file.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError) as exc:
            raise BridgeError("approval evidence file must be readable UTF-8") from exc
    if not evidence.strip():
        raise BridgeError("approval evidence is empty")
    return evidence


def approve(args: argparse.Namespace) -> int:
    run_dir = args.run_dir.resolve()
    manifest_path, _ = load_manifest(run_dir, fresh_price=True)
    actual_hash = sha256_file(manifest_path)
    expected_hash = args.manifest_sha256.strip().upper()
    if not re.fullmatch(r"[0-9A-F]{64}", expected_hash) or expected_hash != actual_hash:
        raise BridgeError("provided manifest hash does not match the reviewed manifest")
    evidence = approval_evidence(args)
    record = {
        "schema": APPROVAL_SCHEMA,
        "manifest_sha256": actual_hash,
        "approved_at": iso_utc(utc_now()),
        "approval_evidence_verbatim": evidence,
        "notice": (
            "This record preserves approval already given by the user. Running this "
            "command by itself is not user approval."
        ),
    }
    approval_path = run_dir / "approval.json"
    write_json_new(approval_path, record)
    print(json.dumps(record, ensure_ascii=False, indent=2))
    return 0


def normalize_heading(text: str) -> str:
    stripped = text.strip().strip("`*_ ")
    stripped = stripped.rstrip(":：").strip()
    return re.sub(r"\s+", " ", stripped)


def unquote_key(value: str) -> str:
    stripped = value.strip()
    if len(stripped) >= 2 and stripped[0] == stripped[-1] and stripped[0] in "\"'`":
        stripped = stripped[1:-1]
    return stripped


def parse_fal_key_file(path: Path) -> str:
    """Read exactly one key from exactly one markdown fal/fal.ai section."""

    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeError) as exc:
        raise BridgeError("credentials file must be readable UTF-8") from exc
    headings: list[tuple[int, int, str]] = []
    for index, line in enumerate(lines):
        match = MARKDOWN_HEADING.match(line)
        if match and match.group(2):
            headings.append((index, len(match.group(1)), normalize_heading(match.group(2))))
    fal_headings = [item for item in headings if FAL_HEADING.fullmatch(item[2])]
    if len(fal_headings) != 1:
        raise BridgeError("credentials file must contain exactly one fal.ai markdown section")
    start, level, _ = fal_headings[0]
    end = len(lines)
    for index, next_level, _ in headings:
        if index > start and next_level <= level:
            end = index
            break

    candidates: list[str] = []
    malformed_labeled = False
    in_fence = False
    for raw in lines[start + 1 : end]:
        stripped = raw.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue
        if not stripped or stripped.startswith("<!--"):
            continue
        labeled = LABELED_KEY.match(raw)
        if labeled:
            candidate = unquote_key(labeled.group(1))
            if not LABELED_FAL_KEY.fullmatch(candidate):
                malformed_labeled = True
            else:
                candidates.append(candidate)
            continue
        bare = unquote_key(stripped)
        if BARE_FAL_KEY.fullmatch(bare):
            candidates.append(bare)
        elif in_fence and re.search(r"(?i)key|fal", stripped):
            malformed_labeled = True
    if malformed_labeled or len(candidates) != 1:
        raise BridgeError("fal.ai section must contain exactly one unambiguous key candidate")
    return candidates[0]


def credentials(args: argparse.Namespace) -> tuple[str, str]:
    environment_key = os.environ.get("FAL_KEY")
    if environment_key:
        if not LABELED_FAL_KEY.fullmatch(environment_key):
            raise BridgeError("FAL_KEY environment value has an invalid shape")
        return environment_key, "environment:FAL_KEY"
    if args.credentials_file is None:
        raise BridgeError("FAL_KEY is unset; pass --credentials-file")
    key = parse_fal_key_file(args.credentials_file.resolve())
    return key, "credentials-file:fal.ai-section"


def resolve_h3_skill() -> Path:
    skill = Path(__file__).resolve().parents[1]
    required = ("estimate_cost.py", "generate_h3.py", "verify_and_concat.py")
    missing = [name for name in required if not (skill / "scripts" / name).is_file()]
    if missing:
        names = ", ".join(missing)
        raise BridgeError(
            f"bundled H3 Max Turbo runtime is incomplete: {names}; reinstall call-to-past"
        )
    return skill


def safe_child_environment(fal_key: str) -> dict[str, str]:
    allowed = {
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "HOME",
        "LOCALAPPDATA",
        "APPDATA",
        "LANG",
        "LC_ALL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
    }
    child = {name: value for name, value in os.environ.items() if name.upper() in allowed}
    child["FAL_KEY"] = fal_key
    child["PYTHONUTF8"] = "1"
    child["PYTHONIOENCODING"] = "utf-8"
    return child


def secret_encodings(secret: str) -> Iterable[bytes]:
    raw = secret.encode("utf-8")
    values = {
        raw,
        urllib.parse.quote(secret, safe="").encode("ascii"),
        base64.b64encode(raw),
    }
    return sorted((value for value in values if value), key=len, reverse=True)


def scrub_secret_files(root: Path, secret: str) -> int:
    """Redact a known key from dependency-created text logs before reporting."""

    if not root.exists():
        return 0
    variants = tuple(secret_encodings(secret))
    replacements = 0
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".json", ".txt", ".log"}:
            continue
        if path.stat().st_size > 5 * 1024 * 1024:
            continue
        data = path.read_bytes()
        redacted = data
        for variant in variants:
            count = redacted.count(variant)
            if count:
                replacements += count
                redacted = redacted.replace(variant, b"[REDACTED]")
        if redacted != data:
            temp = path.with_name(f".{path.name}.redacted-{uuid.uuid4().hex}")
            write_bytes_new(temp, redacted)
            os.replace(temp, path)
    return replacements


def run_dependency(
    command: list[str], *, cwd: Path, fal_key: str, scrub_root: Path
) -> subprocess.CompletedProcess[bytes]:
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            env=safe_child_environment(fal_key),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except Exception as exc:
        scrub_secret_files(scrub_root, fal_key)
        raise BridgeError("failed to start the bundled H3 Max Turbo runtime") from exc
    scrub_secret_files(scrub_root, fal_key)
    return completed


def output_fingerprint(completed: subprocess.CompletedProcess[bytes]) -> dict[str, Any]:
    return {
        "returncode": completed.returncode,
        "stdout_bytes": len(completed.stdout),
        "stderr_bytes": len(completed.stderr),
        "raw_output_saved": False,
    }


def load_approval(run_dir: Path, manifest_hash: str) -> dict[str, Any]:
    approval = load_json_object(run_dir / "approval.json", "approval record")
    if approval.get("schema") != APPROVAL_SCHEMA:
        raise BridgeError("approval record schema is invalid")
    if approval.get("manifest_sha256") != manifest_hash:
        raise BridgeError("approval record is not bound to the current manifest")
    parse_timestamp(approval.get("approved_at"), "approved_at")
    evidence = approval.get("approval_evidence_verbatim")
    if not isinstance(evidence, str) or not evidence.strip():
        raise BridgeError("approval evidence is missing")
    return approval


def submit(args: argparse.Namespace) -> int:
    run_dir = args.run_dir.resolve()
    manifest_path, manifest = load_manifest(run_dir, fresh_price=True)
    manifest_hash = sha256_file(manifest_path)
    approval = load_approval(run_dir, manifest_hash)
    h3_skill = resolve_h3_skill()
    fal_key, credential_source = credentials(args)
    attempt_path = run_dir / "submission-attempt.json"
    if attempt_path.exists():
        raise BridgeError("submission attempt already exists; replay is blocked")
    output_dir = run_dir / "h3"
    if output_dir.exists():
        raise BridgeError("H3 output directory already exists before the first submit")

    attempt = {
        "schema": ATTEMPT_SCHEMA,
        "manifest_sha256": manifest_hash,
        "approval_sha256": sha256_file(run_dir / "approval.json"),
        "attempted_at": iso_utc(utc_now()),
        "endpoint": ENDPOINT,
        "request_slot": 1,
        "credential_source": credential_source,
        "state": "attempt-locked-before-any-upload",
        "action": "Never reuse this run or request slot for another submit.",
    }
    try:
        write_json_new(attempt_path, attempt)
    except FileExistsError as exc:
        raise BridgeError("submission attempt already exists; replay is blocked") from exc

    prompt = resolve_snapshot(run_dir, manifest["prompt"]["snapshot"], "prompt")
    start = resolve_snapshot(run_dir, manifest["start_image"]["snapshot"], "start image")
    end = resolve_snapshot(run_dir, manifest["end_image"]["snapshot"], "end image")
    cost = resolve_snapshot(run_dir, manifest["cost"]["snapshot"], "cost plan")
    command = [
        sys.executable,
        str(h3_skill / "scripts" / "generate_h3.py"),
        "submit",
        "--mode",
        MODE,
        "--prompt-file",
        str(prompt),
        "--start-image",
        str(start),
        "--end-image",
        str(end),
        "--duration",
        str(DURATION_SECONDS),
        "--resolution",
        RESOLUTION,
        "--prompt-expansion-mode",
        PROMPT_EXPANSION_MODE,
        "--cost-plan",
        str(cost),
        "--approved-at",
        str(approval["approved_at"]),
        "--approval-batch-id",
        f"call-to-past-{manifest_hash}",
        "--request-slot",
        "1",
        "--approval-scope",
        "new-condition-pilot",
        "--output-dir",
        str(output_dir),
    ]
    seed = manifest["settings"].get("seed")
    if seed is not None:
        command.extend(["--seed", str(seed)])

    try:
        completed = run_dependency(
            command, cwd=run_dir, fal_key=fal_key, scrub_root=output_dir
        )
    except Exception as exc:
        uncertain = {
            "manifest_sha256": manifest_hash,
            "endpoint": ENDPOINT,
            "request_slot": 1,
            "state": "uncertain",
            "failed_at": iso_utc(utc_now()),
            "reason": "bundled-runtime-start-failure-after-attempt-lock",
            "action": "Do not submit again. Inspect the provider before any new approval.",
        }
        write_json_new(run_dir / "submission-uncertain.json", uncertain)
        if isinstance(exc, BridgeError):
            raise
        raise BridgeError("submission outcome is uncertain; do not retry") from exc

    fingerprint = output_fingerprint(completed)
    if completed.returncode != 0:
        uncertain = {
            "manifest_sha256": manifest_hash,
            "endpoint": ENDPOINT,
            "request_slot": 1,
            "state": "uncertain",
            "failed_at": iso_utc(utc_now()),
            "reason": "bundled H3 runtime returned a failure after the attempt lock",
            "captured_output": fingerprint,
            "action": "Do not submit again. Inspect the provider before any new approval.",
        }
        write_json_new(run_dir / "submission-uncertain.json", uncertain)
        raise BridgeError("submission outcome is uncertain; do not retry this run")

    request_path = output_dir / "request-id.json"
    try:
        request = load_json_object(request_path, "saved H3 request ID")
        request_valid = request.get("endpoint") == ENDPOINT and valid_request_id(
            request.get("request_id")
        )
    except BridgeError:
        request = {}
        request_valid = False
    if not request_valid:
        uncertain = {
            "manifest_sha256": manifest_hash,
            "endpoint": ENDPOINT,
            "request_slot": 1,
            "state": "uncertain",
            "failed_at": iso_utc(utc_now()),
            "reason": "dependency succeeded without a valid saved request ID",
            "captured_output": fingerprint,
            "action": "Do not submit again. Inspect the provider before any new approval.",
        }
        write_json_new(run_dir / "submission-uncertain.json", uncertain)
        raise BridgeError("submission outcome is uncertain; saved request ID is invalid")
    success = {
        "manifest_sha256": manifest_hash,
        "endpoint": ENDPOINT,
        "request_id": request["request_id"],
        "submitted_at": request.get("submitted_at"),
        "captured_output": fingerprint,
    }
    write_json_new(run_dir / "submission-success.json", success)
    print(json.dumps(success, ensure_ascii=False, indent=2))
    return 0


def valid_request_id(value: Any) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9_.:-]{3,256}", value))


def saved_request(run_dir: Path) -> str:
    record = load_json_object(run_dir / "h3" / "request-id.json", "saved H3 request ID")
    if record.get("endpoint") != ENDPOINT or not valid_request_id(record.get("request_id")):
        raise BridgeError("saved H3 request ID is invalid")
    return record["request_id"]


def recovery_contract(run_dir: Path) -> tuple[str, dict[str, Any], str]:
    """Revalidate the immutable approved inputs used by a result recovery."""

    manifest_path, manifest = load_manifest(run_dir, fresh_price=False)
    manifest_hash = sha256_file(manifest_path)
    load_approval(run_dir, manifest_hash)
    approval_hash = sha256_file(run_dir / "approval.json")
    attempt = load_json_object(run_dir / "submission-attempt.json", "submission attempt")
    if (
        attempt.get("schema") != ATTEMPT_SCHEMA
        or attempt.get("endpoint") != ENDPOINT
        or attempt.get("manifest_sha256") != manifest_hash
        or attempt.get("approval_sha256") != approval_hash
    ):
        raise BridgeError("current approval record does not match the locked submission attempt")
    request_id = saved_request(run_dir)
    submission = load_json_object(run_dir / "submission-success.json", "successful submission")
    if (
        submission.get("endpoint") != ENDPOINT
        or submission.get("manifest_sha256") != manifest_hash
        or submission.get("request_id") != request_id
    ):
        raise BridgeError("saved request ID does not match the successful approved submission")
    return manifest_hash, manifest, request_id


def _require_exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise BridgeError(f"{label} fields are invalid")


def validate_result_receipt(run_dir: Path, receipt_path: Path) -> dict[str, Any]:
    """Validate a retained result receipt against its run and downloaded video."""

    run_dir = assert_no_reparse_chain(run_dir, "H3 run directory")
    receipt_path = assert_no_reparse_chain(receipt_path, "result receipt path")
    retrievals = run_dir / "h3" / "retrievals"
    if (
        receipt_path.name != "receipt.json"
        or receipt_path.parent.parent != retrievals
        or not receipt_path.is_file()
    ):
        raise BridgeError("result receipt must be inside one retrieval directory")

    receipt = load_json_object(receipt_path, "result receipt")
    _require_exact_keys(
        receipt,
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
        "result receipt",
    )
    if type(receipt.get("version")) is not int or receipt["version"] != RECEIPT_VERSION:
        raise BridgeError("result receipt version is invalid")
    if receipt.get("endpoint") != ENDPOINT:
        raise BridgeError("result receipt endpoint is invalid")
    parse_timestamp(receipt.get("completed_at"), "result receipt completed_at")

    manifest_hash, manifest, request_id = recovery_contract(run_dir)
    if receipt.get("request_id") != request_id:
        raise BridgeError("result receipt request ID does not match the saved request ID")
    if receipt.get("manifest_sha256") != manifest_hash:
        raise BridgeError("result receipt manifest hash does not match the approved run")
    if receipt.get("start_image_sha256") != manifest["start_image"]["sha256"]:
        raise BridgeError("result receipt start image hash does not match the approved run")
    if receipt.get("end_image_sha256") != manifest["end_image"]["sha256"]:
        raise BridgeError("result receipt end image hash does not match the approved run")

    video = receipt.get("video")
    if not isinstance(video, dict):
        raise BridgeError("result receipt video is invalid")
    _require_exact_keys(video, {"file", "sha256", "bytes"}, "result receipt video")
    if video.get("file") != "ending.mp4":
        raise BridgeError("result receipt video file is invalid")
    recorded_size = video.get("bytes")
    if isinstance(recorded_size, bool) or not isinstance(recorded_size, int) or recorded_size <= 0:
        raise BridgeError("result receipt video byte count is invalid")
    recorded_hash = video.get("sha256")
    if not isinstance(recorded_hash, str) or not re.fullmatch(r"[0-9A-F]{64}", recorded_hash):
        raise BridgeError("result receipt video hash is invalid")
    video_path = assert_no_reparse_chain(
        receipt_path.parent / "ending.mp4", "result receipt video path"
    )
    if not video_path.is_file():
        raise BridgeError("result receipt video is missing")
    if video_path.resolve().parent != receipt_path.parent.resolve():
        raise BridgeError("result receipt video resolves outside its retrieval directory")
    if video_path.stat().st_size != recorded_size or sha256_file(video_path) != recorded_hash:
        raise BridgeError("result receipt video size or hash changed")
    return receipt


def provider_status_summary(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {"state": "UNKNOWN", "reason": "no new status record was saved"}
    try:
        data = load_json_object(path, "provider status")
    except BridgeError:
        return {"state": "UNKNOWN", "reason": "saved status record is invalid"}
    status_value = data.get("status")
    if isinstance(status_value, str) and status_value.upper() in {
        "QUEUED",
        "IN_PROGRESS",
        "COMPLETED",
        "FAILED",
    }:
        state = status_value.upper()
    elif data.get("error") is not None or data.get("error_type") is not None:
        state = "FAILED"
    elif any(field in data for field in ("metrics", "error", "error_type")):
        state = "COMPLETED"
    elif "position" in data:
        state = "QUEUED"
    elif "logs" in data:
        state = "IN_PROGRESS"
    else:
        state = "UNKNOWN"
    summary: dict[str, Any] = {"state": state, "record": str(path)}
    position = data.get("position")
    if isinstance(position, int) and not isinstance(position, bool):
        summary["queue_position"] = position
    logs = data.get("logs")
    if isinstance(logs, list):
        summary["log_count"] = len(logs)
    metrics = data.get("metrics")
    if isinstance(metrics, dict):
        summary["metric_count"] = len(metrics)
    summary["has_error"] = data.get("error") is not None
    error_type = data.get("error_type")
    if isinstance(error_type, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", error_type):
        summary["error_type"] = error_type
    return summary


def recovery(args: argparse.Namespace) -> int:
    run_dir = Path(os.path.abspath(os.fspath(args.run_dir)))
    assert_no_reparse_chain(run_dir, "H3 run directory")
    manifest_hash: str | None = None
    manifest: dict[str, Any] | None = None
    if args.command == "result":
        manifest_hash, manifest, request_id = recovery_contract(run_dir)
    else:
        request_id = saved_request(run_dir)
    h3_skill = resolve_h3_skill()
    fal_key, _ = credentials(args)
    output_dir = run_dir / "h3"
    previous_status_files = set(output_dir.glob("status-*.json"))
    invocation_output_dir = output_dir
    video_output: Path | None = None
    if args.command == "result":
        retrieval_id = utc_now().strftime("%Y%m%dT%H%M%S%fZ") + "-" + uuid.uuid4().hex[:8]
        invocation_output_dir = output_dir / "retrievals" / retrieval_id
        invocation_output_dir.mkdir(parents=True, exist_ok=False)
        video_output = invocation_output_dir / "ending.mp4"
        assert_no_reparse_chain(invocation_output_dir, "result retrieval directory")
        assert_no_reparse_chain(video_output, "result video path")
    command = [
        sys.executable,
        str(h3_skill / "scripts" / "generate_h3.py"),
        args.command,
        "--endpoint",
        ENDPOINT,
        "--request-id",
        request_id,
        "--output-dir",
        str(invocation_output_dir),
    ]
    if args.command == "result":
        assert video_output is not None
        command.extend(["--video-output", str(video_output)])
    completed = run_dependency(
        command, cwd=run_dir, fal_key=fal_key, scrub_root=invocation_output_dir
    )
    fingerprint = output_fingerprint(completed)
    if completed.returncode != 0:
        failure = {
            "command": args.command,
            "endpoint": ENDPOINT,
            "request_id": request_id,
            "failed_at": iso_utc(utc_now()),
            "captured_output": fingerprint,
            "action": "Retry only this saved-ID status/result operation; do not submit again.",
        }
        name = f"{args.command}-failure-{utc_now().strftime('%Y%m%dT%H%M%S%fZ')}.json"
        write_json_new(output_dir / name, failure)
        raise BridgeError(f"{args.command} failed for the saved request ID")
    receipt_path: Path | None = None
    if video_output is not None:
        assert_no_reparse_chain(invocation_output_dir, "result retrieval directory")
        assert_no_reparse_chain(video_output, "result video path")
        if not video_output.is_file():
            raise BridgeError("result completed without the expected ending video")
        if video_output.resolve().parent != invocation_output_dir.resolve():
            raise BridgeError("result video resolves outside its retrieval directory")
        video_bytes = video_output.stat().st_size
        if video_bytes <= 0:
            raise BridgeError("result completed with an empty ending video")
        current_manifest_hash, current_manifest, current_request_id = recovery_contract(run_dir)
        if (
            current_manifest_hash != manifest_hash
            or current_manifest != manifest
            or current_request_id != request_id
        ):
            raise BridgeError("approved H3 run changed while the result was being recovered")
        assert manifest_hash is not None and manifest is not None
        receipt = {
            "version": RECEIPT_VERSION,
            "endpoint": ENDPOINT,
            "request_id": request_id,
            "manifest_sha256": manifest_hash,
            "start_image_sha256": manifest["start_image"]["sha256"],
            "end_image_sha256": manifest["end_image"]["sha256"],
            "video": {
                "file": "ending.mp4",
                "sha256": sha256_file(video_output),
                "bytes": video_bytes,
            },
            "completed_at": iso_utc(utc_now()),
        }
        receipt_path = invocation_output_dir / "receipt.json"
        write_json_new(receipt_path, receipt)
        validate_result_receipt(run_dir, receipt_path)
    provider_status = None
    if args.command == "status":
        new_status_files = sorted(
            set(output_dir.glob("status-*.json")) - previous_status_files,
            key=lambda path: path.name,
        )
        provider_status = provider_status_summary(
            new_status_files[-1] if new_status_files else None
        )
    report = {
        "command": args.command,
        "endpoint": ENDPOINT,
        "request_id": request_id,
        "completed_at": iso_utc(utc_now()),
        "video_output": str(video_output) if video_output else None,
        "receipt_file": str(receipt_path) if receipt_path else None,
        "provider_status": provider_status,
        "captured_output": fingerprint,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def add_runtime_arguments(parser: argparse.ArgumentParser) -> None:

    parser.add_argument(
        "--credentials-file",
        type=Path,
        help="Fallback only when FAL_KEY is unset; reads the fal.ai section only.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--run-dir", type=Path, required=True)
    prepare_parser.add_argument("--prompt-file", type=Path, required=True)
    prepare_parser.add_argument("--start-image", type=Path, required=True)
    prepare_parser.add_argument("--end-image", type=Path, required=True)
    prepare_parser.add_argument("--cost-plan", type=Path, required=True)
    prepare_parser.add_argument("--seed", type=int)
    prepare_parser.set_defaults(func=prepare)

    show_parser = subparsers.add_parser("show")
    show_parser.add_argument("--run-dir", type=Path, required=True)
    show_parser.set_defaults(func=show)

    approve_parser = subparsers.add_parser("approve")
    approve_parser.add_argument("--run-dir", type=Path, required=True)
    approve_parser.add_argument("--manifest-sha256", required=True)
    evidence = approve_parser.add_mutually_exclusive_group(required=True)
    evidence.add_argument("--approval-text")
    evidence.add_argument("--approval-evidence-file", type=Path)
    approve_parser.set_defaults(func=approve)

    submit_parser = subparsers.add_parser("submit")
    submit_parser.add_argument("--run-dir", type=Path, required=True)
    add_runtime_arguments(submit_parser)
    submit_parser.set_defaults(func=submit)

    for command in ("status", "result"):
        recovery_parser = subparsers.add_parser(command)
        recovery_parser.add_argument("--run-dir", type=Path, required=True)
        add_runtime_arguments(recovery_parser)
        recovery_parser.set_defaults(func=recovery)
    return parser


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    args = build_parser().parse_args()
    try:
        return args.func(args)
    except FileExistsError as exc:
        print(f"ERROR: destination already exists: {exc.filename or exc}", file=sys.stderr)
        return 2
    except BridgeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}; operation stopped", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
