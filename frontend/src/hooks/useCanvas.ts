// ─── Canvas rendering orchestration (composition layer) ───
// Delegates to single-responsibility hooks:
//   useHiResOverlay   — debounced hi-res viewport overlay
//   useRenderPipeline — cached pixel render pipeline
//   useContentLoader  — async image loading (pure data)
//   usePanZoom        — wheel zoom + drag pan

import { useEffect, useLayoutEffect, useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import type { ImageSource } from '../lib/renderer'
import { applyZoom } from '../lib/renderer'
import { usePanZoom, consumePendingScroll, type PendingScroll } from './usePanZoom'
import { useHiResOverlay } from './useHiResOverlay'
import { useRenderPipeline } from './useRenderPipeline'
import { useContentLoader } from './useContentLoader'

export interface HiResRefs {
  hiResRef: React.RefObject<HTMLCanvasElement | null>
  hiResLRef: React.RefObject<HTMLCanvasElement | null>
  hiResRRef: React.RefObject<HTMLCanvasElement | null>
}

export function useCanvas(
  containerRef: React.RefObject<HTMLElement | null>,
  canvasRef?: React.RefObject<HTMLCanvasElement | null>,
  canvasLRef?: React.RefObject<HTMLCanvasElement | null>,
  canvasRRef?: React.RefObject<HTMLCanvasElement | null>,
  leftPanelRef?: React.RefObject<HTMLElement | null>,
  rightPanelRef?: React.RefObject<HTMLElement | null>,
): HiResRefs {
  const pendingScrollRef = useRef<PendingScroll | null>(null)
  const contentDimsRef = useRef<{ natW: number; natH: number } | null>(null)
  const imagesRef = useRef<{ imgOld: ImageSource; imgNew: ImageSource } | null>(null)

  usePanZoom(containerRef, pendingScrollRef, leftPanelRef, rightPanelRef)

  const { hiResRef, hiResLRef, hiResRRef, hideHiRes, scheduleHiRes } =
    useHiResOverlay({ containerRef, leftPanelRef, rightPanelRef, imagesRef, contentDimsRef })

  const { renderFrame, invalidateCaches } =
    useRenderPipeline({ canvasRef, canvasLRef, canvasRRef, imagesRef,
      contentDimsRef, pendingScrollRef, scheduleHiRes })

  // ─── Content loading → render orchestration ───

  const images = useContentLoader()

  useEffect(() => {
    if (images) {
      // New images loaded — update ref, invalidate caches, render
      imagesRef.current = images
      invalidateCaches()
      renderFrame()
    } else {
      // No content — clear everything
      imagesRef.current = null
      contentDimsRef.current = null
      invalidateCaches()
      hideHiRes()
      for (const ref of [canvasRef, canvasLRef, canvasRRef]) {
        const cvs = ref?.current
        if (cvs) {
          cvs.width = 0
          cvs.height = 0
          cvs.style.width = ''
          cvs.style.height = ''
        }
      }
    }
  }, [images, canvasRef, canvasLRef, canvasRRef, renderFrame, invalidateCaches, hideHiRes])

  // ─── Effect C: Zoom (CSS-only, instant) ───

  const zoom = useDiffStore((s) => s.zoom)
  const viewMode = useDiffStore((s) => s.viewMode)

  useLayoutEffect(() => {
    const dims = contentDimsRef.current
    if (!dims) return

    if (viewMode === 'diff' || viewMode === 'overlay') {
      if (canvasRef?.current) applyZoom(canvasRef.current, dims.natW, dims.natH, zoom)
    } else if (viewMode === 'side') {
      if (canvasLRef?.current) applyZoom(canvasLRef.current, dims.natW, dims.natH, zoom)
      if (canvasRRef?.current) applyZoom(canvasRRef.current, dims.natW, dims.natH, zoom)
    }

    consumePendingScroll(pendingScrollRef)

    scheduleHiRes()
  }, [zoom, viewMode, canvasRef, canvasLRef, canvasRRef, scheduleHiRes])

  return { hiResRef, hiResLRef, hiResRRef }
}
