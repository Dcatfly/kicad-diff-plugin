// ─── Canvas rendering orchestration (composition layer) ───
// Delegates to single-responsibility hooks:
//   useHiResOverlay   — debounced hi-res viewport overlay
//   useRenderPipeline — cached pixel render pipeline
//   useContentLoader  — async image loading (pure data)
//   usePanZoom        — wheel zoom + drag pan (CSS transform-based)

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import type { ImageSource } from '../lib/renderer'
import { applyZoom, computeDiffBounds, computeAutoFit } from '../lib/renderer'
import { usePanZoom, clampPan, type PanState } from './usePanZoom'
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
  const panRef = useRef<PanState>({ x: 0, y: 0 })
  const pendingPanRef = useRef<PanState | null>(null)
  const contentDimsRef = useRef<{ natW: number; natH: number } | null>(null)
  const imagesRef = useRef<{ imgOld: ImageSource; imgNew: ImageSource } | null>(null)
  const lastResetTokenRef = useRef(useDiffStore.getState()._panResetToken)

  // ─── Hi-res overlay (needs panRef) ───

  const { hiResRef, hiResLRef, hiResRRef, hideHiRes, scheduleHiRes } =
    useHiResOverlay({ containerRef, leftPanelRef, imagesRef, contentDimsRef, panRef })

  // ─── applyPan: set CSS transform on all canvases + trigger hi-res ───

  const applyPan = useCallback(() => {
    const { x, y } = panRef.current
    const transform = `translate(${-x}px, ${-y}px)`
    for (const ref of [canvasRef, canvasLRef, canvasRRef]) {
      if (ref?.current) ref.current.style.transform = transform
    }
    scheduleHiRes()
  }, [canvasRef, canvasLRef, canvasRRef, scheduleHiRes])

  // ─── Pan + zoom interaction ───

  usePanZoom(containerRef, panRef, pendingPanRef, contentDimsRef, applyPan, leftPanelRef, rightPanelRef)

  // ─── Render pipeline ───

  const { renderFrame, invalidateCaches } =
    useRenderPipeline({ canvasRef, canvasLRef, canvasRRef, imagesRef,
      contentDimsRef, scheduleHiRes })

  // ─── Content loading → render orchestration ───

  const images = useContentLoader()

  useEffect(() => {
    if (images) {
      // New images loaded — update ref, invalidate caches, render
      imagesRef.current = images
      invalidateCaches()
      renderFrame()
      // Only reset pan when the reset token has changed (new compare, schematic switch, tab switch)
      const currentToken = useDiffStore.getState()._panResetToken
      if (currentToken !== lastResetTokenRef.current) {
        lastResetTokenRef.current = currentToken
        const dims = contentDimsRef.current
        const state = useDiffStore.getState()
        const clampEl = (state.viewMode === 'side' && leftPanelRef?.current)
          ? leftPanelRef.current : containerRef.current

        if (dims && clampEl && clampEl.clientWidth > 0) {
          const { imgOld, imgNew } = images
          const bounds = computeDiffBounds(imgOld, imgNew, state.thresh)
          const { zoom: fitZoom, pan: fitPan } = computeAutoFit(
            bounds, dims.natW, dims.natH, clampEl.clientWidth, clampEl.clientHeight
          )
          const clamped = clampPan(fitPan, dims, fitZoom, clampEl)
          panRef.current = clamped
          pendingPanRef.current = clamped
          state.setZoom(fitZoom)
        } else {
          panRef.current = { x: 0, y: 0 }
        }
      }
      applyPan()
    } else {
      // No content — clear everything
      imagesRef.current = null
      contentDimsRef.current = null
      invalidateCaches()
      hideHiRes()
      panRef.current = { x: 0, y: 0 }
      for (const ref of [canvasRef, canvasLRef, canvasRRef]) {
        const cvs = ref?.current
        if (cvs) {
          cvs.width = 0
          cvs.height = 0
          cvs.style.width = ''
          cvs.style.height = ''
          cvs.style.transform = ''
        }
      }
    }
  }, [images, canvasRef, canvasLRef, canvasRRef, renderFrame, invalidateCaches, hideHiRes, applyPan, containerRef, leftPanelRef])

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

    // Consume pending pan from wheel zoom, or clamp existing pan
    const pending = pendingPanRef.current
    if (pending) {
      pendingPanRef.current = null
      panRef.current = pending
    } else {
      const state = useDiffStore.getState()
      const clampEl = (state.viewMode === 'side' && leftPanelRef?.current)
        ? leftPanelRef.current
        : containerRef.current
      panRef.current = clampPan(panRef.current, dims, zoom, clampEl)
    }

    applyPan()
  }, [zoom, viewMode, canvasRef, canvasLRef, canvasRRef, applyPan, containerRef, leftPanelRef])

  return { hiResRef, hiResLRef, hiResRRef }
}
