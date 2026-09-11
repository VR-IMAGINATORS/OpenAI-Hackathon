#!/usr/bin/env python3
"""Probe, volume-check, concatenate, and QA H3 clips cross-platform."""

from __future__ import annotations

import argparse
import sys
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any


MEAN_VOLUME = re.compile(r"mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB", re.I)
MAX_VOLUME = re.compile(r"max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB", re.I)


def run(command: list[str], *, capture: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def probe(path: Path, ffprobe: str) -> dict[str, Any]:
    completed = run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(path),
        ]
    )
    return json.loads(completed.stdout)


def first_stream(data: dict[str, Any], codec_type: str) -> dict[str, Any] | None:
    return next(
        (stream for stream in data.get("streams", []) if stream.get("codec_type") == codec_type),
        None,
    )


def video_signature(data: dict[str, Any]) -> dict[str, Any] | None:
    stream = first_stream(data, "video")
    if not stream:
        return None
    keys = ("codec_name", "width", "height", "pix_fmt", "avg_frame_rate", "r_frame_rate")
    return {key: stream.get(key) for key in keys}


def audio_signature(data: dict[str, Any]) -> dict[str, Any] | None:
    stream = first_stream(data, "audio")
    if not stream:
        return None
    keys = ("codec_name", "sample_rate", "channels", "channel_layout")
    return {key: stream.get(key) for key in keys}


def numeric_duration(value: Any) -> float | None:
    if value in (None, "N/A"):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def durations(data: dict[str, Any]) -> dict[str, float | None]:
    video = first_stream(data, "video") or {}
    audio = first_stream(data, "audio") or {}
    format_duration = numeric_duration(data.get("format", {}).get("duration"))
    return {
        "format": format_duration,
        "video": numeric_duration(video.get("duration")) or format_duration,
        "audio": numeric_duration(audio.get("duration")) if audio else None,
    }


def parse_volume(stderr: str) -> dict[str, float | None]:
    def value(pattern: re.Pattern[str]) -> float | None:
        match = pattern.search(stderr)
        if not match or match.group(1).lower() == "-inf":
            return None
        return float(match.group(1))

    return {"mean_volume_db": value(MEAN_VOLUME), "max_volume_db": value(MAX_VOLUME)}


def volume_detect(path: Path, ffmpeg: str) -> dict[str, float | None]:
    completed = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-i",
            str(path),
            "-map",
            "0:a:0?",
            "-af",
            "volumedetect",
            "-f",
            "null",
            os.devnull,
        ],
        check=False,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return parse_volume(completed.stderr)


def write_text_new(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def write_json_new(path: Path, data: Any) -> None:
    write_text_new(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def ffconcat_line(path: Path) -> str:
    text = path.resolve().as_posix()
    if "'" in text:
        raise ValueError(f"single quotes in clip paths are unsupported: {path}")
    return f"file '{text}'"


def assert_matching(items: list[dict[str, Any]], kind: str) -> None:
    signatures = [item[f"{kind}_signature"] for item in items]
    baseline = signatures[0]
    for index, signature in enumerate(signatures[1:], start=2):
        if signature != baseline:
            raise ValueError(
                f"{kind} stream mismatch at clip {index}; use --mode reencode or normalize first"
            )


def extract_boundaries(
    output: Path,
    clip_durations: list[float],
    qa_dir: Path,
    ffmpeg: str,
    offset: float,
) -> list[dict[str, Any]]:
    qa_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    elapsed = 0.0
    for boundary_index, clip_duration in enumerate(clip_durations[:-1], start=1):
        elapsed += clip_duration
        record: dict[str, Any] = {"boundary": boundary_index, "seconds": elapsed}
        for side, timestamp in (("before", max(0.0, elapsed - offset)), ("after", elapsed + offset)):
            frame = qa_dir / f"boundary-{boundary_index:02d}-{side}.png"
            if frame.exists():
                raise FileExistsError(f"QA frame already exists: {frame}")
            run(
                [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-ss",
                    f"{timestamp:.3f}",
                    "-i",
                    str(output),
                    "-frames:v",
                    "1",
                    "-n",
                    str(frame),
                ]
            )
            record[side] = str(frame.resolve())
        records.append(record)
    return records


def extract_uniform_frames(
    output: Path,
    duration: float,
    qa_dir: Path,
    ffmpeg: str,
    count: int,
) -> list[dict[str, Any]]:
    if count < 1:
        raise ValueError("sample count must be at least 1")
    qa_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for index in range(count):
        timestamp = duration * (index + 0.5) / count
        frame = qa_dir / f"sample-{index + 1:02d}.png"
        if frame.exists():
            raise FileExistsError(f"QA frame already exists: {frame}")
        run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                f"{timestamp:.3f}",
                "-i",
                str(output),
                "-frames:v",
                "1",
                "-n",
                str(frame),
            ]
        )
        records.append(
            {"sample": index + 1, "seconds": timestamp, "frame": str(frame.resolve())}
        )
    return records

