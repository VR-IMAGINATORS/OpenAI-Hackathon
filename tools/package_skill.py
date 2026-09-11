"""Package only the named skill; verify archive and optional new installation."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def package(source: Path, output: Path, install: Path | None = None) -> dict:
    source = source.resolve(strict=True)
    output = output.resolve()
    if not (source / "SKILL.md").is_file():
        raise ValueError("SKILL.md missing")
    files = []
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise ValueError("symlink not allowed")
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        if path.suffix not in {".md", ".py", ".json", ".yaml", ".yml"}:
            raise ValueError(f"unexpected packaged file type: {path.name}")
        rel = path.relative_to(source)
        if any(part in {"runs", ".git", ".env"} for part in rel.parts) or ".local." in path.name:
            raise ValueError("private runtime content in skill")
        files.append((path, rel))
    if output.exists() or output.with_suffix(".manifest.json").exists():
        raise FileExistsError("Use a new output filename")
    if install is not None and install.exists():
        raise FileExistsError("Installation exists; review differences before updating")
    output.parent.mkdir(parents=True, exist_ok=True)
    records = {rel.as_posix(): sha(path) for path, rel in files}
    with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED) as archive:
        for path, rel in files:
            archive.write(path, f"{source.name}/{rel.as_posix()}")
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise ValueError("archive CRC failed")
        for rel, digest in records.items():
            actual = hashlib.sha256(archive.read(f"{source.name}/{rel}")).hexdigest()
            if actual != digest:
                raise ValueError("archive hash mismatch")
    report = {"skill": source.name, "file_count": len(files), "files": records,
              "archive": str(output), "archive_sha256": sha(output), "archive_verified": True}
    if install is not None:
        install = install.resolve()
        install.mkdir(parents=True, exist_ok=False)
        for path, rel in files:
            dest = install / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)
            if sha(dest) != records[rel.as_posix()]:
                raise ValueError("installation hash mismatch")
        report.update(installation=str(install), installation_verified=True)
    with output.with_suffix(".manifest.json").open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--install", type=Path)
    args = parser.parse_args()
    result = package(args.source, args.output, args.install)
    print(json.dumps({key: value for key, value in result.items() if key != "files"}, ensure_ascii=False, indent=2))
