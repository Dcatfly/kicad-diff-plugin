// ─── Canvas rendering + pan/zoom orchestration ───
// Two-layer architecture: base canvas at native resolution (CSS-scaled),
// hi-res overlay canvas for pixel-perfect viewport rendering (debounced).

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import { loadFilePair, loadLayerImageArrays } from './useImageLoader'
import type { ImageSource } from '../lib/renderer'
import {
  renderDiff,
  renderOverlay,
  renderSide,
  renderSideRaw,
  applyZoom,
  renderDiffViewport,
  renderOverlayViewport,
  renderSideAnnotatedViewport,
} from '../lib/renderer'
import { usePanZoom, type PendingScroll } from './usePanZoom'
import { HI_RES_DEBOUNCE_MS } from '../lib/constants'

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
  const imagesRef = useRef<{ imgOld: ImageSource; imgNew: ImageSource } | null>(null)
  const hiResTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hiResRef = useRef<HTMLCanvasElement>(null)
  const hiResLRef = useRef<HTMLCanvasElement>(null)
  const hiResRRef = useRef<HTMLCanvasElement>(null)

  usePanZoom(containerRef, pendingScrollRef, leftPanelRef, rightPanelRef)

  const sidebarTab = useDiffStore((s) => s.sidebarTab)
  const schematic = useDiffStore((s) =>
    s.activeSchematicKey ? s.schematics[s.activeSchematicKey] : undefined,
  )
  const pcbLayerPairs = useDiffStore((s) => s.pcbLayerPairs)
  const selectedPcbLayers = useDiffStore((s) => s.selectedPcbLayers)
  const viewMode = useDiffStore((s) => s.viewMode)
  const rawMode = useDiffStore((s) => s.rawMode)
  const zoom = useDiffStore((s) => s.zoom)
  const fade = useDiffStore((s) => s.fade)
  const thresh = useDiffStore((s) => s.thresh)
  const overlay = useDiffStore((s) => s.overlay)
  const bgColor = useDiffStore((s) => s.bgColor)
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
      const viewport = { srcX: cx0, srcY: cy0, srcW: cw, srcH: ch, cssW, cssH }

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
  }, [hideHiRes, showHiRes, leftPanelRef, containerRef, rightPanelRef])

  // ─── Content effect: loads images, renders at native resolution ───
  // Does NOT depend on zoom — zoom is applied separately via CSS.

  useEffect(() => {
    // Need either a schematic or selected PCB layers to render
    const hasContent =
      sidebarTab === 'sch'
        ? !!schematic
        : selectedPcbLayers.length > 0

    if (!hasContent) {
      // Clear stale canvas content and state
      imagesRef.current = null
      contentDimsRef.current = null
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
      return
    }

    const token = ++renderTokenRef.current
    let cancelled = false

    const doRender = async () => {
      setLoading(true, '')

      try {
        let imgOld: ImageSource
        let imgNew: ImageSource

        if (sidebarTab === 'sch' && schematic) {
          ;({ imgOld, imgNew } = await loadFilePair(schematic.oldSvg, schematic.newSvg))
        } else {
          const activePairs = selectedPcbLayers
            .map((l) => pcbLayerPairs[l])
            .filter(Boolean)
          ;({ imgOld, imgNew } = await loadLayerImageArrays(activePairs))
        }
        if (cancelled || token !== renderTokenRef.current) return

        imagesRef.current = { imgOld, imgNew }
        let dims: { natW: number; natH: number } | null = null

        if (viewMode === 'diff') {
          const cvs = canvasRef?.current
          if (!cvs) return
          const ctx = cvs.getContext('2d', { willReadFrequently: true })
          if (!ctx) return
          dims = renderDiff(cvs, ctx, imgOld, imgNew, fade, thresh, bgColor)
        } else if (viewMode === 'overlay') {
          const cvs = canvasRef?.current
          if (!cvs) return
          const ctx = cvs.getContext('2d', { willReadFrequently: true })
          if (!ctx) return
          dims = renderOverlay(cvs, ctx, imgOld, imgNew, overlay, thresh, bgColor)
        } else if (viewMode === 'side') {
          const cvsL = canvasLRef?.current
          const cvsR = canvasRRef?.current
          if (!cvsL || !cvsR) return
          const ctxL = cvsL.getContext('2d', { willReadFrequently: true })
          const ctxR = cvsR.getContext('2d', { willReadFrequently: true })
          if (!ctxL || !ctxR) return
          dims = renderSide(cvsL, ctxL, cvsR, ctxR, imgOld, imgNew, fade, thresh, rawMode, bgColor)
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
  }, [sidebarTab, schematic, selectedPcbLayers, pcbLayerPairs, viewMode, rawMode, fade, thresh, overlay, bgColor, canvasRef, canvasLRef, canvasRRef, setLoading, hideHiRes, scheduleHiRes])

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
