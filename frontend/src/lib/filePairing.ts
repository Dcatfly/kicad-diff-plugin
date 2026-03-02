// ─── File pairing logic: match old/new exported files and PCB layers ───

import type { ExportResult, FilePair, FileStatus, LayerPair } from '../types'

/** Pair schematic files from old/new export results. */
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
      oldContentHash: oldFile?.contentHash,
      newContentHash: newFile?.contentHash,
      status,
      hasChanges: null,
    }
  }

  return { keys, files }
}

/** Pair PCB layers from old/new export results. */
export function buildLayerPairs(
  oldResult: ExportResult | null,
  newResult: ExportResult | null,
): { pcbName: string; layers: string[]; pairs: Record<string, LayerPair> } {
  const oldLayers = oldResult?.pcb_layers ?? {}
  const newLayers = newResult?.pcb_layers ?? {}

  // NOTE: Only the first PCB board is used. Multi-board projects are not
  // yet supported — additional boards in pcb_layers will be ignored.
  const allNames = new Set([...Object.keys(oldLayers), ...Object.keys(newLayers)])
  const pcbName = [...allNames][0] ?? ''

  if (!pcbName) {
    return { pcbName: '', layers: [], pairs: {} }
  }

  const oldByLayer: Record<string, { svg: string; contentHash?: string }> = {}
  for (const f of oldLayers[pcbName] ?? []) oldByLayer[f.layer] = { svg: f.svg, contentHash: f.contentHash }
  const newByLayer: Record<string, { svg: string; contentHash?: string }> = {}
  for (const f of newLayers[pcbName] ?? []) newByLayer[f.layer] = { svg: f.svg, contentHash: f.contentHash }

  const allLayerSet = new Set([...Object.keys(oldByLayer), ...Object.keys(newByLayer)])
  const layers = [...allLayerSet]

  const pairs: Record<string, LayerPair> = {}
  for (const layer of layers) {
    pairs[layer] = {
      layer,
      pcbName,
      oldSvg: oldByLayer[layer]?.svg ?? null,
      newSvg: newByLayer[layer]?.svg ?? null,
      oldContentHash: oldByLayer[layer]?.contentHash,
      newContentHash: newByLayer[layer]?.contentHash,
      hasChanges: null,
    }
  }

  return { pcbName, layers, pairs }
}
