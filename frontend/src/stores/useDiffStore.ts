// ─── Zustand store: global state for the diff viewer ───

import { create } from 'zustand'
import type {
  ViewMode,
  Locale,
  SidebarTab,
  VersionData,
  VersionMap,
  FilePair,
  LayerPair,
  ExportResult,
  ExportStatus,
} from '../types'
import { fetchVersions, exportVersion } from '../lib/api'
import {
  DEFAULT_ZOOM, DEFAULT_FADE, DEFAULT_THRESH, DEFAULT_OVERLAY, DEFAULT_BG_COLOR,
} from '../lib/constants'
import { buildFilePairs, buildLayerPairs } from '../lib/filePairing'
import { translate } from '../lib/i18n'

interface DiffState {
  // View
  viewMode: ViewMode
  rawMode: boolean
  zoom: number
  fade: number
  thresh: number
  overlay: number
  bgColor: string

  // Sidebar
  sidebarTab: SidebarTab
  setSidebarTab: (tab: SidebarTab) => void

  // Schematics (single-select)
  schematicKeys: string[]
  schematics: Record<string, FilePair>
  activeSchematicKey: string
  setActiveSchematicKey: (key: string) => void
  updateSchematicChanges: (key: string, hasChanges: boolean | null) => void

  // PCB layers (multi-select)
  pcbName: string
  pcbLayers: string[]
  pcbLayerPairs: Record<string, LayerPair>
  selectedPcbLayers: string[]
  togglePcbLayer: (layer: string) => void
  selectChangedPcbLayers: () => void
  deselectAllPcbLayers: () => void
  updateLayerChanges: (layer: string, hasChanges: boolean | null) => void

  // Smart default tracking: true once initial auto-selection is done
  _schAutoSelectDone: boolean
  _pcbAutoSelectDone: boolean

  // Versions
  pluginVersion: string
  versionData: VersionData | null
  versionMap: VersionMap
  oldRef: string
  newRef: string

  // UI
  locale: Locale
  loading: boolean
  loadingText: string
  exportStatus: ExportStatus
  comparing: boolean

  // Actions
  setViewMode: (mode: ViewMode) => void
  setRawMode: (raw: boolean) => void
  setZoom: (zoom: number) => void
  setFade: (fade: number) => void
  setThresh: (thresh: number) => void
  setOverlay: (overlay: number) => void
  setBgColor: (color: string) => void
  setOldRef: (ref: string) => void
  setNewRef: (ref: string) => void
  toggleLocale: () => void
  setLoading: (loading: boolean, text?: string) => void
  setExportStatus: (status: ExportStatus) => void
  initVersions: () => Promise<void>
  compare: () => Promise<void>
}

const detectInitialLocale = (): Locale =>
  (navigator.language || '').startsWith('zh') ? 'zh' : 'en'

