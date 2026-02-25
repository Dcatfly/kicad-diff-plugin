import { useMemo } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import { useTranslation } from '../lib/i18n'
import type { SidebarTab } from '../types'

function ChangeDot({ hasChanges }: { hasChanges: boolean | null }) {
  if (hasChanges !== true) return null
  return <span className="w-2 h-2 rounded-full bg-change-dot flex-shrink-0" />
}

function TabButton({
  tab,
  label,
  hasAnyChanges,
}: {
  tab: SidebarTab
  label: string
  hasAnyChanges: boolean
}) {
  const sidebarTab = useDiffStore((s) => s.sidebarTab)
  const setSidebarTab = useDiffStore((s) => s.setSidebarTab)
  const isActive = sidebarTab === tab

  return (
    <button
      onClick={() => setSidebarTab(tab)}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
        isActive
          ? 'bg-accent/20 text-text-primary'
          : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      {label}
      {hasAnyChanges && <span className="w-2 h-2 rounded-full bg-change-dot" />}
    </button>
  )
}

interface SelectableListItem {
  key: string
  label: string
  hasChanges: boolean | null
  badge?: { text: string; className: string } | null
}

function SelectableList({
  items,
  selected,
  multiSelect,
  onToggle,
  emptyText,
  toggleLabel,
  onToggleAll,
}: {
  items: SelectableListItem[]
  selected: Set<string>
  multiSelect: boolean
  onToggle: (key: string) => void
  emptyText: string
  toggleLabel?: string
  onToggleAll?: () => void
}) {
  if (items.length === 0) {
    return (
      <div className="px-3 py-4 text-xs text-text-secondary text-center">
        {emptyText}
      </div>
    )
  }

  return (
    <>
      {multiSelect && toggleLabel && onToggleAll && (
        <div className="flex items-center px-3 py-1.5 border-b border-border">
          <button
            onClick={onToggleAll}
            className="text-[10px] text-text-secondary hover:text-text-primary transition-colors"
          >
            {toggleLabel}
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {items.map((item) => {
          const isSelected = selected.has(item.key)
          return (
            <button
              key={item.key}
              onClick={() => onToggle(item.key)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent/10 ${
                isSelected ? 'text-text-primary' : 'text-text-secondary'
              }`}
            >
              <span className={`w-3.5 text-center flex-shrink-0 ${isSelected ? 'text-accent' : 'text-transparent'}`}>
                ✓
              </span>
              <span className="flex-1 text-left truncate">{item.label}</span>
              {item.badge && (
                <span className={`px-1 py-0.5 text-[9px] font-semibold rounded ${item.badge.className}`}>
                  {item.badge.text}
                </span>
              )}
              <ChangeDot hasChanges={item.hasChanges} />
            </button>
          )
        })}
      </div>
    </>
  )
}

/** Sort items: changed first, then alphabetical within each group. */
function sortByChanges(items: SelectableListItem[]): SelectableListItem[] {
  return [...items].sort((a, b) => {
    const ac = a.hasChanges === true ? 0 : 1
    const bc = b.hasChanges === true ? 0 : 1
    if (ac !== bc) return ac - bc
    return a.label.localeCompare(b.label)
  })
}

export default function Sidebar() {
  const t = useTranslation()
  const sidebarTab = useDiffStore((s) => s.sidebarTab)

  // PCB state
  const pcbLayers = useDiffStore((s) => s.pcbLayers)
  const pcbLayerPairs = useDiffStore((s) => s.pcbLayerPairs)
  const selectedPcbLayers = useDiffStore((s) => s.selectedPcbLayers)
  const togglePcbLayer = useDiffStore((s) => s.togglePcbLayer)
  const selectChangedPcbLayers = useDiffStore((s) => s.selectChangedPcbLayers)
  const deselectAllPcbLayers = useDiffStore((s) => s.deselectAllPcbLayers)

  // Schematic state
  const schematicKeys = useDiffStore((s) => s.schematicKeys)
  const schematics = useDiffStore((s) => s.schematics)
  const activeSchematicKey = useDiffStore((s) => s.activeSchematicKey)
  const setActiveSchematicKey = useDiffStore((s) => s.setActiveSchematicKey)

  const hasPcbChanges = Object.values(pcbLayerPairs).some((p) => p.hasChanges === true)
  const hasSchChanges = Object.values(schematics).some((f) => f.hasChanges === true)

  // PCB toggle button: select changed / deselect
  const selectedCount = selectedPcbLayers.length
  const changedCount = pcbLayers.filter(
    (l) => pcbLayerPairs[l]?.hasChanges === true,
  ).length
  const hasSelection = selectedCount > 0
  const pcbToggleLabel = hasSelection
    ? `${t('deselect')} (${selectedCount})`
    : `${t('selectChanged')} (${changedCount})`
  const handlePcbToggle = hasSelection
    ? deselectAllPcbLayers
    : selectChangedPcbLayers

  // Build & sort list items (memoised to avoid re-sorting on every render)
  const pcbItems = useMemo<SelectableListItem[]>(
    () =>
      sortByChanges(
        pcbLayers.map((layer) => ({
          key: layer,
          label: layer,
          hasChanges: pcbLayerPairs[layer]?.hasChanges ?? null,
        })),
      ),
    [pcbLayers, pcbLayerPairs],
  )

  const schItems = useMemo<SelectableListItem[]>(
    () =>
      sortByChanges(
        schematicKeys.map((key) => {
          const file = schematics[key]
          let badge: SelectableListItem['badge'] = null
          if (file?.status === 'added') {
            badge = { text: t('badgeNew'), className: 'bg-badge-new/20 text-badge-new' }
          } else if (file?.status === 'deleted') {
            badge = { text: t('badgeDel'), className: 'bg-badge-del/20 text-badge-del' }
          }
          return {
            key,
            label: file?.name ?? key,
            hasChanges: file?.hasChanges ?? null,
            badge,
          }
        }),
      ),
    [schematicKeys, schematics, t],
  )

  const pcbSelected = useMemo(() => new Set(selectedPcbLayers), [selectedPcbLayers])
  const schSelected = useMemo(
    () => new Set(activeSchematicKey ? [activeSchematicKey] : []),
    [activeSchematicKey],
  )

  return (
    <div className="w-52 flex-shrink-0 flex flex-col bg-bg-panel border-r border-border">
      {/* Tabs */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border">
        <TabButton tab="sch" label={t('schematic')} hasAnyChanges={hasSchChanges} />
        <TabButton tab="pcb" label={t('pcb')} hasAnyChanges={hasPcbChanges} />
      </div>

      {/* List */}
      {sidebarTab === 'pcb' ? (
        <SelectableList
          items={pcbItems}
          selected={pcbSelected}
          multiSelect
          onToggle={togglePcbLayer}
          emptyText={t('noPcbLayers')}
          toggleLabel={pcbToggleLabel}
          onToggleAll={handlePcbToggle}
        />
      ) : (
        <SelectableList
          items={schItems}
          selected={schSelected}
          multiSelect={false}
          onToggle={setActiveSchematicKey}
          emptyText={t('noSchematics')}
        />
      )}
    </div>
  )
}
