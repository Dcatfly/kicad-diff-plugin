import { useDiffStore } from '../stores/useDiffStore'
import { useTranslation } from '../lib/i18n'
import FileTab from './FileTab'

export default function Header() {
  const fileKeys = useDiffStore((s) => s.fileKeys)
  const files = useDiffStore((s) => s.files)
  const toggleLocale = useDiffStore((s) => s.toggleLocale)
  const t = useTranslation()

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-bg-panel border-b border-border min-h-[44px]">
      <h1 className="text-sm font-bold text-text-primary whitespace-nowrap">
        KiCad Diff
      </h1>

      {/* File tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto flex-1 min-w-0">
        {fileKeys.map((key) => (
          <FileTab key={key} fileKey={key} file={files[key]} />
        ))}
      </div>

      {/* Language toggle */}
      <button
        onClick={toggleLocale}
        className="text-xs px-2 py-1 rounded border border-border text-text-secondary hover:text-text-primary hover:border-accent/50 transition-colors whitespace-nowrap"
      >
        {t('langToggle')}
      </button>
    </div>
  )
}
