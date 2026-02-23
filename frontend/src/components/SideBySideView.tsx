import { useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import { useTranslation, translate } from '../lib/i18n'
import { useCanvas } from '../hooks/useCanvas'
import LoadingOverlay from './LoadingOverlay'

function getVersionLabel(
  ref: string,
  versionMap: Record<string, { short_hash: string; tags: string; is_working?: boolean }>,
  locale: 'zh' | 'en',
): string {
  if (ref === 'working') return translate(locale, 'working')
  const v = versionMap[ref]
  if (v) {
    let label = v.short_hash
    if (v.tags) label += ` (${v.tags})`
    return label
  }
  return ref.substring(0, 8)
}

export default function SideBySideView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const leftPanelRef = useRef<HTMLDivElement>(null)
  const rightPanelRef = useRef<HTMLDivElement>(null)
  const canvasLRef = useRef<HTMLCanvasElement>(null)
  const canvasRRef = useRef<HTMLCanvasElement>(null)

  const oldRef = useDiffStore((s) => s.oldRef)
  const newRef = useDiffStore((s) => s.newRef)
  const versionMap = useDiffStore((s) => s.versionMap)
  const locale = useDiffStore((s) => s.locale)
  const t = useTranslation()

  useCanvas(containerRef, undefined, canvasLRef, canvasRRef, leftPanelRef, rightPanelRef)

  const oldLabel = oldRef
    ? `${t('sideOld')} ${getVersionLabel(oldRef, versionMap, locale)}`
    : t('sideOld')
  const newLabel = newRef
    ? `${t('sideNew')} ${getVersionLabel(newRef, versionMap, locale)}`
    : t('sideNew')

  return (
    <div ref={containerRef} className="relative flex flex-1 overflow-hidden">
      {/* Left panel */}
      <div
        ref={leftPanelRef}
        className="side-panel flex-1 overflow-auto bg-bg-canvas relative"
      >
        <div className="side-label">{oldLabel}</div>
        <canvas ref={canvasLRef} />
      </div>

      {/* Divider */}
      <div className="w-px bg-border cursor-col-resize flex-shrink-0" />

      {/* Right panel */}
      <div
        ref={rightPanelRef}
        className="side-panel flex-1 overflow-auto bg-bg-canvas relative"
      >
        <div className="side-label">{newLabel}</div>
        <canvas ref={canvasRRef} />
      </div>

      <LoadingOverlay />
    </div>
  )
}
