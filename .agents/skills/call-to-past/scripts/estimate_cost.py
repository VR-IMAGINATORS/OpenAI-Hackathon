#!/usr/bin/env python3
"""Estimate H3 request cost without calling fal.

The video rate is deliberately required because fal pricing can change.
Reference-image tokens are floored per image, matching the 2026-09-04
observed billing calculation supplied with this skill.
"""

from __future__ import annotations

import argparse
import sys
import json
import struct
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path


def parse_decimal(value: str) -> Decimal:
    try:
        result = Decimal(value)
    except Exception as exc:  # pragma: no cover - argparse reports this
        raise argparse.ArgumentTypeError(f"invalid decimal: {value}") from exc
    if result < 0:
        raise argparse.ArgumentTypeError("value must be non-negative")
    return result


def parse_duration(value: str) -> int:
    try:
        result = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("duration must be an integer") from exc
    if not 5 <= result <= 15:
        raise argparse.ArgumentTypeError("duration must be between 5 and 15")
    return result


def parse_size(value: str) -> tuple[int, int]:
    try:
        width_text, height_text = value.lower().split("x", 1)
        width, height = int(width_text), int(height_text)
    except (ValueError, TypeError) as exc:
        raise argparse.ArgumentTypeError("size must look like 2048x2048") from exc
    if width <= 0 or height <= 0:
        raise argparse.ArgumentTypeError("image dimensions must be positive")
    return width, height


def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        header = handle.read(24)
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    return struct.unpack(">II", header[16:24])


SOF_MARKERS = {
    0xC0,
    0xC1,
    0xC2,
    0xC3,
    0xC5,
    0xC6,
    0xC7,
    0xC9,
    0xCA,
    0xCB,
    0xCD,
    0xCE,
    0xCF,
}


def jpeg_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        if handle.read(2) != b"\xff\xd8":
            raise ValueError("not a JPEG")
        while True:
            byte = handle.read(1)
            if not byte:
                break
            if byte != b"\xff":
                continue
            marker_byte = handle.read(1)
            while marker_byte == b"\xff":
                marker_byte = handle.read(1)
            if not marker_byte:
                break
            marker = marker_byte[0]
            if marker in {0xD8, 0xD9}:
                continue
            length_raw = handle.read(2)
            if len(length_raw) != 2:
                break
            length = struct.unpack(">H", length_raw)[0]
            if length < 2:
                break
            if marker in SOF_MARKERS:
                data = handle.read(5)
                if len(data) != 5:
                    break
                height, width = struct.unpack(">HH", data[1:5])
                return width, height
            handle.seek(length - 2, 1)
    raise ValueError(f"JPEG dimensions not found: {path}")


def image_size(path: Path) -> tuple[int, int]:
    suffix = path.suffix.lower()
    if suffix == ".png":
        return png_size(path)
    if suffix in {".jpg", ".jpeg"}:
        return jpeg_size(path)
    try:
        from PIL import Image
    except ImportError as exc:
        raise ValueError(
            f"{suffix or 'this format'} requires Pillow; pass --reference-size instead"
        ) from exc
    with Image.open(path) as image:
        return image.size


def money(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))

def cost_detail(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("i2v", "r2v"), required=True)
    parser.add_argument("--resolution", choices=("480P", "768P"), required=True)
    parser.add_argument(
        "--duration",
        action="append",
        required=True,
        type=parse_duration,
        help="One integer duration per request; repeat for every request.",
    )
    parser.add_argument(
        "--video-rate",
        required=True,
        type=parse_decimal,
        help="Current USD per generated second, verified on fal immediately before use.",
    )
    parser.add_argument("--reference-image", action="append", default=[], type=Path)
    parser.add_argument(
        "--reference-size",
        action="append",
        default=[],
        type=parse_size,
        help="Reference dimensions such as 2048x2048; repeat for each image.",
    )
    parser.add_argument("--reference-rate", type=parse_decimal, default=Decimal("0.02"))
    parser.add_argument("--reference-allowance", type=int, default=4096)
    parser.add_argument("--usd-jpy", required=True, type=parse_decimal)
    parser.add_argument("--pricing-source", required=True)
    parser.add_argument("--pricing-checked-at", required=True)
    parser.add_argument("--output", type=Path)
    return parser


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    args = build_parser().parse_args()
    if args.reference_allowance < 0:
        raise SystemExit("reference allowance must be non-negative")
    if args.mode == "i2v" and (args.reference_image or args.reference_size):
        raise SystemExit("I2V cost must not include R2V reference images")

    sizes: list[tuple[int, int]] = list(args.reference_size)
    image_details: list[dict[str, object]] = [
        {"source": "provided-size", "width": w, "height": h} for w, h in sizes
    ]
    for raw_path in args.reference_image:
        path = raw_path.resolve()
        if not path.is_file():
            raise SystemExit(f"reference image not found: {path}")
        width, height = image_size(path)
        sizes.append((width, height))
        image_details.append({"source": str(path), "width": width, "height": height})

    tokens_per_image = [(width * height) // 1024 for width, height in sizes]
    for detail, tokens in zip(image_details, tokens_per_image):
        detail["tokens"] = tokens

    reference_tokens = sum(tokens_per_image)
    billable_tokens = max(0, reference_tokens - args.reference_allowance)
    reference_cost_each = (
        Decimal(billable_tokens) / Decimal(1000) * args.reference_rate
        if args.mode == "r2v"
        else Decimal(0)
    )
    request_count = len(args.duration)
    total_seconds = sum(args.duration)
    video_cost = Decimal(total_seconds) * args.video_rate
    reference_cost = reference_cost_each * request_count
    total_usd = video_cost + reference_cost

    report = {
        "mode": args.mode,
        "resolution": args.resolution,
        "durations_seconds": args.duration,
        "request_count": request_count,
        "total_seconds": total_seconds,
        "video_rate_usd_per_second": str(args.video_rate),
        "video_cost_usd": money(video_cost),
        "reference_images": image_details,
        "reference_tokens_per_request": reference_tokens if args.mode == "r2v" else 0,
        "reference_allowance_per_request": args.reference_allowance,
        "billable_reference_tokens_per_request": billable_tokens if args.mode == "r2v" else 0,
        "reference_cost_usd_per_request": cost_detail(reference_cost_each),
        "reference_cost_usd_total": cost_detail(reference_cost),
        "total_cost_usd": money(total_usd),
        "usd_jpy": str(args.usd_jpy),
        "total_cost_jpy": money(total_usd * args.usd_jpy),
        "pricing_source": args.pricing_source,
        "pricing_checked_at": args.pricing_checked_at,
        "notice": "Estimate only. Recheck fal pricing and approval immediately before submission.",
    }
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(encoded)
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

