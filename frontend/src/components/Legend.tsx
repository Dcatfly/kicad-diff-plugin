import { useDiffStore } from '../stores/useDiffStore'
import { useTranslation } from '../lib/i18n'

export default function Legend() {
  const viewMode = useDiffStore((s) => s.viewMode)
  const rawMode = useDiffStore((s) => s.rawMode)
  const zoom = useDiffStore((s) => s.zoom)
  const t = useTranslation()

  const isOverlay = viewMode === 'overlay'
  const isSideRaw = viewMode === 'side' && rawMode

  if (isOverlay || isSideRaw) return null

  const isSide = viewMode === 'side'

  return (
    <div className="fixed bottom-4 right-4 z-30 flex flex-col gap-1 rounded-lg bg-bg-panel/90 backdrop-blur-sm border border-border px-3 py-2 text-xs min-w-[14rem]">
      <div className="flex items-center gap-2">
        <span className="w-3 h-3 rounded-sm" style={{ background: 'rgb(170, 40, 40)' }} />
        <span className="text-text-secondary">{t('legendOldOnly')}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-3 h-3 rounded-sm" style={{ background: 'rgb(40, 170, 40)' }} />
        <span className="text-text-secondary">{t('legendNewOnly')}</span>
      </div>
      {!isSide && (
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-sm" style={{ background: 'rgb(210, 150, 30)' }} />
          <span className="text-text-secondary">{t('legendModified')}</span>
        </div>
      )}
      <div className="mt-1 text-text-secondary/60">
        {t('legendZoom')} <span className="tabular-nums">{zoom}%</span> | {t('legendPan')}
      </div>
    </div>
  )
}
