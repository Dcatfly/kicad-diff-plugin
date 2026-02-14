#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT_DIR = Path(__file__).resolve().parents[1]
PLUGIN_DIR = ROOT_DIR / "plugin"
FRONTEND_DIR = ROOT_DIR / "frontend"
DIST_DIR = ROOT_DIR / "dist"
METADATA_PATH = PLUGIN_DIR / "metadata.json"
PCM_PLUGIN_DIR = Path("plugins")

EXCLUDED_FILE_NAMES = {
    ".DS_Store",
    ".gitkeep",
    ".server.log",
    "metadata.json",
}
EXCLUDED_DIR_NAMES = {
    "__pycache__",
}
EXCLUDED_SUFFIXES = {
    ".pyc",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the frontend bundle and package the KiCad plugin"
    )
    parser.add_argument(
        "--version",
        default="0.1.0",
        help="version written into metadata.json and output archive name",
    )
    parser.add_argument(
        "--skip-frontend-build",
        action="store_true",
        help="skip `pnpm -C frontend run build`",
    )
    return parser.parse_args()


def run_frontend_build() -> None:
    web_dir = PLUGIN_DIR / "web"
    if web_dir.exists():
        shutil.rmtree(web_dir)
    web_dir.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        ["pnpm", "-C", str(FRONTEND_DIR), "run", "build"],
        check=True,
        cwd=ROOT_DIR,
    )


def load_json(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"JSON root must be object: {path}")
    return payload


def validate_plugin_layout() -> dict:
    required_files = [
        PLUGIN_DIR / "plugin.json",
        METADATA_PATH,
        PLUGIN_DIR / "entry.py",
        PLUGIN_DIR / "server.py",
        PLUGIN_DIR / "requirements.txt",
        PLUGIN_DIR / "web" / "index.html",
    ]

    missing = [path for path in required_files if not path.exists()]
    if missing:
        formatted = "\n".join(f"- {path}" for path in missing)
        raise FileNotFoundError(f"Missing required plugin files:\n{formatted}")

    plugin_json = load_json(PLUGIN_DIR / "plugin.json")
    runtime = plugin_json.get("runtime", {}).get("type")
    if runtime != "python":
        raise ValueError("plugin.json runtime.type must be `python`")

    plugin_identifier = plugin_json.get("identifier")
    if not isinstance(plugin_identifier, str) or not plugin_identifier:
        raise ValueError("plugin.json must contain a non-empty string `identifier`")

    metadata = load_json(METADATA_PATH)
    metadata_identifier = metadata.get("identifier")
    if metadata_identifier != plugin_identifier:
        raise ValueError(
            "metadata.json identifier must match plugin.json identifier "
            f"({metadata_identifier!r} != {plugin_identifier!r})"
        )

    versions = metadata.get("versions")
    if not isinstance(versions, list) or not versions:
        raise ValueError("metadata.json must contain a non-empty `versions` list")

    return metadata


def should_skip(path: Path) -> bool:
    if any(part in EXCLUDED_DIR_NAMES for part in path.parts):
        return True
    if path.name in EXCLUDED_FILE_NAMES:
        return True
    if path.suffix in EXCLUDED_SUFFIXES:
        return True
    return False


def create_zip(metadata: dict, version: str) -> Path:
    metadata_payload = dict(metadata)
    first_release = dict(metadata_payload["versions"][0])
    first_release["version"] = version
    metadata_payload["versions"] = [first_release]

    identifier = str(metadata_payload["identifier"])
    package_plugin_dir = PCM_PLUGIN_DIR / identifier

    DIST_DIR.mkdir(parents=True, exist_ok=True)
    archive_path = DIST_DIR / f"{identifier}-{version}.zip"

    with ZipFile(archive_path, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr(
            "metadata.json",
            f"{json.dumps(metadata_payload, ensure_ascii=False, indent=2)}\n",
        )

        for file_path in sorted(PLUGIN_DIR.rglob("*")):
            if not file_path.is_file() or should_skip(file_path):
                continue

            arcname = package_plugin_dir / file_path.relative_to(PLUGIN_DIR)
            archive.write(file_path, arcname)

    return archive_path


def main() -> int:
    args = parse_args()

    if not args.skip_frontend_build:
        run_frontend_build()

    metadata = validate_plugin_layout()
    archive_path = create_zip(metadata, args.version)
    print(f"Plugin package created: {archive_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
