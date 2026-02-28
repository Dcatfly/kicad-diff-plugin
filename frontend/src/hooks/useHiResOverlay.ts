// ─── Hi-res viewport overlay management ───
// Debounced pixel-perfect viewport rendering after scroll/zoom stabilises.
// Uses GLRenderer with UV sub-region for GPU-accelerated viewport rendering.

import { useCallback, useEffect, useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import type { ImageSource } from '../lib/renderer'
import { DPR } from '../lib/renderer'
import { GLRenderer, ensureGL } from '../lib/glRenderer'
import { HI_RES_DEBOUNCE_MS } from '../lib/constants'
import { useDebounceScheduler } from '../lib/scheduling'

export interface UseHiResOverlayOptions {
  containerRef: React.RefObject<HTMLElement | null>
  leftPanelRef?: React.RefObject<HTMLElement | null>
  rightPanelRef?: React.RefObject<HTMLElement | null>
  imagesRef: React.RefObject<{ imgOld: ImageSource; imgNew: ImageSource } | null>
  contentDimsRef: React.RefObject<{ natW: number; natH: number } | null>
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
  rightPanelRef,
  imagesRef,
  contentDimsRef,
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

    const scrollEl =
      state.viewMode === 'side'
        ? leftPanelRef?.current
        : containerRef.current
    if (!scrollEl) return

    const scale = state.zoom / 100
    const srcX = scrollEl.scrollLeft / scale
    const srcY = scrollEl.scrollTop / scale
    const srcW = scrollEl.clientWidth / scale
    const srcH = scrollEl.clientHeight / scale

    // Clamp source rect to image bounds — only render the overlap
    const cx0 = Math.max(0, srcX)
    const cy0 = Math.max(0, srcY)
    const cx1 = Math.min(dims.natW, srcX + srcW)
    const cy1 = Math.min(dims.natH, srcY + srcH)
    const cw = cx1 - cx0
    const ch = cy1 - cy0
    if (cw <= 0 || ch <= 0) return

    // Hi-res canvas offset & size in CSS pixels
    const offsetX = (cx0 - srcX) * scale
    const offsetY = (cy0 - srcY) * scale
    const cssW = Math.round(cw * scale)
    const cssH = Math.round(ch * scale)
    const vpPw = Math.round(cssW * DPR)
    const vpPh = Math.round(cssH * DPR)

    // Hi-res viewport renders the visible sub-region rasterized at the
    // viewport's full physical pixel resolution (vpPw × vpPh). The
    // texture covers the entire output canvas (resetViewport), so there
    // is no UV-based upscaling — Canvas 2D's high-quality resampling
    // handles the zoom, giving pixel-perfect sharpness at any level.

    // Position a hi-res canvas over its scroll container
    const layoutCanvas = (canvas: HTMLCanvasElement, scrollLeft: number, scrollTop: number) => {
      canvas.style.left = (scrollLeft + offsetX) + 'px'
      canvas.style.top = (scrollTop + offsetY) + 'px'
      canvas.style.width = cssW + 'px'
      canvas.style.height = cssH + 'px'
    }

    if ((state.viewMode === 'diff' || state.viewMode === 'overlay') && hiResRef.current) {
      layoutCanvas(hiResRef.current, scrollEl.scrollLeft, scrollEl.scrollTop)

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
      // Batch all layout reads before any style writes to avoid layout thrashing
      const rightScrollEl = rightPanelRef?.current
      const leftScrollLeft = scrollEl.scrollLeft
      const leftScrollTop = scrollEl.scrollTop
      const rightScrollLeft = rightScrollEl?.scrollLeft ?? 0
      const rightScrollTop = rightScrollEl?.scrollTop ?? 0

      layoutCanvas(hiResLRef.current, leftScrollLeft, leftScrollTop)
      if (rightScrollEl) {
        layoutCanvas(hiResRRef.current, rightScrollLeft, rightScrollTop)
      } else {
        hiResRRef.current.style.width = cssW + 'px'
        hiResRRef.current.style.height = cssH + 'px'
      }

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

  // ─── Scroll listener: triggers hi-res re-render on scroll/drag ───

  useEffect(() => {
    const targets: HTMLElement[] = []
    if (leftPanelRef?.current) targets.push(leftPanelRef.current)
    if (rightPanelRef?.current) targets.push(rightPanelRef.current)
    if (containerRef.current && targets.length === 0) targets.push(containerRef.current)

    if (targets.length === 0) return

    for (const t of targets) {
      t.addEventListener('scroll', scheduleHiRes, { passive: true })
    }
    return () => {
      for (const t of targets) {
        t.removeEventListener('scroll', scheduleHiRes)
      }
    }
  }, [containerRef, leftPanelRef, rightPanelRef, scheduleHiRes])

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
