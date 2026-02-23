"""Git operations + kicad-cli discovery + SVG export engine.

Extracted from kicad_diff/server.py for use in the plugin server.
"""
from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

PCB_LAYERS = (
    "F.Cu,B.Cu,F.Silkscreen,B.Silkscreen,F.Fab,B.Fab,"
    "F.Courtyard,B.Courtyard,F.Mask,B.Mask,F.Paste,B.Paste,"
    "Edge.Cuts,Dwgs.User,Cmts.User,Margin"
)

KICAD_EXTENSIONS = (".kicad_sch", ".kicad_pcb")


# ---------------------------------------------------------------------------
# kicad-cli discovery
# ---------------------------------------------------------------------------

def find_kicad_cli() -> str:
    """Find kicad-cli executable (cross-platform)."""
    candidates: list[str] = []
    if sys.platform == "darwin":
        candidates.append("/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli")
    elif sys.platform == "win32":
        pf = os.environ.get("PROGRAMFILES", r"C:\Program Files")
        for ver in ("9.0", "8.0", ""):
            p = (
                os.path.join(pf, "KiCad", ver, "bin", "kicad-cli.exe")
                if ver
                else os.path.join(pf, "KiCad", "bin", "kicad-cli.exe")
            )
            candidates.append(p)
    else:  # Linux
        candidates.append("/usr/bin/kicad-cli")
        candidates.append("/usr/local/bin/kicad-cli")

    for path in candidates:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path

    found = shutil.which("kicad-cli")
    if found:
        return found
    raise FileNotFoundError("Cannot find kicad-cli. Please ensure KiCad is installed.")


# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

def find_repo_root(board_dir: str) -> Path:
    """Find the git repository root from board_dir."""
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=True, cwd=board_dir,
    )
    return Path(result.stdout.strip())


def _parse_commit_line(line: str) -> dict | None:
    """Parse a single git log line into a commit dict."""
    if not line:
        return None
    parts = line.split("|", 4)
    if len(parts) < 5:
        return None
    full_hash, short_hash, message, refs, rel_time = parts

    tags = ""
    if refs.strip():
        decorations = []
        for r in refs.split(","):
            r = r.strip()
            if r.startswith("HEAD -> "):
                decorations.append(r[len("HEAD -> "):])
            elif r == "HEAD":
                continue
            elif r.startswith("tag: "):
                decorations.append(r)
            else:
                decorations.append(r)
        tags = ", ".join(decorations)

    if len(message) > 60:
        message = message[:57] + "..."

    return {
        "ref": full_hash,
        "short_hash": short_hash,
        "message": message,
        "tags": tags,
        "time": rel_time,
    }


def get_versions(repo_root: Path) -> dict:
    """Get git commit history grouped by branch."""
    current_branch = ""
    try:
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True, text=True, check=True, cwd=repo_root,
        )
        current_branch = result.stdout.strip()
    except subprocess.CalledProcessError:
        pass

    try:
        result = subprocess.run(
            ["git", "branch", "--format=%(refname:short)"],
            capture_output=True, text=True, check=True, cwd=repo_root,
        )
        local_branches = [b.strip() for b in result.stdout.strip().splitlines() if b.strip()]
    except subprocess.CalledProcessError:
        local_branches = []

    try:
        result = subprocess.run(
            ["git", "branch", "-r", "--format=%(refname:short)"],
            capture_output=True, text=True, check=True, cwd=repo_root,
        )
        remote_branches = [
            b.strip() for b in result.stdout.strip().splitlines()
            if b.strip() and not b.strip().endswith("/HEAD")
        ]
    except subprocess.CalledProcessError:
        remote_branches = []

    ordered: list[str] = []
    if current_branch:
        ordered.append(current_branch)
    for b in local_branches:
        if b != current_branch:
            ordered.append(b)
    for b in remote_branches:
        ordered.append(b)

    seen_commits: set[str] = set()
    groups: list[dict] = []

    for branch in ordered:
        try:
            result = subprocess.run(
                ["git", "log", branch, "--format=%H|%h|%s|%D|%ar", "--",
                 "*.kicad_sch", "*.kicad_pcb"],
                capture_output=True, text=True, check=True, cwd=repo_root,
            )
        except subprocess.CalledProcessError:
            continue

        commits = []
        for line in result.stdout.strip().splitlines():
            c = _parse_commit_line(line)
            if not c or c["ref"] in seen_commits:
                continue
            seen_commits.add(c["ref"])
            commits.append(c)

        if commits:
            groups.append({
                "branch": branch,
                "is_current": branch == current_branch,
                "commits": commits,
            })

    return {
        "current_branch": current_branch,
        "groups": groups,
    }


