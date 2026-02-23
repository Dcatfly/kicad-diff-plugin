// ─── API client: fetch versions & export ───

import type { VersionData, ExportResult } from '../types'

export async function fetchVersions(): Promise<VersionData> {
  const resp = await fetch('/api/versions')
  if (!resp.ok) throw new Error(`Failed to fetch versions: ${resp.status}`)
  return resp.json()
}

export async function exportVersion(ref: string): Promise<ExportResult> {
  const resp = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref }),
  })
  if (!resp.ok) throw new Error(`Export failed: ${resp.status}`)
  return resp.json()
}
