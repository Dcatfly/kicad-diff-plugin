import { useCallback, useEffect, useMemo, useState } from 'react'

type BoardSize = {
  width: number
  height: number
}

type ProjectInfo = {
  connected: boolean
  hasBoard: boolean
  message?: string
  projectName?: string
  projectPath?: string
  boardFile?: string
  boardPath?: string
  copperLayers?: number | null
  nets?: number
  footprints?: number
  tracks?: number
  zones?: number
  boardSizeMm?: BoardSize | null
  boardSizeSource?: string
  updatedAt?: string
}

const numberFormatter = new Intl.NumberFormat('zh-CN')

function formatCount(value: number | null | undefined): string {
  if (value === undefined || value === null) {
    return '--'
  }
  return numberFormatter.format(value)
}

function formatBoardSize(size: BoardSize | null | undefined): string {
  if (!size) {
    return '--'
  }
  return `${size.width.toFixed(2)} mm × ${size.height.toFixed(2)} mm`
}

function formatTime(value: string | undefined): string {
  if (!value) {
    return '--'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

function App() {
  const [info, setInfo] = useState<ProjectInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchInfo = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/project/info', {
        cache: 'no-store',
      })

      if (!response.ok) {
        throw new Error(`请求失败 (${response.status})`)
      }

      const payload = (await response.json()) as ProjectInfo
      setInfo(payload)

      if (!payload.connected || !payload.hasBoard) {
        setError(payload.message ?? 'KiCad IPC 未返回可用板信息')
      }
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : '未知错误'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchInfo()
  }, [fetchInfo])

  const metrics = useMemo(
    () => [
      { label: '铜层', value: formatCount(info?.copperLayers) },
      { label: '网络', value: formatCount(info?.nets) },
      { label: 'Footprint', value: formatCount(info?.footprints) },
      { label: '走线', value: formatCount(info?.tracks) },
      { label: '铺铜区', value: formatCount(info?.zones) },
      { label: '板框尺寸', value: formatBoardSize(info?.boardSizeMm) },
    ],
    [info],
  )

  return (
    <main className="min-h-screen px-6 py-8 md:px-12 md:py-12">
      <section className="mx-auto max-w-5xl rounded-3xl border border-black/15 bg-white/80 p-6 shadow-[0_14px_50px_-30px_rgba(39,49,65,0.65)] backdrop-blur-xl md:p-10">
        <header className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="inline-flex rounded-full border border-black/20 bg-[var(--paper)] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-black/70">
              KiCad IPC Plugin
            </p>
            <h1 className="mt-4 font-display text-3xl leading-tight text-[var(--ink-strong)] md:text-5xl">
              PCB 项目实时信息看板
            </h1>
            <p className="mt-3 max-w-2xl text-sm text-black/65 md:text-base">
              该页面由插件按钮启动的 Python server 提供，数据通过 KiCad 9 IPC
              实时读取。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void fetchInfo()}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-xl border border-black/20 bg-[var(--ink-strong)] px-5 py-2 text-sm text-white transition hover:bg-black disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? '刷新中...' : '刷新 IPC 数据'}
          </button>
        </header>

        <section className="grid gap-4 rounded-2xl border border-black/10 bg-white p-5 md:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-[0.15em] text-black/50">
              Project
            </p>
            <p className="mt-1 text-lg font-semibold text-[var(--ink-strong)]">
              {info?.projectName ?? '--'}
            </p>
            <p className="mt-2 break-all text-xs text-black/55">
              {info?.projectPath ?? '--'}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.15em] text-black/50">
              Board
            </p>
            <p className="mt-1 text-lg font-semibold text-[var(--ink-strong)]">
              {info?.boardFile ?? '--'}
            </p>
            <p className="mt-2 break-all text-xs text-black/55">
              {info?.boardPath ?? '--'}
            </p>
          </div>
        </section>

        <section className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3">
          {metrics.map((item) => (
            <article
              key={item.label}
              className="rounded-2xl border border-black/10 bg-[var(--paper)] p-4"
            >
              <p className="text-xs uppercase tracking-[0.15em] text-black/50">
                {item.label}
              </p>
              <p className="mt-2 text-xl font-semibold text-[var(--ink-strong)] md:text-2xl">
                {item.value}
              </p>
            </article>
          ))}
        </section>

        <footer className="mt-6 rounded-xl border border-black/10 bg-white p-4 text-xs text-black/60">
          <p>IPC 状态: {info?.connected ? '已连接' : '未连接'}</p>
          <p>更新时间: {formatTime(info?.updatedAt)}</p>
          <p>板框来源: {info?.boardSizeSource ?? '--'}</p>
          {error ? <p className="mt-2 text-[var(--warn)]">提示: {error}</p> : null}
        </footer>
      </section>
    </main>
  )
}

export default App
