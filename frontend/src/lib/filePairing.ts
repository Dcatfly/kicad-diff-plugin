// ─── File pairing logic: match old/new exported files ───

import type { ExportResult, FilePair, FileStatus } from '../types'

export function buildFilePairs(
  oldResult: ExportResult,
  newResult: ExportResult,
): { keys: string[]; files: Record<string, FilePair> } {
  const oldMap: Record<string, ExportResult['files'][number]> = {}
  for (const f of oldResult.files) oldMap[f.key] = f
  const newMap: Record<string, ExportResult['files'][number]> = {}
  for (const f of newResult.files) newMap[f.key] = f

  const allKeys = new Set([...Object.keys(oldMap), ...Object.keys(newMap)])
  const keys = [...allKeys].sort()

  const files: Record<string, FilePair> = {}
  for (const key of keys) {
    const oldFile = oldMap[key]
    const newFile = newMap[key]
    let status: FileStatus = 'modified'
    if (!oldFile) status = 'added'
    else if (!newFile) status = 'deleted'
    const src = newFile || oldFile
    files[key] = {
      type: src.type,
      name: src.name,
      oldSvg: oldFile ? oldFile.svg : null,
      newSvg: newFile ? newFile.svg : null,
      status,
      hasChanges: null,
    }
  }

  return { keys, files }
}
