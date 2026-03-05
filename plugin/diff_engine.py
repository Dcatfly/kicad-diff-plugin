"""Git operations + kicad-cli discovery + SVG export engine.

Extracted from kicad_diff/server.py for use in the plugin server.
"""
from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

logger = logging.getLogger(__name__)

# On Windows, prevent subprocess calls from flashing a console window.
_SUBPROCESS_KWARGS: dict = (
    {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
    if sys.platform == "win32"
    else {}
)

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

    logger.debug("kicad-cli search candidates: %s", candidates)

    for path in candidates:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            logger.info("Found kicad-cli at candidate path: %s", path)
            return path

    found = shutil.which("kicad-cli")
    if found:
        logger.info("Found kicad-cli via PATH: %s", found)
        return found
    raise FileNotFoundError("Cannot find kicad-cli. Please ensure KiCad is installed.")


# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

def _normalize_git_path(raw: str) -> str:
    """Normalize a path returned by Git on Windows.

    Git for Windows (MSYS2) may return POSIX-style paths such as
    ``/c/Users/...`` instead of ``C:/Users/...``.  Convert them so that
    :class:`pathlib.Path` produces a valid Windows path.
    """
    if (
        sys.platform == "win32"
        and len(raw) >= 3
        and raw[0] == "/"
        and raw[1].isalpha()
        and raw[2] == "/"
    ):
        normalized = raw[1].upper() + ":" + raw[2:]
        logger.debug("Normalized git path: %s -> %s", raw, normalized)
        return normalized
    return raw


def find_repo_root(board_dir: str) -> Path:
    """Find the git repository root from board_dir."""
    logger.debug("find_repo_root: board_dir=%s", board_dir)
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, encoding="utf-8", check=True, cwd=board_dir,
        **_SUBPROCESS_KWARGS,
    )
    raw_path = result.stdout.strip()
    repo_root = Path(_normalize_git_path(raw_path))
    logger.info("Resolved repo root: %s (raw git output: %s)", repo_root, raw_path)
    return repo_root


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


def get_versions(repo_root: Path, board_dir: Path | None = None) -> dict:
    """Get git commit history grouped by branch."""
    current_branch = ""
    try:
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True, encoding="utf-8", check=True, cwd=repo_root,
            **_SUBPROCESS_KWARGS,
        )
        current_branch = result.stdout.strip()
        logger.debug("Current branch: %s", current_branch)
    except subprocess.CalledProcessError as e:
        logger.warning("Failed to get current branch: %s", e.stderr.strip() if e.stderr else e)

    try:
        result = subprocess.run(
            ["git", "branch", "--format=%(refname:short)"],
            capture_output=True, encoding="utf-8", check=True, cwd=repo_root,
            **_SUBPROCESS_KWARGS,
        )
        local_branches = [b.strip() for b in result.stdout.strip().splitlines() if b.strip()]
        logger.debug("Local branches: %s", local_branches)
    except subprocess.CalledProcessError as e:
        logger.warning("Failed to list local branches: %s", e.stderr.strip() if e.stderr else e)
        local_branches = []

    try:
        result = subprocess.run(
            ["git", "branch", "-r", "--format=%(refname:short)"],
            capture_output=True, encoding="utf-8", check=True, cwd=repo_root,
            **_SUBPROCESS_KWARGS,
        )
        remote_branches = [
            b.strip() for b in result.stdout.strip().splitlines()
            if b.strip() and not b.strip().endswith("/HEAD")
        ]
        logger.debug("Remote branches: %s", remote_branches)
    except subprocess.CalledProcessError as e:
        logger.warning("Failed to list remote branches: %s", e.stderr.strip() if e.stderr else e)
        remote_branches = []

    # Compute git pathspecs to scope version list to KiCad files only.
    # Use :(glob) magic pathspec so '**' matches across directories.
    if board_dir is not None and board_dir.resolve() != repo_root.resolve():
        try:
            rel_dir = str(board_dir.resolve().relative_to(repo_root.resolve())).replace("\\", "/")
            path_filter = [
                f":(glob){rel_dir}/**/*.kicad_sch",
                f":(glob){rel_dir}/**/*.kicad_pcb",
            ]
        except ValueError:
            path_filter = ["*.kicad_sch", "*.kicad_pcb"]
    else:
        path_filter = ["*.kicad_sch", "*.kicad_pcb"]

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
                ["git", "log", branch, "--format=%H|%h|%s|%D|%ar", "--"] + path_filter,
                capture_output=True, encoding="utf-8", check=True, cwd=repo_root,
                **_SUBPROCESS_KWARGS,
            )
        except subprocess.CalledProcessError as e:
            logger.warning("Failed to get log for branch %s: %s", branch, e.stderr.strip() if e.stderr else e)
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
# SVG optimisation & content hash
# ---------------------------------------------------------------------------

