// ─── Canvas rendering + pan/zoom orchestration ───
// Two-layer architecture: base canvas at native resolution (CSS-scaled),
// hi-res overlay canvas for pixel-perfect viewport rendering (debounced).

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import { loadFilePair } from './useImageLoader'
import {
  renderDiff,
  renderOverlay,
  renderSide,
  applyZoom,
  renderDiffViewport,
  renderSideAnnotatedViewport,
} from '../lib/renderer'
import { usePanZoom, type PendingScroll } from './usePanZoom'

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
  const renderTokenRef = useRef(0)
  const pendingScrollRef = useRef<PendingScroll | null>(null)
  const contentDimsRef = useRef<{ natW: number; natH: number } | null>(null)
  const imagesRef = useRef<{ imgOld: CanvasImageSource; imgNew: CanvasImageSource } | null>(null)
  const hiResTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hiResRef = useRef<HTMLCanvasElement>(null)
  const hiResLRef = useRef<HTMLCanvasElement>(null)
  const hiResRRef = useRef<HTMLCanvasElement>(null)

  usePanZoom(containerRef, pendingScrollRef, leftPanelRef, rightPanelRef)

  const activeFileKey = useDiffStore((s) => s.activeFileKey)
  const file = useDiffStore((s) => s.activeFileKey ? s.files[s.activeFileKey] : undefined)
  const viewMode = useDiffStore((s) => s.viewMode)
  const rawMode = useDiffStore((s) => s.rawMode)
  const zoom = useDiffStore((s) => s.zoom)
  const fade = useDiffStore((s) => s.fade)
  const thresh = useDiffStore((s) => s.thresh)
  const overlay = useDiffStore((s) => s.overlay)
  const setLoading = useDiffStore((s) => s.setLoading)

  // ─── Helpers for hi-res overlay ───

  const hideHiRes = useCallback(() => {
    for (const ref of [hiResRef, hiResLRef, hiResRRef]) {
      if (ref.current) ref.current.style.display = 'none'
    }
  }, [])

  const showHiRes = useCallback((ref: React.RefObject<HTMLCanvasElement | null>) => {
    if (ref.current) ref.current.style.display = 'block'
  }, [])

  const scheduleHiRes = useCallback(() => {
    if (hiResTimerRef.current) clearTimeout(hiResTimerRef.current)
    hideHiRes()

    hiResTimerRef.current = setTimeout(() => {
      hiResTimerRef.current = null
      const dims = contentDimsRef.current
      const images = imagesRef.current
      if (!dims || !images) return

      const state = useDiffStore.getState()
      // Only needed for modes that do pixel-level operations
      const needsPixelOps =
        state.viewMode === 'diff' ||
        (state.viewMode === 'side' && !state.rawMode)
      if (!needsPixelOps) return

      const scrollEl =
        state.viewMode === 'side'
          ? leftPanelRef?.current
          : containerRef.current
      if (!scrollEl) return

      const scale = state.zoom / 100
      const vpW = scrollEl.clientWidth
      const vpH = scrollEl.clientHeight
      const srcX = scrollEl.scrollLeft / scale
      const srcY = scrollEl.scrollTop / scale
      const srcW = vpW / scale
      const srcH = vpH / scale

      if (state.viewMode === 'diff' && hiResRef.current) {
        // Position at scroll offset so it overlays the visible viewport
        hiResRef.current.style.left = scrollEl.scrollLeft + 'px'
        hiResRef.current.style.top = scrollEl.scrollTop + 'px'
        renderDiffViewport(
          hiResRef.current,
          images.imgOld, images.imgNew,
          state.fade, state.thresh,
          srcX, srcY, srcW, srcH, vpW, vpH,
        )
        showHiRes(hiResRef)
      } else if (state.viewMode === 'side' && hiResLRef.current && hiResRRef.current) {
        const rightScrollEl = rightPanelRef?.current
        // Position each overlay at its panel's scroll offset
        hiResLRef.current.style.left = scrollEl.scrollLeft + 'px'
        hiResLRef.current.style.top = scrollEl.scrollTop + 'px'
        if (rightScrollEl) {
          hiResRRef.current.style.left = rightScrollEl.scrollLeft + 'px'
          hiResRRef.current.style.top = rightScrollEl.scrollTop + 'px'
        }
        renderSideAnnotatedViewport(
          hiResLRef.current, hiResRRef.current,
          images.imgOld, images.imgNew,
          state.fade, state.thresh,
          srcX, srcY, srcW, srcH, vpW, vpH,
        )
        showHiRes(hiResLRef)
        showHiRes(hiResRRef)
      }
    }, 150)
  }, [hideHiRes, showHiRes, leftPanelRef, containerRef, rightPanelRef])

  // ─── Content effect: loads images, renders at native resolution ───
  // Does NOT depend on zoom — zoom is applied separately via CSS.

  useEffect(() => {
    if (!activeFileKey || !file) return

    const token = ++renderTokenRef.current
    let cancelled = false

    const doRender = async () => {
      setLoading(true, '')

      try {
        const { imgOld, imgNew } = await loadFilePair(file.oldSvg, file.newSvg)
        if (cancelled || token !== renderTokenRef.current) return

        imagesRef.current = { imgOld, imgNew }
        let dims: { natW: number; natH: number } | null = null

        if (viewMode === 'diff') {
          const cvs = canvasRef?.current
          if (!cvs) return
          const ctx = cvs.getContext('2d', { willReadFrequently: true })
          if (!ctx) return
          dims = renderDiff(cvs, ctx, imgOld, imgNew, fade, thresh)
        } else if (viewMode === 'overlay') {
          const cvs = canvasRef?.current
          if (!cvs) return
          const ctx = cvs.getContext('2d')
          if (!ctx) return
          dims = renderOverlay(cvs, ctx, imgOld, imgNew, overlay)
        } else if (viewMode === 'side') {
          const cvsL = canvasLRef?.current
          const cvsR = canvasRRef?.current
          if (!cvsL || !cvsR) return
          const ctxL = cvsL.getContext('2d', { willReadFrequently: true })
          const ctxR = cvsR.getContext('2d', { willReadFrequently: true })
          if (!ctxL || !ctxR) return
          dims = renderSide(cvsL, ctxL, cvsR, ctxR, imgOld, imgNew, fade, thresh, rawMode)
        }

        if (dims) {
          contentDimsRef.current = dims
          // Apply current zoom via CSS
          const currentZoom = useDiffStore.getState().zoom
          if (viewMode === 'diff' || viewMode === 'overlay') {
            if (canvasRef?.current) applyZoom(canvasRef.current, dims.natW, dims.natH, currentZoom)
          } else if (viewMode === 'side') {
            if (canvasLRef?.current) applyZoom(canvasLRef.current, dims.natW, dims.natH, currentZoom)
            if (canvasRRef?.current) applyZoom(canvasRRef.current, dims.natW, dims.natH, currentZoom)
          }
        }

        // Apply pending scroll adjustment after canvas has been resized
        if (pendingScrollRef.current) {
          const { targets, scrollLeft, scrollTop } = pendingScrollRef.current
          pendingScrollRef.current = null
          for (const el of targets) {
            el.scrollLeft = scrollLeft
            el.scrollTop = scrollTop
          }
        }

        // Schedule hi-res viewport rendering
        hideHiRes()
        scheduleHiRes()
      } finally {
        if (!cancelled && token === renderTokenRef.current) {
          setLoading(false)
        }
      }
    }

    const rafId = requestAnimationFrame(() => {
      doRender()
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
    // zoom is intentionally excluded — read via useDiffStore.getState() inside and handled by the zoom effect below
  }, [activeFileKey, file, viewMode, rawMode, fade, thresh, overlay, canvasRef, canvasLRef, canvasRRef, setLoading, hideHiRes, scheduleHiRes])

  // ─── Zoom effect: CSS-only, instant ───

  useLayoutEffect(() => {
    const dims = contentDimsRef.current
    if (!dims) return

    if (viewMode === 'diff' || viewMode === 'overlay') {
      if (canvasRef?.current) applyZoom(canvasRef.current, dims.natW, dims.natH, zoom)
    } else if (viewMode === 'side') {
      if (canvasLRef?.current) applyZoom(canvasLRef.current, dims.natW, dims.natH, zoom)
      if (canvasRRef?.current) applyZoom(canvasRRef.current, dims.natW, dims.natH, zoom)
    }

    // Apply pending scroll (anchor positioning)
    if (pendingScrollRef.current) {
      const { targets, scrollLeft, scrollTop } = pendingScrollRef.current
      pendingScrollRef.current = null
      for (const el of targets) {
        el.scrollLeft = scrollLeft
        el.scrollTop = scrollTop
      }
    }

    hideHiRes()
    scheduleHiRes()
  }, [zoom, viewMode, canvasRef, canvasLRef, canvasRRef, hideHiRes, scheduleHiRes])

  // ─── Scroll listener: triggers hi-res re-render on scroll/drag ───

  useEffect(() => {
    const targets: HTMLElement[] = []
    if (leftPanelRef?.current) targets.push(leftPanelRef.current)
    if (rightPanelRef?.current) targets.push(rightPanelRef.current)
    if (containerRef.current && targets.length === 0) targets.push(containerRef.current)

    if (targets.length === 0) return

    const onScroll = () => {
      hideHiRes()
      scheduleHiRes()
    }

    for (const t of targets) {
      t.addEventListener('scroll', onScroll, { passive: true })
    }
    return () => {
      for (const t of targets) {
        t.removeEventListener('scroll', onScroll)
      }
    }
  }, [containerRef, leftPanelRef, rightPanelRef, hideHiRes, scheduleHiRes])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (hiResTimerRef.current) clearTimeout(hiResTimerRef.current)
    }
  }, [])

  return { hiResRef, hiResLRef, hiResRRef }
}
