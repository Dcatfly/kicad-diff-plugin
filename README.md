# KiCad IPC 插件基础模板

该仓库提供一个可直接扩展的 KiCad 9 IPC 插件骨架，包含：

- KiCad IPC action 插件入口（按钮触发）
- Python HTTP server（读取 KiCad IPC 并提供 API）
- Vite + React + TypeScript + Tailwind CSS 前端
- `pnpm` 前端构建与 watch 流程
- 一键打包脚本（生成安装 zip）

## 目录结构

```text
/Users/dcatfly/Workspace/Workspace/llm/kicad_diff_plugin
├── frontend/                # Vite + React + TS + Tailwind 前端源码
├── plugin/
│   ├── plugin.json          # KiCad IPC 插件声明
│   ├── metadata.json        # PCM 安装包元数据（Install from File 必需）
│   ├── entry.py             # KiCad 按钮入口：启动 server + 打开浏览器
│   ├── server.py            # Python server，提供静态页与 IPC API
│   ├── requirements.txt     # Python 依赖
│   └── icons/               # 工具栏按钮图标
└── scripts/
    └── package_plugin.py    # 打包脚本（构建前端并生成 zip）
```

## 前置要求

- KiCad 9.0+
- Python 3.10+
- Node.js 20+
- pnpm 10+

## 前端开发模式

前端依赖只安装在 `frontend/`：

```bash
pnpm -C frontend install
```

实时构建到 `plugin/web`（供 Python server 直接托管）：

```bash
pnpm -C frontend run build:watch
```

说明：该命令输出的即最终静态页面，浏览器刷新即可看到最新结果。

## KiCad 插件工作流

1. 在 KiCad PCB Editor 中点击插件按钮（`Open Diff Dashboard`）
2. `plugin/entry.py` 启动（或复用）`plugin/server.py`
3. 自动打开浏览器 `http://127.0.0.1:18765/`
4. 页面调用 `/api/project/info`，server 通过 IPC 获取当前 PCB 信息

## 页面展示的基础信息

- 工程名与工程路径
- 板文件名与路径
- 铜层数
- 网络数
- Footprint 数
- 走线段数
- Zone 数
- 板框尺寸（优先按 `Edge.Cuts` 估算）

## Python 依赖

```bash
python3 -m pip install -r plugin/requirements.txt
```

## 打包发布

执行：

```bash
python3 scripts/package_plugin.py --version 0.1.0
```

输出：

```text
dist/org.dcatfly.kicad-diff-plugin-0.1.0.zip
```

zip 内部结构为（PCM 可安装结构）：

```text
metadata.json
plugins/
  org.dcatfly.kicad-diff-plugin/
    plugin.json
    entry.py
    server.py
    requirements.txt
    icons/
    web/
```

## 安装到 KiCad

推荐方式：在 KiCad 的 Plugin and Content Manager 使用 `Install from File...` 选择该 zip。

手动方式：解压 zip 后，将 `plugins/` 下内容放到 KiCad 插件目录中的包名目录里。

常见路径：

- macOS: `~/Library/Application Support/kicad/9.0/plugins/`
- Linux: `~/.local/share/kicad/9.0/plugins/`
- Windows: `%APPDATA%\\kicad\\9.0\\plugins\\`

## 可配置项

- 端口：`KICAD_DIFF_PLUGIN_PORT`（默认 `18765`）
- Host：`KICAD_DIFF_PLUGIN_HOST`（默认 `127.0.0.1`）
