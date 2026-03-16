import { useDiffStore } from '../stores/useDiffStore'
import { useTranslation } from '../lib/i18n'
import {
  FADE_MIN, FADE_MAX, THRESH_MIN, THRESH_MAX, OVERLAY_MIN, OVERLAY_MAX,
} from '../lib/constants'
import Slider from './Slider'
import type { ViewMode } from '../types'

export default function Toolbar() {
  const viewMode = useDiffStore((s) => s.viewMode)
  const rawMode = useDiffStore((s) => s.rawMode)
  const fade = useDiffStore((s) => s.fade)
  const thresh = useDiffStore((s) => s.thresh)
  const overlay = useDiffStore((s) => s.overlay)
  const bgColor = useDiffStore((s) => s.bgColor)
  const setViewMode = useDiffStore((s) => s.setViewMode)
  const setRawMode = useDiffStore((s) => s.setRawMode)
  const setFade = useDiffStore((s) => s.setFade)
  const setThresh = useDiffStore((s) => s.setThresh)
  const setOverlay = useDiffStore((s) => s.setOverlay)
  const setBgColor = useDiffStore((s) => s.setBgColor)
  const t = useTranslation()

  const isDiff = viewMode === 'diff'
  const isSide = viewMode === 'side'
  const isOverlay = viewMode === 'overlay'
  const showThresh = !(isSide && rawMode)

  const modes: { mode: ViewMode; label: string }[] = [
    { mode: 'diff', label: t('modeDiff') },
    { mode: 'side', label: t('modeSide') },
    { mode: 'overlay', label: t('modeOverlay') },
  ]

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 bg-bg-panel border-b border-border text-xs">
      {/* Area 1: Mode selection */}
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

      {/* Area 2: Mode-specific controls (fixed min-width) */}
      <div className="flex items-center gap-3">
        {isDiff && (
          <Slider label={t('bgFade')} value={fade} min={FADE_MIN} max={FADE_MAX} suffix="%" onChange={setFade} />
        )}
        {isSide && (
          <>
            <label className="flex items-center gap-1.5 text-text-secondary whitespace-nowrap cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rawMode}
                onChange={(e) => setRawMode(e.target.checked)}
                className="accent-accent"
              />
              {t('rawOnly')}
            </label>
            <Slider label={t('bgFade')} value={fade} min={FADE_MIN} max={FADE_MAX} suffix="%" onChange={setFade} disabled={rawMode} />
          </>
        )}
        {isOverlay && (
          <Slider label={t('opacity')} value={overlay} min={OVERLAY_MIN} max={OVERLAY_MAX} suffix="%" onChange={setOverlay} />
        )}
      </div>

      {/* Separator */}
      <div className="w-px h-5 bg-text-secondary/30 flex-shrink-0" />

      {/* Area 3: Common controls */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-text-secondary whitespace-nowrap">
          {t('paperColor')}
          <input
            type="color"
            value={bgColor}
            onChange={(e) => setBgColor(e.target.value)}
            className="w-6 h-6 rounded cursor-pointer border border-border bg-transparent"
          />
        </label>
        {showThresh && (
          <Slider label={t('noiseFilter')} value={thresh} min={THRESH_MIN} max={THRESH_MAX} onChange={setThresh} />
        )}
      </div>
    </div>
  )
}
