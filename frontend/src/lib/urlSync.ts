// ─── URL parameter sync for version refs ───

/** Read oldRef / newRef from URL search params */
export function readUrlRefs(): { oldRef?: string; newRef?: string } {
  const params = new URLSearchParams(window.location.search)
  const oldRef = params.get('oldRef') ?? undefined
  const newRef = params.get('newRef') ?? undefined
  return { oldRef, newRef }
}

/** Write oldRef / newRef to URL via replaceState (no browser history entry) */
export function writeUrlRefs(oldRef: string, newRef: string): void {
  const params = new URLSearchParams(window.location.search)
  params.set('oldRef', oldRef)
  params.set('newRef', newRef)
  const url = `${window.location.pathname}?${params.toString()}`
  history.replaceState(null, '', url)
}

/** Remove version params from URL */
export function clearUrlRefs(): void {
  const params = new URLSearchParams(window.location.search)
  params.delete('oldRef')
  params.delete('newRef')
  const qs = params.toString()
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
  history.replaceState(null, '', url)
}
