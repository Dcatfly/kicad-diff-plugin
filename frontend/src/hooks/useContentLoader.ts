// ─── Async image loading ───
// Pure data loader: returns loaded images as state.
// Manages race conditions via token.  Does NOT call renderFrame.

import { useEffect, useRef, useState } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import type { ImageSource } from '../lib/renderer'
import { loadFilePair, loadLayerImageArrays } from './useImageLoader'

export interface ImagePair {
  imgOld: ImageSource
  imgNew: ImageSource
}

export function useContentLoader(): ImagePair | null {
  const renderTokenRef = useRef(0)
  const [images, setImages] = useState<ImagePair | null>(null)

  const sidebarTab = useDiffStore((s) => s.sidebarTab)

  // Stable selectors: extract only rendering-relevant primitive fields,
  // ignoring hasChanges to avoid re-loads when change detection updates.
  const oldSvg = useDiffStore((s) => {
    const sch = s.activeSchematicKey ? s.schematics[s.activeSchematicKey] : undefined
    return sch?.oldSvg ?? null
  })
  const newSvg = useDiffStore((s) => {
    const sch = s.activeSchematicKey ? s.schematics[s.activeSchematicKey] : undefined
    return sch?.newSvg ?? null
  })

  // For PCB: only subscribe to selectedPcbLayers (string[]) and read
  // pcbLayerPairs lazily inside the effect to avoid reference instability.
  const selectedPcbLayers = useDiffStore((s) => s.selectedPcbLayers)
  const setLoading = useDiffStore((s) => s.setLoading)

  useEffect(() => {
    const hasContent =
      sidebarTab === 'sch'
        ? (oldSvg !== null || newSvg !== null)
        : selectedPcbLayers.length > 0

    if (!hasContent) {
      setImages(null)
      return
    }

    const token = ++renderTokenRef.current
    let cancelled = false

    const doLoad = async () => {
      setLoading(true, '')

      try {
        let imgOld: ImageSource
        let imgNew: ImageSource

        if (sidebarTab === 'sch') {
          ;({ imgOld, imgNew } = await loadFilePair(oldSvg, newSvg))
        } else {
          // Read pcbLayerPairs lazily to avoid subscribing to its reference
          const pairs = useDiffStore.getState().pcbLayerPairs
          const activePairs = selectedPcbLayers
            .map((l) => pairs[l])
            .filter(Boolean)
          ;({ imgOld, imgNew } = await loadLayerImageArrays(activePairs))
        }
        if (cancelled || token !== renderTokenRef.current) return

        setImages({ imgOld, imgNew })
      } finally {
        if (!cancelled && token === renderTokenRef.current) {
          setLoading(false)
        }
      }
    }

    const rafId = requestAnimationFrame(() => {
      doLoad()
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [sidebarTab, oldSvg, newSvg, selectedPcbLayers, setLoading])

  return images
}
