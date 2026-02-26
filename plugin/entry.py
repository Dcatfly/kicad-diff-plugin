#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any

BIND_HOST = os.environ.get("KICAD_DIFF_PLUGIN_HOST", "0.0.0.0")
# 0.0.0.0 binds all interfaces but can't be used as a connect target.
CONNECT_HOST = "127.0.0.1" if BIND_HOST == "0.0.0.0" else BIND_HOST
STARTUP_TIMEOUT_SECONDS = 4.0
HEALTHCHECK_INTERVAL_SECONDS = 0.2
SHUTDOWN_TIMEOUT_SECONDS = 2.0

PLUGIN_DIR = Path(__file__).resolve().parent
SERVER_SCRIPT = PLUGIN_DIR / "server.py"


# ── Per-project port derivation ──────────────────────────────────────

def _stable_port_for_project(board_dir: str) -> int:
    """Map *board_dir* deterministically to a TCP port in 20000-39999."""
    digest = hashlib.sha1(board_dir.encode("utf-8")).digest()
    return 20000 + (int.from_bytes(digest[:4], "big") % 20000)


def _resolve_port(board_dir: str) -> int:
    """Return the port to use.  Env-var override wins, else hash-derived."""
    env_port = os.environ.get("KICAD_DIFF_PLUGIN_PORT", "")
    if env_port:
        return int(env_port)
    return _stable_port_for_project(board_dir)


def _pid_file(port: int) -> Path:
    return PLUGIN_DIR / f".server.{port}.pid"


def _log_file(port: int) -> Path:
    return PLUGIN_DIR / f".server.{port}.log"


# ── URL helpers ───────────────────────────────────────────────────────

def _local_url(port: int, path: str = "/") -> str:
    """Build a URL using the connectable host (for health-checks and browser)."""
    return f"http://{CONNECT_HOST}:{port}{path}"


def _healthcheck_url(port: int) -> str:
    return _local_url(port, "/api/health")


def _dashboard_url(port: int) -> str:
    return _local_url(port)


def _shutdown_url(port: int) -> str:
    return _local_url(port, "/api/shutdown")


# ── Server probing ───────────────────────────────────────────────────

