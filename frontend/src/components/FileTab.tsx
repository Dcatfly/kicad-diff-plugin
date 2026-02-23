import { useDiffStore } from '../stores/useDiffStore'
import { useTranslation } from '../lib/i18n'
import type { FilePair } from '../types'

interface FileTabProps {
  fileKey: string
  file: FilePair
}

export default function FileTab({ fileKey, file }: FileTabProps) {
  const activeFileKey = useDiffStore((s) => s.activeFileKey)
  const setActiveFileKey = useDiffStore((s) => s.setActiveFileKey)
  const t = useTranslation()
  const isActive = activeFileKey === fileKey

  return (
    <button
      onClick={() => setActiveFileKey(fileKey)}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border transition-colors whitespace-nowrap ${
        isActive
          ? 'bg-accent/20 border-accent text-text-primary'
          : 'bg-transparent border-border text-text-secondary hover:border-accent/50 hover:text-text-primary'
      }`}
    >
      <span>{file.name} ({file.type === 'pcb' ? t('pcb') : t('schematic')})</span>
      {file.status === 'added' && (
        <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-badge-new/20 text-badge-new">
          {t('badgeNew')}
        </span>
      )}
      {file.status === 'deleted' && (
        <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-badge-del/20 text-badge-del">
          {t('badgeDel')}
        </span>
      )}
      {file.hasChanges === true && (
        <span className="w-2 h-2 rounded-full bg-change-dot" />
      )}
      {file.hasChanges === false && (
        <span className="w-2 h-2 rounded-full bg-text-secondary/30" />
      )}
    </button>
  )
}
