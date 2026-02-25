#!/usr/bin/env python3
"""KiCad Diff Plugin - HTTP server with diff API routes.

Serves the built frontend (SPA) and provides Git version / SVG export APIs.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import tempfile
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from diff_engine import (
    export_for_ref,
    find_kicad_cli,
    find_repo_root,
    get_versions,
    resolve_ref,
)

PLUGIN_DIR = Path(__file__).resolve().parent
WEB_DIR = PLUGIN_DIR / "web"


def utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def placeholder_html() -> bytes:
    html = """<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>KiCad Diff</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
             margin: 0; padding: 32px; background: #0f0f23; color: #e2e8f0; }
      pre { background: #1a1b3a; color: #e2e8f0; padding: 16px; border-radius: 10px; }
    </style>
  </head>
  <body>
    <h1>Frontend not built yet</h1>
    <p>Run the following command and refresh:</p>
    <pre>pnpm -C frontend run build</pre>
  </body>
</html>
"""
    return html.encode("utf-8")


class DiffRequestHandler(BaseHTTPRequestHandler):
    """HTTP handler for the diff viewer backend."""

    server_version = "KiCadDiff/0.2"

    # These are set by the factory below
    _repo_root: Path
    _output_dir: str
    _kicad_cli: str
    _export_locks: dict[str, threading.Lock]
    _export_locks_guard: threading.Lock

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            self._send_json({
                "ok": True,
                "updatedAt": utc_now_iso(),
                "boardDir": str(self._repo_root),
            })
        elif path == "/api/versions":
            self._handle_versions()
        elif path.startswith("/output/"):
            self._serve_output_file(path)
        else:
            self._serve_static(path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/export":
            self._handle_export()
        elif parsed.path == "/api/shutdown":
            self._send_json({"ok": True, "updatedAt": utc_now_iso()})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[kicad-diff] {format % args}")

    # ── API handlers ──

    def _handle_versions(self) -> None:
        try:
            versions = get_versions(self._repo_root)
            self._send_json(versions)
        except Exception as e:
            print(f"[kicad-diff] Error in /api/versions: {e}")
            self._send_json({"status": "error", "message": str(e)}, 500)

    def _handle_export(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self._send_json({"status": "error", "message": "Invalid JSON"}, 400)
            return

        ref = data.get("ref", "").strip()
        if not ref:
            self._send_json({"status": "error", "message": "Missing ref"}, 400)
            return

        try:
            actual_ref = resolve_ref(ref, self._repo_root)
        except ValueError as e:
            self._send_json({"status": "error", "message": str(e)}, 400)
            return
        except Exception:
            self._send_json({"status": "error", "message": f"Unknown ref: {ref}"}, 400)
            return

        try:
            # Per-ref lock: different refs export in parallel,
            # same ref (especially "working") is serialized.
            with self._export_locks_guard:
                ref_lock = self._export_locks.get(actual_ref)
                if ref_lock is None:
                    ref_lock = threading.Lock()
                    self._export_locks[actual_ref] = ref_lock

            with ref_lock:
                result, cached = export_for_ref(
                    actual_ref, self._repo_root, self._output_dir, self._kicad_cli,
                )
            self._send_json({
                "status": "ok",
                "ref": actual_ref,
                "cached": cached,
                "files": result["files"],
                "pcb_layers": result["pcb_layers"],
            })
        except Exception as e:
            print(f"[kicad-diff] Error in /api/export for ref={ref}: {e}")
            self._send_json({"status": "error", "message": str(e)}, 500)

    # ── File serving ──

    def _serve_output_file(self, path: str) -> None:
        rel = unquote(path[len("/output/"):])
        filepath = Path(self._output_dir) / rel
        if not filepath.exists() or not filepath.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            filepath.resolve().relative_to(Path(self._output_dir).resolve())
        except ValueError:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        data = filepath.read_bytes()
        self.send_response(HTTPStatus.OK)
        if filepath.suffix == ".svg":
            self.send_header("Content-Type", "image/svg+xml")
        else:
            self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_static(self, raw_path: str) -> None:
        index_path = WEB_DIR / "index.html"
        web_dir = WEB_DIR.resolve()

        if not index_path.exists():
            body = placeholder_html()
            self.send_response(HTTPStatus.SERVICE_UNAVAILABLE)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        path_text = raw_path.lstrip("/")
        if not path_text:
            path_text = "index.html"

        candidate = (WEB_DIR / path_text).resolve()

        try:
            candidate.relative_to(web_dir)
        except ValueError:
            self.send_error(HTTPStatus.FORBIDDEN)
            return

        if not candidate.exists() or not candidate.is_file():
            candidate = index_path

        body = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        text_like_types = {
            "application/javascript",
            "application/json",
            "application/xml",
            "image/svg+xml",
        }
        if content_type.startswith("text/") or content_type in text_like_types:
            content_type = f"{content_type}; charset=utf-8"

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        if candidate.name == "index.html":
            self.send_header("Cache-Control", "no-store")
        else:
            self.send_header("Cache-Control", "public, max-age=60")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── Helpers ──

    def _send_json(self, data: Any, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def _make_handler_class(
    repo_root: Path,
    output_dir: str,
    kicad_cli: str,
) -> type[DiffRequestHandler]:
    """Create a handler class with bound configuration."""
    return type(
        "BoundDiffHandler",
        (DiffRequestHandler,),
        {
            "_repo_root": repo_root,
            "_output_dir": output_dir,
            "_kicad_cli": kicad_cli,
            "_export_locks": {},
            "_export_locks_guard": threading.Lock(),
        },
    )


def _is_process_alive(pid: int) -> bool:
    """Check whether a process with the given PID is still running."""
    try:
        os.kill(pid, 0)  # signal 0 = existence check, no signal sent
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Process exists but we lack permission to signal it
        return True
    except OSError:
        return False


def _start_pid_watcher(
    watch_pid: int,
    server: ThreadingHTTPServer,
    poll_interval: float = 3.0,
) -> None:
    """Start a daemon thread that shuts down the server when watch_pid exits."""

    def _watcher() -> None:
        while True:
            time.sleep(poll_interval)
            if not _is_process_alive(watch_pid):
                print(
                    f"[kicad-diff] Watched process {watch_pid} exited, "
                    "shutting down server"
                )
                server.shutdown()
                return

    t = threading.Thread(target=_watcher, daemon=True)
    t.start()
    print(f"[kicad-diff] PID watcher started for PID {watch_pid}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="KiCad Diff web server")
    parser.add_argument("--host", default="127.0.0.1", help="bind host")
    parser.add_argument("--port", default=18765, type=int, help="bind port")
    parser.add_argument("--pid-file", default="", help="optional pid file path")
    parser.add_argument(
        "--board-dir",
        default=os.environ.get("KICAD_DIFF_BOARD_DIR", ""),
        help="KiCad project directory (default: $KICAD_DIFF_BOARD_DIR or cwd)",
    )
    parser.add_argument(
        "--watch-pid",
        default=0,
        type=int,
        help="PID to watch; server shuts down when this process exits",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pid_file = Path(args.pid_file).resolve() if args.pid_file else None
    board_dir = args.board_dir or os.getcwd()

    repo_root = find_repo_root(board_dir)
    kicad_cli = find_kicad_cli()
    output_dir = tempfile.mkdtemp(prefix="kicad-diff-")

    print(f"[kicad-diff] Plugin dir: {PLUGIN_DIR}")
    print(f"[kicad-diff] Repo root:  {repo_root}")
    print(f"[kicad-diff] kicad-cli:  {kicad_cli}")
    print(f"[kicad-diff] Output dir: {output_dir}")
    print(f"[kicad-diff] Board dir:  {board_dir}")

    handler_class = _make_handler_class(repo_root, output_dir, kicad_cli)
    server = ThreadingHTTPServer((args.host, args.port), handler_class)

    if pid_file is not None:
        pid_file.write_text(str(os.getpid()), encoding="utf-8")

    # Start PID watcher for auto-shutdown when KiCad exits
    if args.watch_pid > 0:
        _start_pid_watcher(args.watch_pid, server)

    print(f"[kicad-diff] Server listening at http://{args.host}:{args.port}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[kicad-diff] Server stopped.")
    finally:
        server.server_close()
        shutil.rmtree(output_dir, ignore_errors=True)
        if pid_file is not None:
            pid_file.unlink(missing_ok=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
