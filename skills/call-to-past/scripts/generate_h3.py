#!/usr/bin/env python3
"""Submit, inspect, and retrieve fal H3 requests without automatic retries."""

from __future__ import annotations

import argparse
import sys
import hashlib
import importlib.metadata
import json
import os
import urllib.request
from datetime import datetime, timezone

from pathlib import Path
from typing import Any


ENDPOINTS = {
    "i2v": "minimax/h3-max-turbo/image-to-video",
    "r2v": "minimax/h3-max/reference-to-video",
}
ASPECT_RATIOS = ("adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16")
MOJIBAKE_MARKERS = ("縺", "繧", "菴", "蜿", "逡", "�")


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def read_prompt(path: Path) -> str:
    text = path.read_text(encoding="utf-8-sig").strip()
    if not text:
        raise ValueError("prompt file is empty")
    marker_count = sum(text.count(marker) for marker in MOJIBAKE_MARKERS)
    if "�" in text or marker_count >= 2:
        raise ValueError("prompt contains probable mojibake; submission stopped")
    return text


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def to_jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(item) for item in value]
    if hasattr(value, "model_dump"):
        return to_jsonable(value.model_dump())
    if hasattr(value, "__dict__"):
        return to_jsonable(vars(value))
    return str(value)


def write_json_new(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(to_jsonable(data), handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def existing_output_dir(value: str) -> Path:
    path = Path(value).resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def validated_duration(value: str) -> int:
    try:
        duration = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("duration must be an integer") from exc
    if not 5 <= duration <= 15:
        raise argparse.ArgumentTypeError("duration must be between 5 and 15")
    return duration


def load_cost_plan(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    if not resolved.is_file():
        raise ValueError(f"cost plan not found: {resolved}")
    data = json.loads(resolved.read_text(encoding="utf-8-sig"))
    required = {
        "mode",
        "resolution",
        "durations_seconds",
        "request_count",
        "reference_tokens_per_request",
        "total_cost_usd",
        "usd_jpy",
        "total_cost_jpy",
        "pricing_source",
        "pricing_checked_at",
    }
    missing = sorted(required - set(data)) if isinstance(data, dict) else sorted(required)
    if missing:
        raise ValueError(f"cost plan is missing required fields: {', '.join(missing)}")
    return data


def local_asset(path_or_url: str) -> dict[str, str]:
    if path_or_url.startswith(("https://", "http://", "data:")):
        return {"kind": "url", "value": path_or_url}
    path = Path(path_or_url).resolve()
    if not path.is_file():
        raise ValueError(f"asset not found: {path}")
    return {"kind": "file", "value": str(path), "sha256": sha256(path)}


def upload_asset(fal_client: Any, asset: dict[str, str]) -> str:
    if asset["kind"] == "url":
        return asset["value"]
    return fal_client.upload_file(asset["value"])


def fal_version() -> str:
    try:
        return importlib.metadata.version("fal-client")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def require_client() -> Any:
    if not os.environ.get("FAL_KEY"):
        raise RuntimeError("FAL_KEY is not set")
    try:
        import fal_client
    except ImportError as exc:
        raise RuntimeError("fal-client is not installed in this environment") from exc
    return fal_client


def submit(args: argparse.Namespace) -> int:
    prompt_path = args.prompt_file.resolve()
    if not prompt_path.is_file():
        raise ValueError(f"prompt file not found: {prompt_path}")
    prompt = read_prompt(prompt_path)
    endpoint = ENDPOINTS[args.mode]

    start_asset = local_asset(args.start_image) if args.start_image else None
    end_asset = local_asset(args.end_image) if args.end_image else None
    reference_assets = [local_asset(item) for item in args.reference_image]
    if args.mode == "i2v":
        if start_asset is None:
            raise ValueError("I2V requires --start-image")
        if reference_assets or args.aspect_ratio:
            raise ValueError("I2V does not accept R2V reference images or aspect ratio")
    else:
        if start_asset or end_asset:
            raise ValueError("R2V does not accept --start-image or --end-image")
        if not reference_assets:
            raise ValueError("R2V requires at least one --reference-image")
        if len(reference_assets) > 12:
            raise ValueError("reference image count exceeds the official combined limit of 12")

    cost_plan_path = args.cost_plan.resolve()
    cost_plan = load_cost_plan(cost_plan_path)
    if cost_plan["mode"] != args.mode:
        raise ValueError("cost plan mode does not match submit mode")
    if cost_plan["resolution"] != args.resolution:
        raise ValueError("cost plan resolution does not match submit resolution")
    durations = cost_plan["durations_seconds"]
    request_count = cost_plan["request_count"]
    if not isinstance(durations, list) or not isinstance(request_count, int):
        raise ValueError("cost plan durations/request_count are invalid")
    if len(durations) != request_count:
        raise ValueError("cost plan duration count does not match request_count")
    if not 1 <= args.request_slot <= request_count:
        raise ValueError("request slot is outside the approved cost plan")
    if args.duration != durations[args.request_slot - 1]:
        raise ValueError("submit duration does not match the approved request slot")
    if args.approval_scope == "new-condition-pilot" and request_count != 1:
        raise ValueError("new-condition-pilot requires a one-request cost plan")

    output_dir = existing_output_dir(str(args.output_dir))
    plan_path = output_dir / "submission-plan.json"
    approval = {
        "cost_plan_file": str(cost_plan_path),
        "cost_plan_sha256": sha256(cost_plan_path),
        "cost_plan": cost_plan,
        "approved_at": args.approved_at,
        "approval_scope": args.approval_scope,
        "approval_batch_id": args.approval_batch_id,
        "request_slot": args.request_slot,
    }
    local_plan = {
        "endpoint": endpoint,
        "mode": args.mode,
        "prompt_file": str(prompt_path),
        "prompt_sha256": sha256(prompt_path),
        "duration": args.duration,
        "resolution": args.resolution,
        "prompt_expansion_mode": args.prompt_expansion_mode,
        "seed": args.seed,
        "aspect_ratio": args.aspect_ratio,
        "start_image": start_asset,
        "end_image": end_asset,
        "reference_images": reference_assets,
        "approval": approval,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json_new(plan_path, local_plan)

    fal_client = require_client()
    batch_digest = hashlib.sha256(args.approval_batch_id.encode("utf-8")).hexdigest()[:16]
    ledger_dir = Path.cwd().resolve() / ".h3-video-submission-ledger"
    slot_lock = ledger_dir / f"batch-{batch_digest}-slot-{args.request_slot:03d}.json"
    try:
        write_json_new(
            slot_lock,
            {
                "approval_batch_id": args.approval_batch_id,
                "request_slot": args.request_slot,
                "cost_plan_sha256": sha256(cost_plan_path),
                "endpoint": endpoint,
                "output_dir": str(output_dir),
                "locked_at": datetime.now(timezone.utc).isoformat(),
                "action": "Do not reuse this slot. On uncertainty, inspect fal before any new approval.",
            },
        )
    except FileExistsError as exc:
        raise RuntimeError(
            "approved batch/request slot already has a submission-attempt lock; "
            "do not upload assets or submit it again"
        ) from exc
    payload: dict[str, Any] = {
        "prompt": prompt,
        "duration": args.duration,
        "resolution": args.resolution,
        "prompt_expansion_mode": args.prompt_expansion_mode,
        "enable_safety_checker": True,
    }
    if args.seed is not None:
        payload["seed"] = args.seed
    if args.mode == "i2v":
        payload["image_url"] = upload_asset(fal_client, start_asset)
        if end_asset:
            payload["end_image_url"] = upload_asset(fal_client, end_asset)
    else:
        payload["reference_image_urls"] = [
            upload_asset(fal_client, item) for item in reference_assets
        ]
        payload["aspect_ratio"] = args.aspect_ratio or "adaptive"

    request_record = {
        "endpoint": endpoint,
        "arguments": payload,
        "approval": approval,
        "fal_client_version": fal_version(),
        "prepared_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json_new(output_dir / "request.json", request_record)


    try:
        handler = fal_client.submit(endpoint, arguments=payload)
        request_id = handler.request_id
    except Exception as exc:
        write_json_new(
            output_dir / "submission-uncertain.json",
            {
                "endpoint": endpoint,
                "exception_type": type(exc).__name__,
                "message": str(exc),
                "stopped_at": datetime.now(timezone.utc).isoformat(),
                "action": "Do not re-submit until non-acceptance is confirmed in fal.",
            },
        )
        raise RuntimeError(
            "submission result is uncertain; do not re-submit automatically. "
            f"Inspect {output_dir / 'submission-uncertain.json'}"
        ) from exc

    saved = {
        "endpoint": endpoint,
        "request_id": request_id,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
    }
    write_json_new(output_dir / "request-id.json", saved)
    print(json.dumps(saved, ensure_ascii=False, indent=2))
    return 0


def status(args: argparse.Namespace) -> int:
    fal_client = require_client()

    data = fal_client.status(args.endpoint, args.request_id, with_logs=True)
    output = args.output_dir.resolve() / f"status-{utc_stamp()}.json"
    write_json_new(output, data)
    print(json.dumps(to_jsonable(data), ensure_ascii=False, indent=2))
    return 0


def result(args: argparse.Namespace) -> int:
    fal_client = require_client()

    data = fal_client.result(args.endpoint, args.request_id)
    output_dir = existing_output_dir(str(args.output_dir))
    result_path = output_dir / f"result-{utc_stamp()}.json"
    write_json_new(result_path, data)
    jsonable = to_jsonable(data)
    video = jsonable.get("video") if isinstance(jsonable, dict) else None
    video_url = video.get("url") if isinstance(video, dict) else None
    if args.video_output:
        if not video_url:
            raise RuntimeError("result does not contain video.url")
        destination = args.video_output.resolve()
        if destination.exists() or destination.with_suffix(destination.suffix + ".part").exists():
            raise FileExistsError(f"output already exists: {destination}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        partial = destination.with_suffix(destination.suffix + ".part")
        urllib.request.urlretrieve(video_url, partial)
        os.replace(partial, destination)
        print(f"downloaded: {destination}")
    print(json.dumps(jsonable, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    submit_parser = subparsers.add_parser("submit", help="Upload inputs and submit exactly one request.")
    submit_parser.add_argument("--mode", choices=tuple(ENDPOINTS), required=True)
    submit_parser.add_argument("--prompt-file", type=Path, required=True)
    submit_parser.add_argument("--duration", type=validated_duration, required=True)
    submit_parser.add_argument("--resolution", choices=("480P", "768P"), required=True)
    submit_parser.add_argument("--prompt-expansion-mode", choices=("balanced", "quality"), default="balanced")
    submit_parser.add_argument("--seed", type=int)
    submit_parser.add_argument("--start-image")
    submit_parser.add_argument("--end-image")
    submit_parser.add_argument("--reference-image", action="append", default=[])
    submit_parser.add_argument("--aspect-ratio", choices=ASPECT_RATIOS)
    submit_parser.add_argument(
        "--cost-plan",
        type=Path,
        required=True,
        help="Approved JSON created by estimate_cost.py --output.",
    )
    submit_parser.add_argument("--approved-at", required=True)
    submit_parser.add_argument("--approval-batch-id", required=True)
    submit_parser.add_argument("--request-slot", type=int, required=True)
    submit_parser.add_argument(
        "--approval-scope",
        choices=("new-condition-pilot", "approved-remainder", "known-condition"),
        required=True,
    )
    submit_parser.add_argument("--output-dir", type=Path, required=True)
    submit_parser.set_defaults(func=submit)

    status_parser = subparsers.add_parser("status", help="Inspect one saved request ID.")
    status_parser.add_argument("--endpoint", choices=tuple(ENDPOINTS.values()), required=True)
    status_parser.add_argument("--request-id", required=True)
    status_parser.add_argument("--output-dir", type=Path, required=True)
    status_parser.set_defaults(func=status)

    result_parser = subparsers.add_parser("result", help="Fetch one saved request result.")
    result_parser.add_argument("--endpoint", choices=tuple(ENDPOINTS.values()), required=True)
    result_parser.add_argument("--request-id", required=True)
    result_parser.add_argument("--output-dir", type=Path, required=True)
    result_parser.add_argument("--video-output", type=Path)
    result_parser.set_defaults(func=result)
    return parser


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    args = build_parser().parse_args()
    try:
        return args.func(args)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

