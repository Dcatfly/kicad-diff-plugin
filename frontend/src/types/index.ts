// ─── KiCad Diff Viewer Types ───

export type ViewMode = 'diff' | 'side' | 'overlay'

export type FileStatus = 'added' | 'deleted' | 'modified'

export type FileType = 'sch' | 'pcb'

export type Locale = 'zh' | 'en'

export type SidebarTab = 'pcb' | 'sch'

export interface Commit {
  ref: string
  short_hash: string
  message: string
  tags: string
  time: string
}

export interface BranchGroup {
  branch: string
  is_current: boolean
  commits: Commit[]
}

export interface VersionData {
  current_branch: string
  groups: BranchGroup[]
}

export interface ExportFile {
  key: string
  name: string
  type: FileType
  svg: string
}

export interface PcbLayerFile {
  layer: string
  svg: string
}

export interface ExportResult {
  status: 'ok' | 'error'
  ref: string
  cached: boolean
  files: ExportFile[]
  pcb_layers?: Record<string, PcbLayerFile[]>
  message?: string
}

export interface FilePair {
  type: FileType
  name: string
  oldSvg: string | null
  newSvg: string | null
  status: FileStatus
  hasChanges: boolean | null
}

export interface LayerPair {
  layer: string
  pcbName: string
  oldSvg: string | null
  newSvg: string | null
  hasChanges: boolean | null
}

export interface VersionMap {
  [ref: string]: Commit & { is_working?: boolean }
}

export interface ExportStatus {
  key: string // '' | 'ready' | 'exportFailed' | 'exportError' | 'noKicadFiles'
  message?: string
  oldCached?: boolean
  newCached?: boolean
}
