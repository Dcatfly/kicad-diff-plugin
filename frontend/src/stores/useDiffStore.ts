// ─── Zustand store: global state for the diff viewer ───

import { create } from 'zustand'
import type {
  ViewMode,
  Locale,
  VersionData,
  VersionMap,
  FilePair,
  ExportResult,
} from '../types'
import { fetchVersions, exportVersion } from '../lib/api'
import { buildFilePairs } from '../lib/filePairing'
import { translate } from '../lib/i18n'

interface DiffState {
  // View
  viewMode: ViewMode
  rawMode: boolean
  zoom: number
  fade: number
  thresh: number
  overlay: number

  // Files
  activeFileKey: string
  fileKeys: string[]
  files: Record<string, FilePair>

  // Versions
  versionData: VersionData | null
  versionMap: VersionMap
  oldRef: string
  newRef: string

  // UI
  locale: Locale
  loading: boolean
  loadingText: string
  exportStatus: string
  comparing: boolean

  // Actions
  setViewMode: (mode: ViewMode) => void
  setRawMode: (raw: boolean) => void
  setZoom: (zoom: number) => void
  setFade: (fade: number) => void
  setThresh: (thresh: number) => void
  setOverlay: (overlay: number) => void
  setActiveFileKey: (key: string) => void
  setOldRef: (ref: string) => void
  setNewRef: (ref: string) => void
  toggleLocale: () => void
  setLoading: (loading: boolean, text?: string) => void
  setExportStatus: (status: string) => void
  updateFileChanges: (key: string, hasChanges: boolean | null) => void
  initVersions: () => Promise<void>
  compare: () => Promise<void>
}

const detectInitialLocale = (): Locale =>
  (navigator.language || '').startsWith('zh') ? 'zh' : 'en'

export const useDiffStore = create<DiffState>((set, get) => ({
  // View defaults
  viewMode: 'diff',
  rawMode: false,
  zoom: 100,
  fade: 85,
  thresh: 20,
  overlay: 50,

  // Files
  activeFileKey: '',
  fileKeys: [],
  files: {},

  // Versions
  versionData: null,
  versionMap: {},
  oldRef: '',
  newRef: 'working',

  // UI
  locale: detectInitialLocale(),
  loading: false,
  loadingText: '',
  exportStatus: '',
  comparing: false,

  // Simple setters
  setViewMode: (mode) => set({ viewMode: mode }),
  setRawMode: (raw) => set({ rawMode: raw }),
  setZoom: (zoom) => set({ zoom }),
  setFade: (fade) => set({ fade }),
  setThresh: (thresh) => set({ thresh }),
  setOverlay: (overlay) => set({ overlay }),
  setActiveFileKey: (key) => set({ activeFileKey: key }),
  setOldRef: (ref) => set({ oldRef: ref }),
  setNewRef: (ref) => set({ newRef: ref }),

  toggleLocale: () =>
    set((s) => ({ locale: s.locale === 'zh' ? 'en' : 'zh' })),

  setLoading: (loading, text) =>
    set({ loading, loadingText: text ?? '' }),

  setExportStatus: (status) => set({ exportStatus: status }),

  updateFileChanges: (key, hasChanges) =>
    set((s) => {
      const file = s.files[key]
      if (!file) return s
      return {
        files: { ...s.files, [key]: { ...file, hasChanges } },
      }
    }),

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
    if (!oldRef || !newRef) return
    const t = (k: string) => translate(locale, k)

    set({ comparing: true, loading: true, loadingText: t('exporting') })

    try {
      let oldResult: ExportResult
      let newResult: ExportResult
      if (oldRef === newRef) {
        // Same ref (e.g. working vs working): export once, reuse result
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
          exportStatus: t('exportFailed'),
          loading: false,
          comparing: false,
        })
        return
      }

      const { keys, files } = buildFilePairs(
        oldResult,
        newResult,
      )

      if (keys.length === 0) {
        set({
          fileKeys: [],
          files: {},
          activeFileKey: '',
          exportStatus: t('noKicadFiles'),
          loading: false,
          comparing: false,
        })
        return
      }

      const oldCached = oldResult.cached ? ` ${t('cached')}` : ''
      const newCached = newResult.cached ? ` ${t('cached')}` : ''

      set({
        fileKeys: keys,
        files,
        activeFileKey: keys[0],
        exportStatus: `${t('ready')}${oldCached}${newCached}`,
        loading: false,
        comparing: false,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({
        exportStatus: `${t('exportError')}: ${msg}`,
        loading: false,
        comparing: false,
      })
    }
  },
}))
