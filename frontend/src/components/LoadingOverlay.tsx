import { useDiffStore } from '../stores/useDiffStore'
import { useTranslation } from '../lib/i18n'

export default function LoadingOverlay() {
  const loading = useDiffStore((s) => s.loading)
  const loadingText = useDiffStore((s) => s.loadingText)
  const t = useTranslation()

  if (!loading) return null

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-bg-deep/80">
      <div className="spinner" />
      <p className="mt-3 text-sm text-text-secondary">
        {loadingText || t('loading')}
      </p>
    </div>
  )
}
