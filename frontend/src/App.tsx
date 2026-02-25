import { useEffect } from 'react'
import { useDiffStore } from './stores/useDiffStore'
import { loadImg } from './hooks/useImageLoader'
import { detectChanges } from './lib/renderer'
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

  // Detect changes for schematic files
  useEffect(() => {
    if (schematicKeys.length === 0) return

    let cancelled = false
    const detectAll = async () => {
      for (const key of schematicKeys) {
        if (cancelled) return
        const f = useDiffStore.getState().schematics[key]
        if (!f) continue

        if (f.status === 'added' || f.status === 'deleted') {
          updateSchematicChanges(key, true)
          continue
        }

        if (!f.oldSvg || !f.newSvg) continue

        try {
          const [imgO, imgN] = await Promise.all([
            loadImg(f.oldSvg),
            loadImg(f.newSvg),
          ])
          if (cancelled) return
          const hasChanges = detectChanges(imgO, imgN, thresh)
          updateSchematicChanges(key, hasChanges)
        } catch {
          if (!cancelled) updateSchematicChanges(key, null)
        }
      }
    }

    detectAll()
    return () => { cancelled = true }
  }, [schematicKeys, thresh, updateSchematicChanges])

  // Detect changes for PCB layers
  useEffect(() => {
    if (pcbLayers.length === 0) return

    let cancelled = false
    const detectAll = async () => {
      for (const layer of pcbLayers) {
        if (cancelled) return
        const lp = useDiffStore.getState().pcbLayerPairs[layer]
        if (!lp) continue

        if (!lp.oldSvg || !lp.newSvg) {
          // Layer only exists on one side → has changes
          updateLayerChanges(layer, true)
          continue
        }

        try {
          const [imgO, imgN] = await Promise.all([
            loadImg(lp.oldSvg),
            loadImg(lp.newSvg),
          ])
          if (cancelled) return
          const hasChanges = detectChanges(imgO, imgN, thresh)
          updateLayerChanges(layer, hasChanges)
        } catch {
          if (!cancelled) updateLayerChanges(layer, null)
        }
      }
    }

    detectAll()
    return () => { cancelled = true }
  }, [pcbLayers, thresh, updateLayerChanges])

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
