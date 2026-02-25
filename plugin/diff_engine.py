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

PCB_COMMON_LAYERS = "Edge.Cuts"

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
    cmd = [
        kicad_cli,
        "sch",
        "export",
        "svg",
        "--no-background-color",
        "-o",
        str(output_dir),
        str(input_path),
    ]
    try:
        subprocess.run(cmd, capture_output=True, check=True)
        return
    except subprocess.CalledProcessError as err:
        # Older KiCad versions may not support this flag.
        def _text(v: bytes | str | None) -> str:
            if v is None:
                return ""
            if isinstance(v, bytes):
                return v.decode(errors="ignore")
            return v

        output = f"{_text(err.stdout)}\n{_text(err.stderr)}".lower()
        unsupported_flag = (
            "no-background-color" in output and (
                "unknown option" in output
                or "unrecognized option" in output
                or "invalid option" in output
            )
        )
        if not unsupported_flag:
            raise

    subprocess.run(
        [kicad_cli, "sch", "export", "svg", "-o", str(output_dir), str(input_path)],
        capture_output=True, check=True,
    )


def parse_pcb_layers(pcb_path: str) -> list[str]:
    """Parse a .kicad_pcb file and return list of layer canonical names.

    Reads the (layers ...) section from the board file's S-expression format.
    Returns layer names excluding those in PCB_COMMON_LAYERS.
    """
    with open(pcb_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    # Match the top-level (layers ...) block
    m = re.search(r'\(\s*layers\b(.*?)\n\s*\)', content, re.DOTALL)
    if not m:
        return []

    layers_block = m.group(1)
    # Each layer line: (number "name" type ...) or (number "name" type "alias")
    layer_names: list[str] = []
    for line_match in re.finditer(r'\(\s*\d+\s+"([^"]+)"', layers_block):
        name = line_match.group(1)
        if name not in PCB_COMMON_LAYERS.split(","):
            layer_names.append(name)

    return layer_names


def export_pcb_svg_layers(
    kicad_cli: str, input_path: str, output_dir: str, pcb_name: str,
) -> None:
    """Export PCB layers as individual SVGs using --mode-multi."""
    layers = parse_pcb_layers(input_path)
    if not layers:
        return

    pcb_dir = os.path.join(output_dir, f"pcb-layers-{pcb_name}")
    os.makedirs(pcb_dir, exist_ok=True)

    subprocess.run(
        [kicad_cli, "pcb", "export", "svg",
         "-o", pcb_dir,
         "--layers", ",".join(layers),
         "--common-layers", PCB_COMMON_LAYERS,
         "--mode-multi",
         "--page-size-mode", "0",
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
) -> tuple[dict, bool]:
    """Export all KiCad files for a given ref.

    Returns (result_dict, cached) where result_dict has:
      - "files": list of schematic ExportFile dicts
      - "pcb_layers": dict mapping pcb_name -> list of {layer, svg} dicts
    """
    is_working = ref == "working"
    out_dir = Path(output_dir) / ("working" if is_working else ref)

    complete_marker = out_dir / ".complete"
    if not is_working and complete_marker.exists():
        return build_structured_result(out_dir, output_dir), True

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
                    export_pcb_svg_layers(
                        kicad_cli, str(src_path), str(out_dir), name,
                    )
            except subprocess.CalledProcessError as e:
                print(f"[kicad-diff] Warning: export failed for {filepath}: {e}")
                continue

        if not is_working:
            complete_marker.touch()

    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    return build_structured_result(out_dir, output_dir), False


def build_structured_result(out_dir: Path, output_dir: str) -> dict:
    """Build structured result with schematic files and PCB layer groups."""
    out_dir = Path(out_dir)
    files: list[dict] = []
    pcb_layers: dict[str, list[dict]] = {}

    if not out_dir.exists():
        return {"files": files, "pcb_layers": pcb_layers}

    # Schematic SVGs (top-level *.svg files)
    for svg in sorted(out_dir.glob("*.svg")):
        name = svg.stem
        rel_path = svg.relative_to(output_dir)
        files.append({
            "key": "sch-" + name,
            "name": name,
            "type": "sch",
            "svg": "output/" + str(rel_path).replace("\\", "/"),
        })

    # PCB layer directories (pcb-layers-{name}/)
    for layer_dir in sorted(out_dir.iterdir()):
        if not layer_dir.is_dir() or not layer_dir.name.startswith("pcb-layers-"):
            continue
        pcb_name = layer_dir.name[len("pcb-layers-"):]
        layer_files: list[dict] = []
        for svg in sorted(layer_dir.glob("*.svg")):
            # Filename: {pcb_name}-{Layer_Name}.svg where dots are underscores
            fname = svg.name
            prefix = pcb_name + "-"
            if fname.startswith(prefix):
                layer_part = fname[len(prefix):-4]  # strip prefix and .svg
                layer_name = layer_part.replace("_", ".")
                rel_path = svg.relative_to(output_dir)
                layer_files.append({
                    "layer": layer_name,
                    "svg": "output/" + str(rel_path).replace("\\", "/"),
                })
        if layer_files:
            pcb_layers[pcb_name] = layer_files

    return {"files": files, "pcb_layers": pcb_layers}


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
