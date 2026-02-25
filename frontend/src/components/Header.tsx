import { useDiffStore } from '../stores/useDiffStore'
import { useTranslation, translate } from '../lib/i18n'

export default function Header() {
  const versionData = useDiffStore((s) => s.versionData)
  const oldRef = useDiffStore((s) => s.oldRef)
  const newRef = useDiffStore((s) => s.newRef)
  const setOldRef = useDiffStore((s) => s.setOldRef)
  const setNewRef = useDiffStore((s) => s.setNewRef)
  const compare = useDiffStore((s) => s.compare)
  const comparing = useDiffStore((s) => s.comparing)
  const exportStatus = useDiffStore((s) => s.exportStatus)
  const locale = useDiffStore((s) => s.locale)
  const toggleLocale = useDiffStore((s) => s.toggleLocale)
  const t = useTranslation()

  function formatVersionOption(v: { short_hash: string; message: string; tags: string; time: string }) {
    let text = `${v.short_hash} - ${v.message}`
    if (v.tags) text += ` (${v.tags})`
    text += ` [${v.time}]`
    return text
  }

  const renderOptions = () => {
    if (!versionData) return null
    return versionData.groups.map((g) => {
      const label = g.is_current
        ? `\u2605 ${g.branch} ${translate(locale, 'currentBranch')}`
        : g.branch
      return (
        <optgroup key={g.branch} label={label}>
          {g.commits.map((c) => (
            <option key={c.ref} value={c.ref}>
              {formatVersionOption(c)}
            </option>
          ))}
        </optgroup>
      )
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-1.5 bg-bg-panel border-b border-border text-xs min-h-[40px]">
      <h1 className="text-sm font-bold text-text-primary whitespace-nowrap">
        KiCad Diff
      </h1>

      {/* Old version */}
      <label className="flex items-center gap-1.5">
        <span className="text-text-secondary">{t('oldVersion')}</span>
        <select
          value={oldRef}
          onChange={(e) => setOldRef(e.target.value)}
          className="bg-bg-deep text-text-primary border border-border rounded px-2 py-1 text-xs max-w-[280px]"
        >
          <option value="working">{translate(locale, 'workingOption')}</option>
          {renderOptions()}
        </select>
      </label>

      {/* New version */}
      <label className="flex items-center gap-1.5">
        <span className="text-text-secondary">{t('newVersion')}</span>
        <select
          value={newRef}
          onChange={(e) => setNewRef(e.target.value)}
          className="bg-bg-deep text-text-primary border border-border rounded px-2 py-1 text-xs max-w-[280px]"
        >
          <option value="working">{translate(locale, 'workingOption')}</option>
          {renderOptions()}
        </select>
      </label>

      {/* Compare button */}
      <button
        onClick={compare}
        disabled={comparing}
        className="px-3 py-1 rounded bg-accent text-white text-xs font-semibold hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {t('compare')}
      </button>

      {/* Status */}
      {exportStatus && (
        <span className="text-text-secondary text-xs">{exportStatus}</span>
      )}

      <div className="flex-1" />

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
