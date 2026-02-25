import { useDiffStore } from '../stores/useDiffStore'
import { useTranslation } from '../lib/i18n'
import Slider from './Slider'
import { ZOOM_MIN, ZOOM_MAX } from '../lib/constants'
import type { ViewMode } from '../types'

export default function Toolbar() {
  const viewMode = useDiffStore((s) => s.viewMode)
  const rawMode = useDiffStore((s) => s.rawMode)
  const fade = useDiffStore((s) => s.fade)
  const thresh = useDiffStore((s) => s.thresh)
  const overlay = useDiffStore((s) => s.overlay)
  const zoom = useDiffStore((s) => s.zoom)
  const bgColor = useDiffStore((s) => s.bgColor)
  const setViewMode = useDiffStore((s) => s.setViewMode)
  const setRawMode = useDiffStore((s) => s.setRawMode)
  const setFade = useDiffStore((s) => s.setFade)
  const setThresh = useDiffStore((s) => s.setThresh)
  const setOverlay = useDiffStore((s) => s.setOverlay)
  const setZoom = useDiffStore((s) => s.setZoom)
  const setBgColor = useDiffStore((s) => s.setBgColor)
  const t = useTranslation()

  const isSide = viewMode === 'side'
  const isOverlay = viewMode === 'overlay'
  const showFade = !isOverlay && !(isSide && rawMode)
  const showThresh = !(isSide && rawMode)
  const showOverlay = isOverlay

  const modes: { mode: ViewMode; label: string }[] = [
    { mode: 'diff', label: t('modeDiff') },
    { mode: 'side', label: t('modeSide') },
    { mode: 'overlay', label: t('modeOverlay') },
  ]

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 bg-bg-panel border-b border-border text-xs flex-wrap">
      {/* Mode buttons */}
      <div className="flex items-center gap-1">
        {modes.map(({ mode, label }) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`px-2.5 py-1 rounded text-xs transition-colors ${
              viewMode === mode
                ? 'bg-accent text-white'
                : 'bg-bg-deep text-text-secondary hover:text-text-primary border border-border'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Raw toggle (side mode only) */}
      {isSide && (
        <button
          onClick={() => setRawMode(!rawMode)}
          className={`px-2.5 py-1 rounded text-xs transition-colors ${
            rawMode
              ? 'bg-accent text-white'
              : 'bg-bg-deep text-text-secondary hover:text-text-primary border border-border'
          }`}
        >
          {t('rawOnly')}
        </button>
      )}

      {/* Separating divider */}
      <div className="w-px h-5 bg-border" />

      {/* Background color */}
      <label className="flex items-center gap-1.5 text-text-secondary whitespace-nowrap">
        {t('paperColor')}
        <input
          type="color"
          value={bgColor}
          onChange={(e) => setBgColor(e.target.value)}
          className="w-6 h-6 rounded cursor-pointer border border-border bg-transparent"
        />
      </label>

      {/* Sliders */}
      {showFade && (
        <Slider label={t('bgFade')} value={fade} min={0} max={100} suffix="%" onChange={setFade} />
      )}

      {showThresh && (
        <Slider label={t('noiseFilter')} value={thresh} min={1} max={80} onChange={setThresh} />
      )}

      {showOverlay && (
        <Slider label={t('opacity')} value={overlay} min={0} max={100} suffix="%" onChange={setOverlay} />
      )}

      <Slider label={t('zoom')} value={zoom} min={ZOOM_MIN} max={ZOOM_MAX} suffix="%" onChange={setZoom} />
    </div>
  )
}
