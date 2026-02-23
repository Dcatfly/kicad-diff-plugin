// ─── KiCad Diff Viewer Types ───

export type ViewMode = 'diff' | 'side' | 'overlay'

export type FileStatus = 'added' | 'deleted' | 'modified'

export type FileType = 'sch' | 'pcb'

export type Locale = 'zh' | 'en'

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

export interface ExportResult {
  status: 'ok' | 'error'
  ref: string
  cached: boolean
  files: ExportFile[]
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

export interface VersionMap {
  [ref: string]: Commit & { is_working?: boolean }
}