_SVG_NS = "http://www.w3.org/2000/svg"
_STRIP_TAGS = {f"{{{_SVG_NS}}}title", f"{{{_SVG_NS}}}desc"}
_FLOAT_RE = re.compile(r"\d+\.\d{3,}")


def _truncate_match(m: re.Match) -> str:
    """Truncate a decimal number to 2 decimal places."""
    return f"{float(m.group()):.2f}"


def optimize_svg(path: Path) -> None:
    """Optimize an SVG file in-place (stdlib xml.etree + re).

    - Remove <title> and <desc> elements (title contains nondeterministic timestamps)
    - Remove XML comments
    - Truncate coordinate precision to 2 decimal places
    """
    try:
        tree = ET.parse(path)
        root = tree.getroot()

        # Remove comments and <title>/<desc> elements
        for parent in root.iter():
            to_remove = [
                child for child in parent
                if child.tag in _STRIP_TAGS or callable(child.tag)  # callable = Comment/PI
            ]
            for child in to_remove:
                parent.remove(child)

        # Serialize, then truncate float precision
        ET.indent(tree, space="")
        raw = ET.tostring(root, encoding="unicode", xml_declaration=True)
        optimized = _FLOAT_RE.sub(_truncate_match, raw)
        path.write_text(optimized, encoding="utf-8")
    except Exception:
        logger.warning("SVG optimization failed for %s, keeping original", path, exc_info=True)


