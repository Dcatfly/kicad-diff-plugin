#!/usr/bin/env python3
"""Update PCM repository metadata after building a new plugin archive.

Usage (typically called by CI, but works locally too):

    python3 scripts/update_pcm_metadata.py \\
        --version 0.3.0 \\
        --zip-path dist/org.dcatfly.kicad-diff-plugin-0.3.0.zip \\
        --download-url https://github.com/Dcatfly/kicad-diff-plugin/releases/download/v0.3.0/org.dcatfly.kicad-diff-plugin-0.3.0.zip

    # CI usage (pcm-repo orphan branch checked out at cwd):
    python3 /tmp/update_pcm_metadata.py \\
        --version 0.3.0 \\
        --zip-path /tmp/archive.zip \\
        --download-url <url> \\
        --pcm-dir .

The script will:
  1. Read identifier / runtime / kicad_version from the ZIP's metadata.json.
  2. Compute SHA-256 / file-size of the ZIP archive.
  3. Prepend a new version entry to packages.json.
  4. Recompute SHA-256 of packages.json.
  5. Update repository.json with the new hash and timestamp.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZipFile

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_PCM_DIR = ROOT_DIR / "release" / "pcm"


def sha256_of_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_of_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def compute_install_size(zip_path: Path) -> int:
    """Sum of uncompressed sizes of all entries in the ZIP."""
    with ZipFile(zip_path, "r") as zf:
        return sum(info.file_size for info in zf.infolist())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Update PCM repository metadata for a new release",
    )
    parser.add_argument(
        "--version",
        required=True,
        help="semantic version string, e.g. 0.3.0",
    )
    parser.add_argument(
        "--zip-path",
        required=True,
        type=Path,
        help="path to the built plugin ZIP archive",
    )
    parser.add_argument(
        "--download-url",
        required=True,
        help="public URL where KiCad PCM can download the ZIP",
    )
    parser.add_argument(
        "--status",
        default="stable",
        choices=["stable", "testing", "development", "deprecated"],
        help="version status (default: stable)",
    )
    parser.add_argument(
        "--pcm-dir",
        type=Path,
        default=DEFAULT_PCM_DIR,
        help="directory containing packages.json and repository.json",
    )
    return parser.parse_args()


def update_packages(args: argparse.Namespace) -> tuple[bytes, Path]:
    """Add the new version entry to packages.json and return (raw bytes, path)."""
    zip_path: Path = args.zip_path
    if not zip_path.is_file():
        raise FileNotFoundError(f"ZIP archive not found: {zip_path}")

    # ---- Read metadata from the zip's metadata.json so that packages.json
    #      always matches the actual archive content.
    with ZipFile(zip_path, "r") as zf:
        zip_meta = json.loads(zf.read("metadata.json"))

    identifier: str = zip_meta["identifier"]
    ver_info: dict = zip_meta["versions"][0]

    # Top-level fields that should be synced from the ZIP's metadata.json
    # to the packages.json entry.  "identifier" is the lookup key and
    # "versions" are managed separately, so both are excluded.
    _SYNC_FIELDS = (
        "name",
        "description",
        "description_full",
        "type",
        "author",
        "license",
        "resources",
    )

    new_version_entry = {
        "version": args.version,
        "status": args.status,
        "kicad_version": ver_info["kicad_version"],
        "runtime": ver_info["runtime"],
        "download_url": args.download_url,
        "download_sha256": sha256_of_file(zip_path),
        "download_size": zip_path.stat().st_size,
        "install_size": compute_install_size(zip_path),
    }

    packages_path = args.pcm_dir / "packages.json"
    packages = json.loads(packages_path.read_text(encoding="utf-8"))

    # Find our package entry
    pkg = None
    for p in packages.get("packages", []):
        if p.get("identifier") == identifier:
            pkg = p
            break

    if pkg is None:
        raise ValueError(
            f"Package {identifier!r} not found in {packages_path}"
        )

    # Sync top-level package metadata so the repository listing stays
    # consistent with the latest metadata.json shipped in the ZIP.
    for field in _SYNC_FIELDS:
        if field in zip_meta:
            pkg[field] = zip_meta[field]

    # Remove any existing entry with the same version (idempotent re-runs)
    pkg["versions"] = [
        v for v in pkg.get("versions", []) if v.get("version") != args.version
    ]

    # Prepend (newest first)
    pkg["versions"].insert(0, new_version_entry)

    raw = json.dumps(packages, ensure_ascii=False, indent=2) + "\n"
    encoded = raw.encode("utf-8")
    packages_path.write_bytes(encoded)
    return encoded, packages_path


def update_repository(packages_sha256: str, pcm_dir: Path) -> bool:
    """Update repository.json with new packages.json hash and timestamp.

    Returns True if repository.json was actually modified, False if the
    packages.json hash was unchanged (idempotent re-run of the same version).
    """
    repository_path = pcm_dir / "repository.json"
    repo = json.loads(repository_path.read_text(encoding="utf-8"))

    old_sha256 = repo.get("packages", {}).get("sha256")
    if old_sha256 == packages_sha256:
        return False

    now = int(time.time())
    now_utc = datetime.fromtimestamp(now, tz=timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S"
    )

    repo["packages"]["sha256"] = packages_sha256
    repo["packages"]["update_timestamp"] = now
    repo["packages"]["update_time_utc"] = now_utc

    raw = json.dumps(repo, ensure_ascii=False, indent=2) + "\n"
    repository_path.write_text(raw, encoding="utf-8")
    return True


def main() -> int:
    args = parse_args()

    print(f"Updating PCM metadata for v{args.version} ...")

    packages_bytes, packages_path = update_packages(args)
    packages_hash = sha256_of_bytes(packages_bytes)
    print(f"  {packages_path} SHA-256: {packages_hash}")

    if update_repository(packages_hash, args.pcm_dir):
        print(f"  repository.json updated with timestamp {int(time.time())}")
    else:
        print("  repository.json unchanged (packages.json hash identical)")

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
