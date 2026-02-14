#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    import kipy
    from kipy.board import Board
    from kipy.proto.common.types import DocumentType
    from kipy.util.board_layer import layer_from_canonical_name
except Exception:
    kipy = None
    Board = None
    DocumentType = None
    layer_from_canonical_name = None

PLUGIN_DIR = Path(__file__).resolve().parent
WEB_DIR = PLUGIN_DIR / "web"
IPC_CLIENT_NAME = "org.dcatfly.kicad-diff-plugin.server"
NM_PER_MM = 1_000_000.0


def utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def build_error(message: str, connected: bool = False, has_board: bool = False) -> dict[str, Any]:
    return {
        "connected": connected,
        "hasBoard": has_board,
        "message": message,
        "updatedAt": utc_now_iso(),
    }


def to_optional_count(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return len(value)
    except TypeError:
        return None


def resolve_board_path(board_file: str | None, project_path: str | None) -> str | None:
    if not board_file:
        return None
    if Path(board_file).is_absolute() or not project_path:
        return board_file
    return str(Path(project_path) / board_file)


def list_open_board_docs(kicad: Any) -> tuple[list[Any], list[str]]:
    if DocumentType is None:
        return [], []

    try:
        docs = list(kicad.get_open_documents(DocumentType.DOCTYPE_PCB))
    except Exception:
        return [], []

    labels: list[str] = []
    for doc in docs:
        board_file = str(getattr(doc, "board_filename", "")) or None
        project = getattr(doc, "project", None)
        project_path = str(getattr(project, "path", "")) or None
        labels.append(resolve_board_path(board_file, project_path) or "<unknown>")

    return docs, labels


def select_board(kicad: Any) -> tuple[Any, list[str]]:
    docs, labels = list_open_board_docs(kicad)
    if not docs or Board is None:
        return kicad.get_board(), labels

    for doc in docs:
        board = Board(kicad._client, doc)
        try:
            # A cheap probe to check whether this doc can be queried.
            board.get_footprints()
            return board, labels
        except Exception as error:
            if "is not open" in str(error):
                continue
            return board, labels

    return Board(kicad._client, docs[0]), labels


def read_metric(kicad: Any, board: Any, name: str, reader: Any) -> tuple[Any | None, str | None]:
    try:
        return reader(board), None
    except Exception as first_error:
        if "is not open" in str(first_error):
            try:
                retry_board, _ = select_board(kicad)
                return reader(retry_board), None
            except Exception as retry_error:
                return None, f"{name}: {retry_error}"
        return None, f"{name}: {first_error}"


def board_size_mm(board: Any) -> tuple[dict[str, float] | None, str]:
    try:
        shapes = list(board.get_shapes() or [])
    except Exception:
        return None, "Unavailable"
    source = "All Shapes"

    if layer_from_canonical_name is not None:
        try:
            edge_layer = layer_from_canonical_name("Edge.Cuts")
            edge_shapes = [
                shape for shape in shapes if getattr(shape, "layer", None) == edge_layer
            ]
            if edge_shapes:
                shapes = edge_shapes
                source = "Edge.Cuts"
        except Exception:
            pass

    if not shapes:
        return None, source

    min_x: int | None = None
    min_y: int | None = None
    max_x: int | None = None
    max_y: int | None = None

    for item in shapes:
        try:
            box = board.get_item_bounding_box(item, include_text=False)
        except TypeError:
            try:
                box = board.get_item_bounding_box(item)
            except Exception:
                continue
        except Exception:
            continue

        if box is None:
            continue

        try:
            x0 = int(box.pos.x)
            y0 = int(box.pos.y)
            width = int(box.size.x)
            height = int(box.size.y)
        except Exception:
            continue

        if width <= 0 or height <= 0:
            continue

        x1 = x0 + width
        y1 = y0 + height

        min_x = x0 if min_x is None else min(min_x, x0)
        min_y = y0 if min_y is None else min(min_y, y0)
        max_x = x1 if max_x is None else max(max_x, x1)
        max_y = y1 if max_y is None else max(max_y, y1)

    if min_x is None or min_y is None or max_x is None or max_y is None:
        return None, source

    return (
        {
            "width": round((max_x - min_x) / NM_PER_MM, 3),
            "height": round((max_y - min_y) / NM_PER_MM, 3),
        },
        source,
    )


def collect_project_info() -> dict[str, Any]:
    if kipy is None:
        return build_error("kicad-python 未安装，无法连接 KiCad IPC")

    socket_path = os.environ.get("KICAD_API_SOCKET")
    token = os.environ.get("KICAD_API_TOKEN")

    if not socket_path:
        return build_error("缺少 KICAD_API_SOCKET 环境变量")

    if not token:
        return build_error("缺少 KICAD_API_TOKEN 环境变量")

    try:
        kicad = kipy.KiCad(
            socket_path=socket_path,
            kicad_token=token,
            client_name=IPC_CLIENT_NAME,
        )
    except Exception as error:
        return build_error(f"KiCad IPC 连接失败: {error}")

    try:
        board, open_board_docs = select_board(kicad)
    except Exception as error:
        return build_error(f"读取当前板失败: {error}", connected=True)

    if board is None:
        return build_error("当前没有打开 PCB 文档", connected=True)

    project_name: str | None = None
    project_path: str | None = None

    try:
        project = board.get_project()
        project_name = str(getattr(project, "name", "")) or None
        project_path = str(getattr(project, "path", "")) or None
    except Exception:
        project = None

    board_file = str(getattr(board, "name", "")) or None
    board_path = resolve_board_path(board_file, project_path)

    warnings: list[str] = []

    copper_layers_raw, error = read_metric(
        kicad,
        board,
        "copper_layers",
        lambda item: int(item.get_copper_layer_count()),
    )
    copper_layers = copper_layers_raw if isinstance(copper_layers_raw, int) else None
    if error:
        warnings.append(error)

    nets_raw, error = read_metric(
        kicad,
        board,
        "nets",
        lambda item: to_optional_count(item.get_nets()),
    )
    nets = nets_raw if isinstance(nets_raw, int) else None
    if error:
        warnings.append(error)

    footprints_raw, error = read_metric(
        kicad,
        board,
        "footprints",
        lambda item: to_optional_count(item.get_footprints()),
    )
    footprints = footprints_raw if isinstance(footprints_raw, int) else None
    if error:
        warnings.append(error)

    tracks_raw, error = read_metric(
        kicad,
        board,
        "tracks",
        lambda item: to_optional_count(item.get_tracks()),
    )
    tracks = tracks_raw if isinstance(tracks_raw, int) else None
    if error:
        warnings.append(error)

    zones_raw, error = read_metric(
        kicad,
        board,
        "zones",
        lambda item: to_optional_count(item.get_zones()),
    )
    zones = zones_raw if isinstance(zones_raw, int) else None
    if error:
        warnings.append(error)

    board_size_raw, error = read_metric(
        kicad,
        board,
        "board_size",
        board_size_mm,
    )
    if isinstance(board_size_raw, tuple) and len(board_size_raw) == 2:
        size_mm, size_source = board_size_raw
    else:
        size_mm, size_source = None, "Unavailable"
    if error:
        warnings.append(error)

    all_metrics_missing = (
        copper_layers is None
        and nets is None
        and footprints is None
        and tracks is None
        and zones is None
        and size_mm is None
    )
    if all_metrics_missing:
        message = (
            "当前 PCB 未在该服务连接的 KiCad 会话中打开。"
            "请回到目标 PCB 编辑器后再次点击插件按钮重连。"
        )
        details: list[str] = []
        if warnings:
            details.append(warnings[0])
        if open_board_docs:
            details.append(f"open_docs={', '.join(open_board_docs[:2])}")
        if details:
            message = f"{message} ({'; '.join(details)})"
        return build_error(message, connected=True, has_board=False)

    message = None
    if warnings:
        message = f"部分信息读取失败: {warnings[0]}"

    return {
        "connected": True,
        "hasBoard": True,
        "message": message,
        "projectName": project_name,
        "projectPath": project_path,
        "boardFile": board_file,
        "boardPath": board_path,
        "copperLayers": copper_layers,
        "nets": nets,
        "footprints": footprints,
        "tracks": tracks,
        "zones": zones,
        "boardSizeMm": size_mm,
        "boardSizeSource": size_source,
        "updatedAt": utc_now_iso(),
    }


def placeholder_html() -> bytes:
    html = """<!doctype html>
<html lang=\"zh-CN\">
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\" />
    <title>KiCad Diff Plugin</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 32px; }
      code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
      pre { background: #111827; color: #f9fafb; padding: 16px; border-radius: 10px; overflow-x: auto; }
    </style>
  </head>
  <body>
    <h1>前端资源尚未构建</h1>
    <p>请在仓库根目录运行以下命令后刷新页面：</p>
    <pre>pnpm -C frontend run build</pre>
  </body>
</html>
"""
    return html.encode("utf-8")


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "KiCadDiffPlugin/0.1"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/health":
            self.send_json({"ok": True, "updatedAt": utc_now_iso()})
            return

        if parsed.path == "/api/project/info":
            self.send_json(collect_project_info())
            return

        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/shutdown":
            self.send_json({"ok": True, "updatedAt": utc_now_iso()})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[http] {self.address_string()} - {format % args}")

    def send_json(self, payload: dict[str, Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, raw_path: str) -> None:
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="KiCad diff plugin web server")
    parser.add_argument("--host", default="127.0.0.1", help="bind host")
    parser.add_argument("--port", default=18765, type=int, help="bind port")
    parser.add_argument("--pid-file", default="", help="optional pid file path")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pid_file = Path(args.pid_file).resolve() if args.pid_file else None

    server = ThreadingHTTPServer((args.host, args.port), RequestHandler)
    if pid_file is not None:
        pid_file.write_text(str(os.getpid()), encoding="utf-8")
    print(f"Server listening at http://{args.host}:{args.port}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if pid_file is not None:
            pid_file.unlink(missing_ok=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
