import { useEffect, useRef } from 'react'
import { useDiffStore } from './stores/useDiffStore'
import { loadImg } from './hooks/useImageLoader'
import { detectChanges } from './lib/renderer'
import { useDebounceScheduler, parallelMap } from './lib/scheduling'
import Header from './components/Header'
import Toolbar from './components/Toolbar'
import Sidebar from './components/Sidebar'
import DiffCanvas from './components/DiffCanvas'
import SideBySideView from './components/SideBySideView'
import Legend from './components/Legend'

function App() {
  const viewMode = useDiffStore((s) => s.viewMode)
  const initVersions = useDiffStore((s) => s.initVersions)
  const compare = useDiffStore((s) => s.compare)

  // Schematic change detection deps
  const schematicKeys = useDiffStore((s) => s.schematicKeys)
  const updateSchematicChanges = useDiffStore((s) => s.updateSchematicChanges)

  // PCB layer change detection deps
  const pcbLayers = useDiffStore((s) => s.pcbLayers)
  const updateLayerChanges = useDiffStore((s) => s.updateLayerChanges)

  // Shared threshold for change detection (syncs with toolbar slider)
  const thresh = useDiffStore((s) => s.thresh)

  // Initialize versions and trigger first compare
  useEffect(() => {
    const init = async () => {
      await initVersions()
      await compare()
    }
    init()
  }, [initVersions, compare])

  // ─── Debounced change detection ───

  // Cancellation token for in-flight async detection work
  const schCancelRef = useRef<() => void>(() => {})
  const pcbCancelRef = useRef<() => void>(() => {})

  const [scheduleSchDetect, cancelSchTimer] = useDebounceScheduler(() => {
    schCancelRef.current()
    let cancelled = false
    schCancelRef.current = () => { cancelled = true }

    const keys = useDiffStore.getState().schematicKeys
    if (keys.length === 0) return

    parallelMap(keys, async (key) => {
      const f = useDiffStore.getState().schematics[key]
      if (!f) return

      if (f.status === 'added' || f.status === 'deleted') {
        updateSchematicChanges(key, true)
        return
      }

      if (!f.oldSvg || !f.newSvg) return

      // Skip pixel diff when content hashes match
      if (f.oldContentHash && f.newContentHash && f.oldContentHash === f.newContentHash) {
        updateSchematicChanges(key, false)
        return
      }

      try {
        const [imgO, imgN] = await Promise.all([
          loadImg(f.oldSvg),
          loadImg(f.newSvg),
        ])
        if (cancelled) return
        const hasChanges = detectChanges(imgO, imgN, useDiffStore.getState().thresh)
        updateSchematicChanges(key, hasChanges)
      } catch {
        if (!cancelled) updateSchematicChanges(key, null)
      }
    }, { concurrency: 6, isCancelled: () => cancelled })
  }, 300)

  const [schedulePcbDetect, cancelPcbTimer] = useDebounceScheduler(() => {
    pcbCancelRef.current()
    let cancelled = false
    pcbCancelRef.current = () => { cancelled = true }

    const layers = useDiffStore.getState().pcbLayers
    if (layers.length === 0) return

    parallelMap(layers, async (layer) => {
      const lp = useDiffStore.getState().pcbLayerPairs[layer]
      if (!lp) return

      if (!lp.oldSvg || !lp.newSvg) {
        updateLayerChanges(layer, true)
        return
      }

      // Skip pixel diff when content hashes match
      if (lp.oldContentHash && lp.newContentHash && lp.oldContentHash === lp.newContentHash) {
        updateLayerChanges(layer, false)
        return
      }

      try {
        const [imgO, imgN] = await Promise.all([
          loadImg(lp.oldSvg),
          loadImg(lp.newSvg),
        ])
        if (cancelled) return
        const hasChanges = detectChanges(imgO, imgN, useDiffStore.getState().thresh)
        updateLayerChanges(layer, hasChanges)
      } catch {
        if (!cancelled) updateLayerChanges(layer, null)
      }
    }, { concurrency: 4, isCancelled: () => cancelled })
  }, 300)

  // Trigger debounced detection when deps change
  useEffect(() => {
    if (schematicKeys.length > 0) scheduleSchDetect()
    return () => { cancelSchTimer(); schCancelRef.current() }
  }, [schematicKeys, thresh, scheduleSchDetect, cancelSchTimer])

  useEffect(() => {
    if (pcbLayers.length > 0) schedulePcbDetect()
    return () => { cancelPcbTimer(); pcbCancelRef.current() }
  }, [pcbLayers, thresh, schedulePcbDetect, cancelPcbTimer])

  return (
    <>
      <Header />
      <Toolbar />
      <div className="flex-1 flex overflow-hidden relative">
        <Sidebar />
        {viewMode === 'side' ? <SideBySideView /> : <DiffCanvas />}
      </div>
      <Legend />
    </>
  )
}

export default App