def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clip", action="append", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--qa-dir", type=Path)
    parser.add_argument("--mode", choices=("copy", "reencode"), default="copy")
    parser.add_argument("--expected-duration", type=float)
    parser.add_argument("--duration-tolerance", type=float, default=0.25)
    parser.add_argument("--av-tolerance", type=float, default=0.10)
    parser.add_argument("--boundary-offset", type=float, default=0.05)
    parser.add_argument("--sample-count", type=int, default=12)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    args = parser.parse_args()

    clips = [path.resolve() for path in args.clip]
    for clip in clips:
        if not clip.is_file():
            raise SystemExit(f"clip not found: {clip}")
    output = args.output.resolve()
    report_path = args.report.resolve()
    if output.exists() or report_path.exists():
        raise SystemExit("output or report already exists; choose new paths")

    items: list[dict[str, Any]] = []
    for clip in clips:
        data = probe(clip, args.ffprobe)
        item = {
            "path": str(clip),
            "durations": durations(data),
            "video_signature": video_signature(data),
            "audio_signature": audio_signature(data),
            "volume": volume_detect(clip, args.ffmpeg),
        }
        if item["video_signature"] is None:
            raise SystemExit(f"video stream missing: {clip}")
        items.append(item)

    if args.mode == "copy":
        assert_matching(items, "video")
        assert_matching(items, "audio")

    concat_list = report_path.parent / f"{report_path.stem}-inputs.ffconcat"
    if concat_list.exists():
        raise SystemExit(f"concat manifest already exists: {concat_list}")
    write_text_new(concat_list, "ffconcat version 1.0\n" + "\n".join(ffconcat_line(p) for p in clips) + "\n")

    output.parent.mkdir(parents=True, exist_ok=True)
    command = [args.ffmpeg, "-hide_banner", "-loglevel", "error", "-n", "-safe", "0", "-f", "concat", "-i", str(concat_list)]
    if args.mode == "copy":
        command += ["-c", "copy"]
    else:
        command += ["-c:v", "libx264", "-crf", "20", "-preset", "medium", "-c:a", "aac", "-b:a", "192k"]
    command.append(str(output))
    run(command)

    result_probe = probe(output, args.ffprobe)
    result_durations = durations(result_probe)
    video_duration = result_durations["video"]
    audio_duration = result_durations["audio"]
    av_delta = (
        abs(video_duration - audio_duration)
        if video_duration is not None and audio_duration is not None
        else None
    )
    expected_delta = (
        abs(result_durations["format"] - args.expected_duration)
        if result_durations["format"] is not None and args.expected_duration is not None
        else None
    )
    mean_values = [
        item["volume"]["mean_volume_db"]
        for item in items
        if item["volume"]["mean_volume_db"] is not None
    ]
    mean_volume_delta = max(mean_values) - min(mean_values) if mean_values else None
    clip_durations = [
        item["durations"]["format"]
        for item in items
        if item["durations"]["format"] is not None
    ]
    boundaries: list[dict[str, Any]] = []
    uniform_frames: list[dict[str, Any]] = []
    if args.qa_dir:
        if len(clip_durations) != len(items):
            raise SystemExit("cannot extract boundaries because a clip duration is unavailable")
        boundaries = extract_boundaries(
            output,
            clip_durations,
            args.qa_dir.resolve(),
            args.ffmpeg,
            args.boundary_offset,
        )
        output_duration = result_durations["format"]
        if output_duration is None:
            raise SystemExit("cannot extract uniform QA frames because output duration is unavailable")
        uniform_frames = extract_uniform_frames(
            output,
            output_duration,
            args.qa_dir.resolve(),
            args.ffmpeg,
            args.sample_count,
        )

    checks = {
        "av_duration_delta_seconds": av_delta,
        "av_duration_within_tolerance": av_delta is None or av_delta <= args.av_tolerance,
        "expected_duration_delta_seconds": expected_delta,
        "expected_duration_within_tolerance": expected_delta is None
        or expected_delta <= args.duration_tolerance,
        "mean_volume_range_db": mean_volume_delta,
        "manual_audio_review_required": True,
        "manual_full-duration_label_review_required": True,
        "manual_boundary_review_required": bool(boundaries),
        "manual_hands_review_scope": "all visible hand intervals; otherwise inspect uniform_frames",
    }
    report = {
        "clips": items,
        "mode": args.mode,
        "concat_manifest": str(concat_list.resolve()),
        "output": str(output),
        "output_probe": {
            "durations": result_durations,
            "video_signature": video_signature(result_probe),
            "audio_signature": audio_signature(result_probe),
        },
        "checks": checks,
        "boundary_frames": boundaries,
        "uniform_frames": uniform_frames,
    }
    write_json_new(report_path, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not checks["av_duration_within_tolerance"] or not checks["expected_duration_within_tolerance"]:
        print("WARNING: duration validation failed; inspect the report before delivery", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

