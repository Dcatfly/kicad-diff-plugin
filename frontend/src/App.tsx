import { useEffect } from 'react'
import { useDiffStore } from './stores/useDiffStore'
import { loadImg } from './hooks/useImageLoader'
import { detectChanges } from './lib/renderer'
import Header from './components/Header'
import VersionBar from './components/VersionBar'
import Toolbar from './components/Toolbar'
import DiffCanvas from './components/DiffCanvas'
import SideBySideView from './components/SideBySideView'
import Legend from './components/Legend'

function App() {
  const viewMode = useDiffStore((s) => s.viewMode)
  const fileKeys = useDiffStore((s) => s.fileKeys)
  const initVersions = useDiffStore((s) => s.initVersions)
  const compare = useDiffStore((s) => s.compare)
  const updateFileChanges = useDiffStore((s) => s.updateFileChanges)

  // Initialize versions and trigger first compare
  useEffect(() => {
    const init = async () => {
      await initVersions()
      await compare()
    }
    init()
  }, [initVersions, compare])

  // Detect changes for file tabs after compare completes
  useEffect(() => {
    if (fileKeys.length === 0) return

    let cancelled = false
    const detectAll = async () => {
      for (const key of fileKeys) {
        if (cancelled) return
        const f = useDiffStore.getState().files[key]
        if (!f) continue

        if (f.status === 'added' || f.status === 'deleted') {
          updateFileChanges(key, true)
          continue
        }

        if (!f.oldSvg || !f.newSvg) continue

        try {
          const [imgO, imgN] = await Promise.all([
            loadImg(f.oldSvg),
            loadImg(f.newSvg),
          ])
          if (cancelled) return
          const hasChanges = detectChanges(imgO, imgN)
          updateFileChanges(key, hasChanges)
        } catch {
          if (!cancelled) updateFileChanges(key, null)
        }
      }
    }

    detectAll()
    return () => { cancelled = true }
  }, [fileKeys, updateFileChanges])

  return (
    <>
      <Header />
      <VersionBar />
      <Toolbar />
      <div className="flex-1 flex overflow-hidden relative">
        {viewMode === 'side' ? <SideBySideView /> : <DiffCanvas />}
      </div>
      <Legend />
    </>
  )
}

export default App
