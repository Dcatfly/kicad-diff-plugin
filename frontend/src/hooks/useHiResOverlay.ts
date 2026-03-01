// ─── Hi-res viewport overlay management ───
// Debounced pixel-perfect viewport rendering after pan/zoom stabilises.
// Uses GLRenderer with UV sub-region for GPU-accelerated viewport rendering.

import { useCallback, useEffect, useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import type { ImageSource } from '../lib/renderer'
import { DPR } from '../lib/renderer'
import { GLRenderer, ensureGL } from '../lib/glRenderer'
import { HI_RES_DEBOUNCE_MS } from '../lib/constants'
import { useDebounceScheduler } from '../lib/scheduling'
import type { PanState } from './usePanZoom'

export interface UseHiResOverlayOptions {
  containerRef: React.RefObject<HTMLElement | null>
  leftPanelRef?: React.RefObject<HTMLElement | null>
  imagesRef: React.RefObject<{ imgOld: ImageSource; imgNew: ImageSource } | null>
  contentDimsRef: React.RefObject<{ natW: number; natH: number } | null>
  panRef: React.RefObject<PanState>
}

export interface UseHiResOverlayReturn {
  hiResRef: React.RefObject<HTMLCanvasElement | null>
  hiResLRef: React.RefObject<HTMLCanvasElement | null>
  hiResRRef: React.RefObject<HTMLCanvasElement | null>
  hideHiRes: () => void
  scheduleHiRes: () => void
}

export function useHiResOverlay({
  containerRef,
  leftPanelRef,
  imagesRef,
  contentDimsRef,
  panRef,
}: UseHiResOverlayOptions): UseHiResOverlayReturn {
  const hiResRef = useRef<HTMLCanvasElement>(null)
  const hiResLRef = useRef<HTMLCanvasElement>(null)
  const hiResRRef = useRef<HTMLCanvasElement>(null)

  // GLRenderer instances for hi-res canvases
  const hiResGlRef = useRef<GLRenderer | null>(null)
  const hiResGlLRef = useRef<GLRenderer | null>(null)
  const hiResGlRRef = useRef<GLRenderer | null>(null)

  const hideHiRes = useCallback(() => {
    for (const ref of [hiResRef, hiResLRef, hiResRRef]) {
      if (ref.current) ref.current.style.display = 'none'
    }
  }, [])

  const showHiRes = useCallback((ref: React.RefObject<HTMLCanvasElement | null>) => {
    if (ref.current) ref.current.style.display = 'block'
  }, [])

  // Debounced hi-res render — fires HI_RES_DEBOUNCE_MS after last call
  const [debouncedRender] = useDebounceScheduler(() => {
    const dims = contentDimsRef.current
    const images = imagesRef.current
    if (!dims || !images) return

    const state = useDiffStore.getState()

    // Use the container (or left panel in side mode) for viewport dimensions
    const viewportEl =
      state.viewMode === 'side'
        ? leftPanelRef?.current
        : containerRef.current
    if (!viewportEl) return

    const scale = state.zoom / 100
    const panX = panRef.current.x
    const panY = panRef.current.y
    const srcX = panX / scale
    const srcY = panY / scale
    const srcW = viewportEl.clientWidth / scale
    const srcH = viewportEl.clientHeight / scale

    // Clamp source rect to image bounds — only render the overlap
    const cx0 = Math.max(0, srcX)
    const cy0 = Math.max(0, srcY)
    const cx1 = Math.min(dims.natW, srcX + srcW)
    const cy1 = Math.min(dims.natH, srcY + srcH)
    const cw = cx1 - cx0
    const ch = cy1 - cy0
    if (cw <= 0 || ch <= 0) return

    // Hi-res canvas offset & size in CSS pixels
    // Since the hi-res canvas sits inside overflow-hidden container (not transformed),
    // position it relative to the viewport — no scroll offset needed.
    const offsetX = (cx0 - srcX) * scale
    const offsetY = (cy0 - srcY) * scale
    const cssW = Math.round(cw * scale)
    const cssH = Math.round(ch * scale)
    const vpPw = Math.round(cssW * DPR)
    const vpPh = Math.round(cssH * DPR)

    // Position a hi-res canvas within its container
    const layoutCanvas = (canvas: HTMLCanvasElement) => {
      canvas.style.left = offsetX + 'px'
      canvas.style.top = offsetY + 'px'
      canvas.style.width = cssW + 'px'
      canvas.style.height = cssH + 'px'
    }

    if ((state.viewMode === 'diff' || state.viewMode === 'overlay') && hiResRef.current) {
      layoutCanvas(hiResRef.current)

      const gl = ensureGL(hiResGlRef, hiResRef.current)
      gl.uploadPairRegion(images.imgOld, images.imgNew, cx0, cy0, cw, ch, vpPw, vpPh)
      gl.setSize(vpPw, vpPh)
      gl.resetViewport()
      if (state.viewMode === 'diff') {
        gl.renderDiff(state.thresh, state.fade, state.bgColor)
      } else {
        gl.renderOverlay(state.thresh, state.overlay, state.bgColor)
      }

      showHiRes(hiResRef)
    } else if (state.viewMode === 'side' && hiResLRef.current && hiResRRef.current) {
      layoutCanvas(hiResLRef.current)
      layoutCanvas(hiResRRef.current)

      const glL = ensureGL(hiResGlLRef, hiResLRef.current)
      const glR = ensureGL(hiResGlRRef, hiResRRef.current)

      if (state.rawMode) {
        glL.uploadSingleRegion(images.imgOld, cx0, cy0, cw, ch, vpPw, vpPh)
        glR.uploadSingleRegion(images.imgNew, cx0, cy0, cw, ch, vpPw, vpPh)
      } else {
        glL.uploadPairRegion(images.imgOld, images.imgNew, cx0, cy0, cw, ch, vpPw, vpPh)
        glR.uploadPairRegion(images.imgOld, images.imgNew, cx0, cy0, cw, ch, vpPw, vpPh)
      }

      glL.setSize(vpPw, vpPh)
      glR.setSize(vpPw, vpPh)
      glL.resetViewport()
      glR.resetViewport()

      if (state.rawMode) {
        glL.renderRaw(state.bgColor)
        glR.renderRaw(state.bgColor)
      } else {
        glL.renderSideAnnotated(state.thresh, state.fade, state.bgColor, true)
        glR.renderSideAnnotated(state.thresh, state.fade, state.bgColor, false)
      }

      showHiRes(hiResLRef)
      showHiRes(hiResRRef)
    }
  }, HI_RES_DEBOUNCE_MS)

  // scheduleHiRes: hide overlay immediately, then schedule debounced re-render
  const scheduleHiRes = useCallback(() => {
    hideHiRes()
    debouncedRender()
  }, [hideHiRes, debouncedRender])

  // ─── Cleanup: dispose hi-res GLRenderers on unmount ───

  useEffect(() => {
    return () => {
      hiResGlRef.current?.dispose()
      hiResGlLRef.current?.dispose()
      hiResGlRRef.current?.dispose()
      hiResGlRef.current = null
      hiResGlLRef.current = null
      hiResGlRRef.current = null
    }
  }, [])

  return { hiResRef, hiResLRef, hiResRRef, hideHiRes, scheduleHiRes }
}