def _svg_content_hash(svg_path: Path) -> str:
    """Return sha256 hex digest of an (already optimized) SVG file."""
    data = svg_path.read_bytes()
    return hashlib.sha256(data).hexdigest()


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
    logger.info("Exporting schematic SVG: %s", input_path)
    logger.debug("kicad-cli command: %s", cmd)
    try:
        subprocess.run(cmd, capture_output=True, check=True, **_SUBPROCESS_KWARGS)
        return
    except subprocess.CalledProcessError as err:
        # Older KiCad versions may not support this flag.
        def _text(v: bytes | str | None) -> str:
            if v is None:
                return ""
            if isinstance(v, bytes):
                return v.decode(errors="ignore")
            return v

        stdout_text = _text(err.stdout)
        stderr_text = _text(err.stderr)
        output = f"{stdout_text}\n{stderr_text}".lower()
        unsupported_flag = (
            "no-background-color" in output and (
                "unknown option" in output
                or "unrecognized option" in output
                or "invalid option" in output
            )
        )
        if not unsupported_flag:
            logger.error("kicad-cli sch export failed: stdout=%s stderr=%s", stdout_text, stderr_text)
            raise
        logger.info("Retrying sch export without --no-background-color (unsupported by this KiCad version)")

    subprocess.run(
        [kicad_cli, "sch", "export", "svg", "-o", str(output_dir), str(input_path)],
        capture_output=True, check=True, **_SUBPROCESS_KWARGS,
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
        logger.warning("No layers found in PCB file: %s", input_path)
        return

    pcb_dir = os.path.join(output_dir, f"pcb-layers-{pcb_name}")
    os.makedirs(pcb_dir, exist_ok=True)

    cmd = [
        kicad_cli, "pcb", "export", "svg",
        "-o", pcb_dir,
        "--layers", ",".join(layers),
        "--common-layers", PCB_COMMON_LAYERS,
        "--mode-multi",
        "--page-size-mode", "0",
        "--sketch-pads-on-fab-layers",
        str(input_path),
    ]
    logger.info("Exporting PCB layers SVG: %s (%d layers)", input_path, len(layers))
    logger.debug("kicad-cli command: %s", cmd)
    try:
        subprocess.run(cmd, capture_output=True, check=True, **_SUBPROCESS_KWARGS)
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode(errors="ignore") if isinstance(e.stderr, bytes) else (e.stderr or "")
        stdout = e.stdout.decode(errors="ignore") if isinstance(e.stdout, bytes) else (e.stdout or "")
        logger.error("kicad-cli pcb export failed: stdout=%s stderr=%s", stdout, stderr)
        raise


def extract_project_at_ref(ref: str, dest_dir: str, repo_root: Path) -> None:
    """Extract the entire project tree at a git ref using Python tarfile."""
    logger.info("Extracting project at ref=%s to %s", ref, dest_dir)
    try:
        result = subprocess.run(
            ["git", "archive", ref],
            capture_output=True, check=True, cwd=repo_root,
            **_SUBPROCESS_KWARGS,
        )
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode(errors="ignore") if isinstance(e.stderr, bytes) else (e.stderr or "")
        logger.error("git archive failed for ref=%s: %s", ref, stderr)
        raise
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as tar:
        tar.extractall(path=str(dest_dir))


def export_for_ref(
    ref: str,
    repo_root: Path,
    output_dir: str,
    kicad_cli: str,
    board_dir: Path | None = None,
    project_name: str = "",
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
        logger.info("Cache hit for ref=%s", ref)
        return build_structured_result(out_dir, output_dir), True

    logger.info("Exporting ref=%s (cache miss)", ref)

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

        # Determine scan directory (limit to board_dir subdirectory if applicable)
        if board_dir is not None and board_dir.resolve() != repo_root.resolve():
            try:
                rel_board = board_dir.resolve().relative_to(repo_root.resolve())
            except ValueError:
                rel_board = Path(".")
            scan_root = project_root / rel_board
        else:
            scan_root = project_root

        if not scan_root.exists():
            logger.warning("Scan root does not exist for ref=%s: %s", ref, scan_root)
            if not is_working:
                complete_marker.touch()
            return build_structured_result(out_dir, output_dir), False

        # Find root schematic stems (those with matching .kicad_pro)
        root_sch_stems: set[str] = set()
        for p in scan_root.rglob("*.kicad_pro"):
            root_sch_stems.add(p.stem)

        # If a specific project name is given, try to restrict to that project.
        # Only override when the board stem matches a known .kicad_pro; otherwise
        # keep the .kicad_pro-derived stems so the real root schematic is not
        # accidentally filtered out (board and project may have different stems).
        if project_name:
            if project_name in root_sch_stems:
                root_sch_stems = {project_name}
            else:
                root_sch_stems.add(project_name)

        kicad_files: list[str] = []
        for ext in KICAD_EXTENSIONS:
            for p in scan_root.rglob(f"*{ext}"):
                rel = p.relative_to(project_root)
                if ext == ".kicad_sch" and root_sch_stems and p.stem not in root_sch_stems:
                    continue
                if ext == ".kicad_pcb" and project_name and p.stem != project_name:
                    continue
                kicad_files.append(str(rel))
        kicad_files.sort()
        logger.info("Found %d KiCad files for ref=%s: %s", len(kicad_files), ref, kicad_files)

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
                logger.warning("Export failed for %s: %s", filepath, e)
                continue

        # Optimize all exported SVGs (removes titles/comments, truncates precision)
        for svg in out_dir.rglob("*.svg"):
            optimize_svg(svg)

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
            "contentHash": _svg_content_hash(svg),
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
                    "contentHash": _svg_content_hash(svg),
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
        capture_output=True, encoding="utf-8", check=True, cwd=repo_root,
        **_SUBPROCESS_KWARGS,
    )
    return result.stdout.strip()
