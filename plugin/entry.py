#!/usr/bin/env python3
from __future__ import annotations

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

HOST = os.environ.get("KICAD_DIFF_PLUGIN_HOST", "127.0.0.1")
PORT = int(os.environ.get("KICAD_DIFF_PLUGIN_PORT", "18765"))
STARTUP_TIMEOUT_SECONDS = 4.0
HEALTHCHECK_INTERVAL_SECONDS = 0.2

PLUGIN_DIR = Path(__file__).resolve().parent
SERVER_SCRIPT = PLUGIN_DIR / "server.py"
LOG_FILE = PLUGIN_DIR / ".server.log"
PID_FILE = PLUGIN_DIR / ".server.pid"
SHUTDOWN_TIMEOUT_SECONDS = 2.0


def _healthcheck_url() -> str:
    return f"http://{HOST}:{PORT}/api/health"


def _dashboard_url() -> str:
    return f"http://{HOST}:{PORT}/"


def _shutdown_url() -> str:
    return f"http://{HOST}:{PORT}/api/shutdown"


def _is_server_up() -> bool:
    request = urllib.request.Request(
        _healthcheck_url(), headers={"Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=0.5) as response:
            if response.status != 200:
                return False
            payload = json.loads(response.read().decode("utf-8"))
            return bool(payload.get("ok"))
    except (urllib.error.URLError, TimeoutError, ValueError):
        return False


def _request_shutdown() -> bool:
    request = urllib.request.Request(_shutdown_url(), method="POST")
    try:
        with urllib.request.urlopen(request, timeout=0.8) as response:
            return response.status == 200
    except Exception:
        return False


def _read_pid() -> int | None:
    if not PID_FILE.exists():
        return None
    try:
        return int(PID_FILE.read_text(encoding="utf-8").strip())
    except Exception:
        return None


def _clear_pid_file() -> None:
    try:
        PID_FILE.unlink(missing_ok=True)
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
    if pid <= 0:
        return ""
    try:
        output = subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "command="], text=True
        )
    except Exception:
        return ""
    return output.strip()


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


def _kill_stale_plugin_server_on_port() -> bool:
    killed_any = False
    for pid in _pids_listening_on_port(PORT):
        if pid == os.getpid():
            continue

        command = _command_for_pid(pid)
        if "kicad-diff-plugin" not in command or "server.py" not in command:
            continue

        if _kill_pid(pid, signal.SIGTERM):
            killed_any = True

    if killed_any:
        _wait_until_server_down(SHUTDOWN_TIMEOUT_SECONDS)

    if _is_server_up():
        for pid in _pids_listening_on_port(PORT):
            if pid == os.getpid():
                continue
            command = _command_for_pid(pid)
            if "kicad-diff-plugin" in command and "server.py" in command:
                _kill_pid(pid, signal.SIGKILL)
                killed_any = True
        if killed_any:
            _wait_until_server_down(SHUTDOWN_TIMEOUT_SECONDS)

    return not _is_server_up()


def _wait_until_server_down(timeout_seconds: float) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not _is_server_up():
            return True
        time.sleep(0.1)
    return not _is_server_up()


def _restart_server() -> bool:
    if _is_server_up():
        _request_shutdown()
        _wait_until_server_down(SHUTDOWN_TIMEOUT_SECONDS)

    if _is_server_up():
        pid = _read_pid()
        if pid is not None:
            _terminate_pid(pid)
            _wait_until_server_down(SHUTDOWN_TIMEOUT_SECONDS)

    if _is_server_up():
        if not _kill_stale_plugin_server_on_port():
            print(f"Port {PORT} is still in use; cannot restart Python server")
            return False

    _clear_pid_file()
    return _start_server()


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


def _open_browser(url: str) -> bool:
    if sys.platform == "darwin":
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


def _start_server() -> bool:
    if not SERVER_SCRIPT.exists():
        print(f"Server script not found: {SERVER_SCRIPT}")
        return False

    command = [
        sys.executable,
        str(SERVER_SCRIPT),
        "--host",
        HOST,
        "--port",
        str(PORT),
        "--pid-file",
        str(PID_FILE),
    ]

    environment = os.environ.copy()
    environment.setdefault("PYTHONUNBUFFERED", "1")

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("ab") as log_fp:
        try:
            subprocess.Popen(
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

    return True


def _wait_for_server() -> bool:
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if _is_server_up():
            return True
        time.sleep(HEALTHCHECK_INTERVAL_SECONDS)
    return False


def main() -> int:
    if not _restart_server():
        return 1

    ready = _wait_for_server()
    if not ready:
        print("Python server startup timeout, opening browser anyway")

    url = _dashboard_url()
    if not _open_browser(url):
        print(f"Failed to open browser automatically. Open this URL manually: {url}")
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