# ---------------------------------------------------------------------------
# SVG export
# ---------------------------------------------------------------------------

def export_sch_svg(kicad_cli: str, input_path: str, output_dir: str) -> None:
    """Export a schematic to SVG."""
    os.makedirs(output_dir, exist_ok=True)
    subprocess.run(
        [kicad_cli, "sch", "export", "svg", "-o", str(output_dir), str(input_path)],
        capture_output=True, check=True,
    )


def export_pcb_svg(kicad_cli: str, input_path: str, output_path: str) -> None:
    """Export a PCB to SVG."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    subprocess.run(
        [kicad_cli, "pcb", "export", "svg",
         "-o", str(output_path),
         "--layers", PCB_LAYERS,
         "--mode-single",
         "--page-size-mode", "2",
         "--sketch-pads-on-fab-layers",
         str(input_path)],
        capture_output=True, check=True,
    )


def extract_project_at_ref(ref: str, dest_dir: str, repo_root: Path) -> None:
    """Extract the entire project tree at a git ref using Python tarfile."""
    result = subprocess.run(
        ["git", "archive", ref],
        capture_output=True, check=True, cwd=repo_root,
    )
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as tar:
        tar.extractall(path=str(dest_dir))


def export_for_ref(
    ref: str,
    repo_root: Path,
    output_dir: str,
    kicad_cli: str,
) -> tuple[list[dict], bool]:
    """Export all KiCad files for a given ref. Returns (file_list, cached)."""
    is_working = ref == "working"
    out_dir = Path(output_dir) / ("working" if is_working else ref)

    complete_marker = out_dir / ".complete"
    if not is_working and complete_marker.exists():
        return build_file_list(out_dir, output_dir), True

    # Clean stale working directory to avoid ghost files from deleted sources
    if is_working and out_dir.exists():
        shutil.rmtree(out_dir)

    os.makedirs(out_dir, exist_ok=True)

    tmp_dir: str | None = None
    if not is_working:
        tmp_dir = tempfile.mkdtemp(prefix="kicad-diff-export-")
        extract_project_at_ref(ref, tmp_dir, repo_root)

    try:
        project_root = Path(tmp_dir) if tmp_dir else repo_root

        # Find root schematic stems (those with matching .kicad_pro)
        root_sch_stems: set[str] = set()
        for p in project_root.rglob("*.kicad_pro"):
            root_sch_stems.add(p.stem)

        kicad_files: list[str] = []
        for ext in KICAD_EXTENSIONS:
            for p in project_root.rglob(f"*{ext}"):
                rel = p.relative_to(project_root)
                if ext == ".kicad_sch" and root_sch_stems and p.stem not in root_sch_stems:
                    continue
                kicad_files.append(str(rel))
        kicad_files.sort()

        for filepath in kicad_files:
            name = Path(filepath).stem
            ext = Path(filepath).suffix
            src_path = project_root / filepath

            if not src_path.exists():
                continue

            try:
                if ext == ".kicad_sch":
                    export_sch_svg(kicad_cli, str(src_path), str(out_dir))
                elif ext == ".kicad_pcb":
                    pcb_svg = out_dir / f"{name}-pcb.svg"
                    export_pcb_svg(kicad_cli, str(src_path), str(pcb_svg))
            except subprocess.CalledProcessError as e:
                print(f"[kicad-diff] Warning: export failed for {filepath}: {e}")
                continue

        if not is_working:
            complete_marker.touch()

    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    return build_file_list(out_dir, output_dir), False


def build_file_list(out_dir: Path, output_dir: str) -> list[dict]:
    """Build the file list from exported SVGs."""
    files: list[dict] = []
    out_dir = Path(out_dir)
    if not out_dir.exists():
        return files
    for svg in sorted(out_dir.glob("*.svg")):
        name = svg.stem
        if name.endswith("-pcb"):
            display_name = name[:-4]
            file_type = "pcb"
            key = "pcb-" + display_name
        else:
            display_name = name
            file_type = "sch"
            key = "sch-" + name
        rel_path = svg.relative_to(output_dir)
        files.append({
            "key": key,
            "name": display_name,
            "type": file_type,
            "svg": "output/" + str(rel_path).replace("\\", "/"),
        })
    return files


def resolve_ref(ref: str, repo_root: Path) -> str:
    """Resolve a symbolic ref to its commit hash. Returns ref as-is for 'working'."""
    if ref == "working":
        return ref
    # Validate ref format
    if not re.match(r'^[a-zA-Z0-9._/~^{}\-]+$', ref):
        raise ValueError(f"Invalid ref: {ref}")
    result = subprocess.run(
        ["git", "rev-parse", ref],
        capture_output=True, text=True, check=True, cwd=repo_root,
    )
    return result.stdout.strip()
