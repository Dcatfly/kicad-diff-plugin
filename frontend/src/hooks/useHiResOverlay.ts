// ─── Hi-res viewport overlay management ───
// Debounced pixel-perfect viewport rendering after scroll/zoom stabilises.

import { useCallback, useEffect, useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import type { ImageSource } from '../lib/renderer'
import {
  renderDiffViewport,
  renderOverlayViewport,
  renderSideAnnotatedViewport,
  renderSideRaw,
} from '../lib/renderer'
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

    if (state.viewMode === 'diff' && hiResRef.current) {
      hiResRef.current.style.left = (scrollEl.scrollLeft + offsetX) + 'px'
      hiResRef.current.style.top = (scrollEl.scrollTop + offsetY) + 'px'
      renderDiffViewport(
        hiResRef.current,
        images.imgOld, images.imgNew,
        state.fade, state.thresh,
        cx0, cy0, cw, ch, cssW, cssH,
        state.bgColor,
      )
      showHiRes(hiResRef)
    } else if (state.viewMode === 'overlay' && hiResRef.current) {
      hiResRef.current.style.left = (scrollEl.scrollLeft + offsetX) + 'px'
      hiResRef.current.style.top = (scrollEl.scrollTop + offsetY) + 'px'
      renderOverlayViewport(
        hiResRef.current,
        images.imgOld, images.imgNew,
        state.overlay, state.thresh,
        cx0, cy0, cw, ch, cssW, cssH,
        state.bgColor,
      )
      showHiRes(hiResRef)
    } else if (state.viewMode === 'side' && hiResLRef.current && hiResRRef.current) {
      const rightScrollEl = rightPanelRef?.current
      hiResLRef.current.style.left = (scrollEl.scrollLeft + offsetX) + 'px'
      hiResLRef.current.style.top = (scrollEl.scrollTop + offsetY) + 'px'
      if (rightScrollEl) {
        hiResRRef.current.style.left = (rightScrollEl.scrollLeft + offsetX) + 'px'
        hiResRRef.current.style.top = (rightScrollEl.scrollTop + offsetY) + 'px'
      }
      if (state.rawMode) {
        const ctxL = hiResLRef.current.getContext('2d')!
        const ctxR = hiResRRef.current.getContext('2d')!
        const viewport = { srcX: cx0, srcY: cy0, srcW: cw, srcH: ch, cssW, cssH }
        renderSideRaw(hiResLRef.current, ctxL, images.imgOld, dims.natW, dims.natH, state.bgColor, viewport)
        renderSideRaw(hiResRRef.current, ctxR, images.imgNew, dims.natW, dims.natH, state.bgColor, viewport)
      } else {
        renderSideAnnotatedViewport(
          hiResLRef.current, hiResRRef.current,
          images.imgOld, images.imgNew,
          state.fade, state.thresh,
          cx0, cy0, cw, ch, cssW, cssH,
          state.bgColor,
        )
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

  return { hiResRef, hiResLRef, hiResRRef, hideHiRes, scheduleHiRes }
}