def _get_server_health(port: int) -> dict[str, Any] | None:
    """Return the health payload if the server is up, or *None*."""
    request = urllib.request.Request(
        _healthcheck_url(port), headers={"Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=0.5) as response:
            if response.status != 200:
                return None
            payload = json.loads(response.read().decode("utf-8"))
            if payload.get("ok"):
                return payload
            return None
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None


def _is_server_up(port: int) -> bool:
    return _get_server_health(port) is not None


def _request_shutdown(port: int) -> bool:
    request = urllib.request.Request(_shutdown_url(port), method="POST")
    try:
        with urllib.request.urlopen(request, timeout=0.8) as response:
            return response.status == 200
    except Exception:
        return False


# ── PID management ───────────────────────────────────────────────────

def _read_pid(port: int) -> int | None:
    pf = _pid_file(port)
    if not pf.exists():
        return None
    try:
        return int(pf.read_text(encoding="utf-8").strip())
    except Exception:
        return None


def _clear_pid_file(port: int) -> None:
    try:
        _pid_file(port).unlink(missing_ok=True)
    except Exception:
        pass


def _terminate_pid(pid: int) -> None:
    if pid <= 0:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        return


def _command_for_pid(pid: int) -> str:
    """Return a descriptive command string for *pid* (used for stale-server detection)."""
    if pid <= 0:
        return ""
    try:
        import psutil
        proc = psutil.Process(pid)
        cmdline = proc.cmdline()
        return " ".join(cmdline) if cmdline else proc.name()
    except Exception:
        return ""


def _kill_pid(pid: int, sig: int) -> bool:
    try:
        os.kill(pid, sig)
        return True
    except Exception:
        return False


def _pids_listening_on_port(port: int) -> list[int]:
    if os.name == "nt":
        return []

    try:
        output = subprocess.check_output(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            text=True,
        )
    except Exception:
        return []

    pids: list[int] = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            pids.append(int(line))
        except ValueError:
            continue
    return pids


def _kill_stale_plugin_server_on_port(port: int) -> bool:
    killed_any = False
    for pid in _pids_listening_on_port(port):
        if pid == os.getpid():
            continue

        command = _command_for_pid(pid)
        if "kicad-diff-plugin" not in command or "server.py" not in command:
            continue

        if _kill_pid(pid, signal.SIGTERM):
            killed_any = True

    if killed_any:
        _wait_until_server_down(port, SHUTDOWN_TIMEOUT_SECONDS)

    if _is_server_up(port):
        for pid in _pids_listening_on_port(port):
            if pid == os.getpid():
                continue
            command = _command_for_pid(pid)
            if "kicad-diff-plugin" in command and "server.py" in command:
                _kill_pid(pid, signal.SIGKILL)
                killed_any = True
        if killed_any:
            _wait_until_server_down(port, SHUTDOWN_TIMEOUT_SECONDS)

    return not _is_server_up(port)


def _wait_until_server_down(port: int, timeout_seconds: float) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not _is_server_up(port):
            return True
        time.sleep(0.1)
    return not _is_server_up(port)


# ── Log file management ───────────────────────────────────────────────

_LOG_MAX_BYTES = 2 * 1024 * 1024        # 2 MB
_LOG_KEEP_BYTES = 500 * 1024             # 500 KB


def _write_entry_log(log_path: Path, message: str) -> None:
    """Append a timestamped entry.py message to the server log file."""
    from datetime import datetime
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S,%f")[:-3]
    try:
        with log_path.open("a", encoding="utf-8") as f:
            f.write(f"{ts} [INFO] entry.py - {message}\n")
    except Exception:
        pass


def _truncate_log_if_needed(
    log_path: Path,
    max_bytes: int = _LOG_MAX_BYTES,
    keep_bytes: int = _LOG_KEEP_BYTES,
) -> None:
    """Truncate *log_path* when it exceeds *max_bytes*, keeping the last *keep_bytes*."""
    try:
        if not log_path.exists():
            return
        size = log_path.stat().st_size
        if size <= max_bytes:
            return
        actual_keep = min(keep_bytes, size - 1)
        with log_path.open("rb") as f:
            f.seek(-actual_keep, 2)  # seek from end
            # Advance to the next full line to avoid a partial first line
            f.readline()
            tail = f.read()
        tmp = log_path.with_suffix(".tmp")
        tmp.write_bytes(tail)
        os.replace(tmp, log_path)
        print(f"[kicad-diff] Truncated log {log_path.name}: {size} -> {len(tail)} bytes")
    except Exception as e:
        print(f"[kicad-diff] Failed to truncate log: {e}")


# ── Server lifecycle ─────────────────────────────────────────────────

def _restart_server(port: int, board_dir: str) -> bool:
    if _is_server_up(port):
        _request_shutdown(port)
        _wait_until_server_down(port, SHUTDOWN_TIMEOUT_SECONDS)

    if _is_server_up(port):
        pid = _read_pid(port)
        if pid is not None:
            _terminate_pid(pid)
            _wait_until_server_down(port, SHUTDOWN_TIMEOUT_SECONDS)

    if _is_server_up(port):
        if not _kill_stale_plugin_server_on_port(port):
            print(f"Port {port} is still in use; cannot restart Python server")
            return False

    _clear_pid_file(port)
    return _start_server(port, board_dir)


def _detached_popen_kwargs() -> dict[str, int | bool]:
    kwargs: dict[str, int | bool] = {}
    if os.name == "nt":
        creationflags = 0
        creationflags |= getattr(subprocess, "DETACHED_PROCESS", 0)
        creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        if creationflags:
            kwargs["creationflags"] = creationflags
    else:
        kwargs["start_new_session"] = True
    return kwargs


def _start_server(port: int, board_dir: str) -> bool:
    if not SERVER_SCRIPT.exists():
        print(f"Server script not found: {SERVER_SCRIPT}")
        return False

    log = _log_file(port)
    log.parent.mkdir(parents=True, exist_ok=True)
    _truncate_log_if_needed(log)

    _write_entry_log(log, f"Board dir: {board_dir}")
    _write_entry_log(log, f"Port: {port}")
    _write_entry_log(log, f"Python: {sys.executable}")
    _write_entry_log(log, f"Platform: {sys.platform}, os.name={os.name}")

    kicad_pid = _get_kicad_pid(log)
    _write_entry_log(log, f"KiCad PID for watchdog: {kicad_pid}")

    pid_file = _pid_file(port)
    command = [
        sys.executable,
        str(SERVER_SCRIPT),
        "--host",
        BIND_HOST,
        "--port",
        str(port),
        "--pid-file",
        str(pid_file),
        "--board-dir",
        board_dir,
    ]
    if kicad_pid is not None:
        command.extend(["--watch-pid", str(kicad_pid)])

    environment = os.environ.copy()
    environment.setdefault("PYTHONUNBUFFERED", "1")
    environment.setdefault("PYTHONIOENCODING", "utf-8")

    with log.open("ab") as log_fp:
        try:
            proc = subprocess.Popen(
                command,
                cwd=str(PLUGIN_DIR),
                env=environment,
                stdout=log_fp,
                stderr=subprocess.STDOUT,
                **_detached_popen_kwargs(),
            )
        except OSError as error:
            print(f"Failed to start server: {error}")
            return False

    # Brief wait to catch immediate crashes (e.g. missing git repo, kicad-cli)
    time.sleep(0.3)
    ret = proc.poll()
    if ret is not None:
        print(f"[kicad-diff] Server process exited immediately (code {ret})")
        _print_log_tail(log)
        return False

    return True


def _print_log_tail(log: Path, lines: int = 10) -> None:
    """Print the last N lines of the server log to help diagnose failures."""
    try:
        text = log.read_text(encoding="utf-8", errors="replace")
        tail = text.strip().splitlines()[-lines:]
        if tail:
            print("[kicad-diff] Last log lines:")
            for line in tail:
                print(f"  {line}")
    except Exception:
        pass


def _wait_for_server(port: int) -> bool:
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if _is_server_up(port):
            return True
        time.sleep(HEALTHCHECK_INTERVAL_SECONDS)
    return False


# ── Browser ──────────────────────────────────────────────────────────

def _open_url_with_command(command: list[str]) -> bool:
    kwargs: dict[str, int | bool] = {}
    if os.name == "nt":
        creationflags = 0
        creationflags |= getattr(subprocess, "DETACHED_PROCESS", 0)
        creationflags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        if creationflags:
            kwargs["creationflags"] = creationflags
    else:
        kwargs["start_new_session"] = True

    try:
        subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **kwargs,
        )
    except OSError:
        return False
    return True


def _focus_existing_diff_tab_macos(url: str) -> bool:
    """Try to focus an already-open Diff viewer tab in common macOS browsers."""
    script = r"""
function readTabUrl(tab) {
  try { return String(tab.url()); } catch (e1) {
    try { return String(tab.URL()); } catch (e2) { return ""; }
  }
}

function setWindowFront(win) {
  try { win.index = 1; } catch (e) {}
}

function focusViewerTab(appName, app, targetUrl) {
  try {
    var windows = app.windows();
    for (var wi = 0; wi < windows.length; wi += 1) {
      var win = windows[wi];
      var tabs = win.tabs();
      for (var ti = 0; ti < tabs.length; ti += 1) {
        var tab = tabs[ti];
        var tabUrl = readTabUrl(tab);
        if (!tabUrl || tabUrl.indexOf(targetUrl) !== 0) continue;

        if (appName === "Safari") {
          try { win.currentTab = tab; } catch (e) {}
        } else {
          try { win.activeTabIndex = ti + 1; } catch (e) {}
        }
        setWindowFront(win);
        try { app.activate(); } catch (e) {}
        return true;
      }
    }
  } catch (e) {}
  return false;
}

function run(argv) {
  var targetUrl = argv[0];
  var browserNames = ["Google Chrome", "Brave Browser",
                      "Microsoft Edge", "Arc", "Safari"];
  for (var i = 0; i < browserNames.length; i += 1) {
    var appName = browserNames[i];
    try {
      var app = Application(appName);
      if (!app.running()) continue;
      if (focusViewerTab(appName, app, targetUrl)) return "focused";
    } catch (e) {}
  }
  return "not_found";
}
"""
    try:
        result = subprocess.run(
            ["osascript", "-l", "JavaScript", "-e", script, url],
            capture_output=True,
            text=True,
            check=False,
            timeout=2,
        )
        return result.returncode == 0 and result.stdout.strip() == "focused"
    except Exception:
        return False


def _open_browser(url: str) -> bool:
    if sys.platform == "darwin":
        if _focus_existing_diff_tab_macos(url):
            return True
        if _open_url_with_command(["open", url]):
            return True
    elif os.name == "nt":
        if _open_url_with_command(["cmd", "/c", "start", "", url]):
            return True
    else:
        if _open_url_with_command(["xdg-open", url]):
            return True

    try:
        return bool(webbrowser.open(url, new=2))
    except Exception:
        return False


# ── KiCad integration ────────────────────────────────────────────────

def _get_board_dir_from_kicad() -> str | None:
    """Try to get the board directory from KiCad via IPC."""
    try:
        import kipy
        from kipy.proto.common.types import DocumentType
    except ImportError:
        return None

    socket_path = os.environ.get("KICAD_API_SOCKET")
    token = os.environ.get("KICAD_API_TOKEN")
    if not socket_path or not token:
        return None

    kicad: Any = None
    try:
        kicad = kipy.KiCad(
            socket_path=socket_path,
            kicad_token=token,
            client_name="org.dcatfly.kicad-diff-plugin.entry",
        )
        docs = list(kicad.get_open_documents(DocumentType.DOCTYPE_PCB))
        if not docs:
            return None

        doc = docs[0]
        project = getattr(doc, "project", None)
        if project:
            project_path = str(getattr(project, "path", ""))
            if project_path and Path(project_path).is_dir():
                return project_path

        board_file = str(getattr(doc, "board_filename", ""))
        if board_file:
            board_path = Path(board_file)
            if board_path.is_absolute() and board_path.exists():
                return str(board_path.parent)

        return None
    except Exception as e:
        print(f"[kicad-diff] Failed to get board dir from KiCad IPC: {e}")
        return None


def _get_kicad_pid(log_path: Path | None = None) -> int | None:
    """Try to find KiCad's process ID by walking up the process tree.

    Uses *psutil* for reliable cross-platform process introspection.
    """
    import psutil

    def _log(msg: str) -> None:
        if log_path is not None:
            _write_entry_log(log_path, msg)

    try:
        ancestors = psutil.Process().parents()
    except (psutil.NoSuchProcess, psutil.AccessDenied) as exc:
        _log(f"Failed to get process ancestors: {exc}")
        return None

    _log(f"Process ancestors: {[(p.pid, p.name()) for p in ancestors]}")
    for proc in ancestors:
        try:
            name_lower = proc.name().lower()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        if "kicad" in name_lower and "kicad-cli" not in name_lower:
            _log(f"Found KiCad at PID {proc.pid}")
            return proc.pid

    _log("KiCad PID not found")
    return None


def _resolve_board_dir() -> str:
    """Determine board directory: KiCad IPC → env var → cwd."""
    board_dir = os.environ.get("KICAD_DIFF_BOARD_DIR", "")
    if not board_dir:
        board_dir = _get_board_dir_from_kicad() or ""
    if not board_dir:
        board_dir = os.getcwd()
    return board_dir


# ── Entry point ──────────────────────────────────────────────────────

def main() -> int:
    board_dir = _resolve_board_dir()
    port = _resolve_port(board_dir)
    url = _dashboard_url(port)

    if _is_server_up(port):
        print(f"[kicad-diff] Server already running on port {port}, opening browser")
        if not _open_browser(url):
            print(f"Failed to open browser automatically. Open this URL manually: {url}")
            return 1
        return 0

    if not _restart_server(port, board_dir):
        return 1

    ready = _wait_for_server(port)
    if not ready:
        print("[kicad-diff] Server startup timeout")
        _print_log_tail(_log_file(port))

    if not _open_browser(url):
        print(f"Failed to open browser automatically. Open this URL manually: {url}")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
