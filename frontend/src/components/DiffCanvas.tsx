import { useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import { useTranslation } from '../lib/i18n'
import { useCanvas } from '../hooks/useCanvas'
import LoadingOverlay from './LoadingOverlay'
import EmptyHint from './EmptyHint'

export default function DiffCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const { hiResRef } = useCanvas(containerRef, canvasRef)

  const sidebarTab = useDiffStore((s) => s.sidebarTab)
  const activeSchematicKey = useDiffStore((s) => s.activeSchematicKey)
  const selectedPcbLayers = useDiffStore((s) => s.selectedPcbLayers)
  const loading = useDiffStore((s) => s.loading)
  const t = useTranslation()

  const hasContent =
    sidebarTab === 'sch' ? !!activeSchematicKey : selectedPcbLayers.length > 0
  const hint = sidebarTab === 'sch' ? t('selectSchematic') : t('selectPcbLayers')
  const showHint = !hasContent && !loading

  return (
    <div className="relative flex-1 overflow-hidden bg-bg-canvas">
      <div
        ref={containerRef}
        className="relative h-full w-full overflow-auto"
      >
        <canvas ref={canvasRef} />
        <canvas
          ref={hiResRef}
          className="absolute pointer-events-none"
          style={{ display: 'none' }}
        />
      </div>
      {showHint && <EmptyHint text={hint} />}
      <LoadingOverlay />
    </div>
  )
}
