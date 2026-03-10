# CLAUDE.md

## 项目概述

KiCad Diff Plugin — KiCad 9 IPC 插件，为 `.kicad_sch` 和 `.kicad_pcb` 文件提供可视化差异查看器。通过 `kicad-cli` 导出 SVG，在浏览器中以 WebGL 渲染像素级差异来比较 git 版本。

技术栈：Python 标准库 HTTP 后端 + React 19 / Vite 7 / TypeScript / Tailwind CSS 4 / Zustand / WebGL 前端。

## 目录结构

```text
plugin/              # Python 后端 + KiCad 插件声明
  entry.py           #   KiCad 按钮入口，启动/复用 server.py
  server.py          #   HTTP server，API 路由 + 静态文件服务
  diff_engine.py     #   git 操作、kicad-cli 调用、SVG 导出与优化
  web/               #   前端构建输出（git ignored）
frontend/src/        # React SPA 前端源码
  stores/            #   Zustand store（useDiffStore.ts）
  lib/               #   WebGL 渲染（glRenderer.ts）、API、i18n、工具函数
  hooks/             #   平移缩放（usePanZoom.ts）、Canvas、图片加载等
  components/        #   UI 组件（DiffCanvas、Sidebar、Toolbar 等）
  types/index.ts     #   所有 TypeScript 类型定义
scripts/             # 打包与 PCM 元数据脚本
.github/workflows/   # CI：tag 触发构建 + Release + PCM 更新
```

## 命令

```bash
# 前端
pnpm -C frontend install          # 安装依赖
pnpm -C frontend run build        # tsc 类型检查 + vite 构建 → plugin/web/
pnpm -C frontend run lint         # ESLint
pnpm -C frontend run build:watch  # 增量构建（监听模式）

# 本地运行（需 kicad-cli + git 仓库）
python3 plugin/server.py --board-dir /path/to/kicad/project

# 打包
python3 scripts/package_plugin.py --version 0.1.0
```

**变更后必须验证**：每次修改前端代码后，运行 `pnpm -C frontend run build`（含类型检查）和 `pnpm -C frontend run lint`。本项目无测试套件。

## 架构

双进程设计：Python HTTP 后端 + React SPA 前端。

**后端**（`plugin/`）：`entry.py` 作为 KiCad 插件入口，启动 `server.py`（ThreadingHTTPServer）。`diff_engine.py` 通过 `git archive` 提取历史版本，调用 `kicad-cli` 导出 SVG 并优化。API 路由：`/api/versions`、`/api/export`、`/api/health`、`/api/shutdown`。

**前端**（`frontend/src/`）：单一 Zustand store 管理全局状态。WebGL GPU 管线含 4 套 shader（diff / overlay / sideAnnotated / raw）。CSS transform 驱动平移缩放，双层 Canvas + 防抖高清叠加层。中英双语 i18n（`lib/i18n.ts`）。

## 关键约定

- 前端构建输出到 `plugin/web/`，由 Python 后端作为静态文件服务
- Python 文件全部使用 `from __future__ import annotations`
- 后端 API 字段用 snake_case，前端 TypeScript 属性中允许 snake_case（ESLint 已配置放行）
- 所有前端类型定义在 `types/index.ts`，组件用默认导出，lib/hooks 用具名导出
- Tailwind v4：自定义主题色在 `frontend/src/index.css` 的 `@theme` 块中定义
- Python 后端仅依赖标准库 + `psutil` + `kicad-python`（见 `plugin/requirements.txt`）

## CI/CD

- 推送 `v*` tag → GitHub Actions（`.github/workflows/release.yml`）→ 构建 zip → 创建 GitHub Release → 更新 `pcm-repo` 孤儿分支的 PCM 元数据

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KICAD_DIFF_PLUGIN_PORT` | 路径哈希派生（20000-39999） | 覆盖服务端口 |
| `KICAD_DIFF_PLUGIN_HOST` | `0.0.0.0`（浏览器访问回落到 `127.0.0.1`） | 覆盖监听地址 |