export const useDiffStore = create<DiffState>((set, get) => ({
  // View defaults
  viewMode: 'diff',
  rawMode: false,
  zoom: DEFAULT_ZOOM,
  fade: DEFAULT_FADE,
  thresh: DEFAULT_THRESH,
  overlay: DEFAULT_OVERLAY,
  bgColor: DEFAULT_BG_COLOR,

  // Sidebar
  sidebarTab: 'pcb',
  setSidebarTab: (tab) => set({ sidebarTab: tab, _schAutoSelectDone: true, _pcbAutoSelectDone: true }),

  // Schematics
  schematicKeys: [],
  schematics: {},
  activeSchematicKey: '',
  setActiveSchematicKey: (key) =>
    set({ activeSchematicKey: key, _schAutoSelectDone: true }),
  updateSchematicChanges: (key, hasChanges) =>
    set((s) => {
      const sch = s.schematics[key]
      if (!sch) return s
      const newSchematics = { ...s.schematics, [key]: { ...sch, hasChanges } }

      // Smart default: after all detection done, auto-select first changed file
      const update: Partial<DiffState> = { schematics: newSchematics }
      if (!s._schAutoSelectDone) {
        const allDone = s.schematicKeys.every((k) =>
          k === key ? hasChanges !== null : newSchematics[k]?.hasChanges !== null,
        )
        if (allDone) {
          const firstChanged = s.schematicKeys.find(
            (k) => newSchematics[k]?.hasChanges === true,
          )
          if (firstChanged) {
            update.activeSchematicKey = firstChanged
          }
          update._schAutoSelectDone = true
        }
      }
      return update
    }),

  // PCB layers
  pcbName: '',
  pcbLayers: [],
  pcbLayerPairs: {},
  selectedPcbLayers: [],
  togglePcbLayer: (layer) =>
    set((s) => {
      const sel = s.selectedPcbLayers.includes(layer)
        ? s.selectedPcbLayers.filter((l) => l !== layer)
        : [...s.selectedPcbLayers, layer]
      return { selectedPcbLayers: sel, _pcbAutoSelectDone: true }
    }),
  selectChangedPcbLayers: () =>
    set((s) => ({
      selectedPcbLayers: s.pcbLayers.filter(
        (l) => s.pcbLayerPairs[l]?.hasChanges === true,
      ),
      _pcbAutoSelectDone: true,
    })),
  deselectAllPcbLayers: () =>
    set({ selectedPcbLayers: [], _pcbAutoSelectDone: true }),
  updateLayerChanges: (layer, hasChanges) =>
    set((s) => {
      const lp = s.pcbLayerPairs[layer]
      if (!lp) return s
      const newPairs = { ...s.pcbLayerPairs, [layer]: { ...lp, hasChanges } }

      const update: Partial<DiffState> = { pcbLayerPairs: newPairs }
      if (!s._pcbAutoSelectDone) {
        const allDone = s.pcbLayers.every((l) =>
          l === layer ? hasChanges !== null : newPairs[l]?.hasChanges !== null,
        )
        if (allDone) {
          const changedLayers = s.pcbLayers.filter(
            (l) => newPairs[l]?.hasChanges === true,
          )
          if (changedLayers.length > 0) {
            update.selectedPcbLayers = changedLayers
          }
          // If none changed, keep all selected
          update._pcbAutoSelectDone = true
        }
      }
      return update
    }),

  // Smart default tracking: set to true once initial auto-selection completes
  _schAutoSelectDone: false,
  _pcbAutoSelectDone: false,

  // Versions
  pluginVersion: '',
  versionData: null,
  versionMap: {},
  oldRef: '',
  newRef: 'working',

  // UI
  locale: detectInitialLocale(),
  loading: true,
  loadingText: '',
  exportStatus: { key: '' },
  comparing: false,

  // Simple setters
  setViewMode: (mode) => set({ viewMode: mode }),
  setRawMode: (raw) => set({ rawMode: raw }),
  setZoom: (zoom) => set({ zoom }),
  setFade: (fade) => set({ fade }),
  setThresh: (thresh) => set({ thresh }),
  setOverlay: (overlay) => set({ overlay }),
  setBgColor: (bgColor) => set({ bgColor }),
  setOldRef: (ref) => set({ oldRef: ref }),
  setNewRef: (ref) => set({ newRef: ref }),

  toggleLocale: () =>
    set((s) => ({ locale: s.locale === 'zh' ? 'en' : 'zh' })),

  setLoading: (loading, text) =>
    set({ loading, loadingText: text ?? '' }),

  setExportStatus: (status) => set({ exportStatus: status }),

  initVersions: async () => {
    const { locale } = get()
    const t = (k: string) => translate(locale, k)
    try {
      const data = await fetchVersions()
      const map: VersionMap = {
        working: {
          ref: 'working',
          short_hash: t('working'),
          message: '',
          tags: '',
          time: '',
          is_working: true,
        },
      }
      for (const g of data.groups) {
        for (const c of g.commits) {
          map[c.ref] = c
        }
      }

      // Set default selections
      let defaultOld = ''
      const currentGroup = data.groups.find((g) => g.is_current)
      if (currentGroup && currentGroup.commits.length > 0) {
        defaultOld = currentGroup.commits[0].ref
      } else if (data.groups.length > 0 && data.groups[0].commits.length > 0) {
        defaultOld = data.groups[0].commits[0].ref
      }

      set({
        pluginVersion: data.plugin_version ?? '',
        versionData: data,
        versionMap: map,
        oldRef: defaultOld,
        newRef: 'working',
      })
    } catch (err) {
      console.error('Failed to fetch versions:', err)
    }
  },

  compare: async () => {
    const { oldRef, newRef, locale } = get()
    if (!oldRef || !newRef) {
      set({ loading: false })
      return
    }
    const t = (k: string) => translate(locale, k)

    set({ comparing: true, loading: true, loadingText: t('exporting') })

    try {
      let oldResult: ExportResult
      let newResult: ExportResult
      if (oldRef === newRef) {
        oldResult = await exportVersion(oldRef)
        newResult = oldResult
      } else {
        ;[oldResult, newResult] = await Promise.all([
          exportVersion(oldRef),
          exportVersion(newRef),
        ])
      }

      if (oldResult.status !== 'ok' || newResult.status !== 'ok') {
        set({
          exportStatus: { key: 'exportFailed' },
          loading: false,
          comparing: false,
        })
        return
      }

      // Build schematic file pairs
      const { keys: schKeys, files: schFiles } = buildFilePairs(
        oldResult,
        newResult,
      )

      // Build PCB layer pairs
      const { pcbName, layers, pairs } = buildLayerPairs(
        oldResult,
        newResult,
      )

      const hasPcb = layers.length > 0
      const hasSch = schKeys.length > 0

      if (!hasPcb && !hasSch) {
        set({
          schematicKeys: [],
          schematics: {},
          activeSchematicKey: '',
          pcbName: '',
          pcbLayers: [],
          pcbLayerPairs: {},
          selectedPcbLayers: [],
          sidebarTab: 'sch',
          exportStatus: { key: 'noKicadFiles' },
          loading: false,
          comparing: false,
          _schAutoSelectDone: false,
          _pcbAutoSelectDone: false,
        })
        return
      }

      set({
        // Schematics
        schematicKeys: schKeys,
        schematics: schFiles,
        activeSchematicKey: schKeys[0] ?? '',

        // PCB
        pcbName,
        pcbLayers: layers,
        pcbLayerPairs: pairs,
        selectedPcbLayers: [], // empty until change detection selects changed layers

        // Sidebar: prefer PCB tab when PCB layers exist
        sidebarTab: hasPcb ? 'pcb' : 'sch',

        // Reset smart default tracking
        _schAutoSelectDone: false,
        _pcbAutoSelectDone: false,

        exportStatus: { key: 'ready', oldCached: oldResult.cached, newCached: newResult.cached },
        loading: false,
        comparing: false,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({
        exportStatus: { key: 'exportError', message: msg },
        loading: false,
        comparing: false,
      })
    }
  },
}))
