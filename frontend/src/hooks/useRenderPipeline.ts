// ─── Cached pixel render pipeline ───
// Three-tier cache: rasterize → diff mask → colour application.
// Slider drags only run the final colouring step, skipping rasterization
// and mask building.  Output buffers are reused to avoid GC pressure.

import { useCallback, useEffect, useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import type { ImageSource } from '../lib/renderer'
import {
  DPR,
  getNaturalDimensions,
  setCanvasBacking,
  rasterize,
  buildDiffMask,
  applyDiffColors,
  applyOverlayColors,
  applySideAnnotatedColors,
  applyZoom,
  renderSideRaw,
} from '../lib/renderer'
import { consumePendingScroll, type PendingScroll } from './usePanZoom'
import { useRafScheduler } from '../lib/scheduling'

// ─── Cache types ───

interface RasterCache {
  imgOld: ImageSource
  imgNew: ImageSource
  pw: number
  ph: number
  dOld: ImageData
  dNew: ImageData
}

interface MaskCache {
  thresh: number
  mask: Uint8Array
}

export interface UseRenderPipelineOptions {
  canvasRef?: React.RefObject<HTMLCanvasElement | null>
  canvasLRef?: React.RefObject<HTMLCanvasElement | null>
  canvasRRef?: React.RefObject<HTMLCanvasElement | null>
  imagesRef: React.RefObject<{ imgOld: ImageSource; imgNew: ImageSource } | null>
  contentDimsRef: React.MutableRefObject<{ natW: number; natH: number } | null>
  pendingScrollRef: React.MutableRefObject<PendingScroll | null>
  scheduleHiRes: () => void
}

export interface UseRenderPipelineReturn {
  renderFrame: () => void
  invalidateCaches: () => void
}

export function useRenderPipeline({
  canvasRef,
  canvasLRef,
  canvasRRef,
  imagesRef,
  contentDimsRef,
  pendingScrollRef,
  scheduleHiRes,
}: UseRenderPipelineOptions): UseRenderPipelineReturn {
  // ─── Caches for intermediate results ───
  const rasterCacheRef = useRef<RasterCache | null>(null)
  const maskCacheRef = useRef<MaskCache | null>(null)

  // ─── Reusable output buffers (avoid GC pressure) ───
  const outputBufferRef = useRef<ImageData | null>(null)
  const outputBufferLRef = useRef<ImageData | null>(null)
  const outputBufferRRef = useRef<ImageData | null>(null)
  const maskBufferRef = useRef<Uint8Array | null>(null)

  const invalidateCaches = useCallback(() => {
    rasterCacheRef.current = null
    maskCacheRef.current = null
  }, [])

  // ─── Shared render function (uses cached raster + mask when possible) ───

  const renderFrame = useCallback(() => {
    const images = imagesRef.current
    if (!images) return

    const state = useDiffStore.getState()
    const { imgOld, imgNew } = images

    if (state.viewMode === 'side' && state.rawMode) {
      // Raw side-by-side: no pixel processing, just drawImage
      const cvsL = canvasLRef?.current
      const cvsR = canvasRRef?.current
      if (!cvsL || !cvsR) return
      const ctxL = cvsL.getContext('2d', { willReadFrequently: true })
      const ctxR = cvsR.getContext('2d', { willReadFrequently: true })
      if (!ctxL || !ctxR) return
      const { natW, natH } = getNaturalDimensions(imgOld, imgNew)
      renderSideRaw(cvsL, ctxL, imgOld, natW, natH, state.bgColor)
      renderSideRaw(cvsR, ctxR, imgNew, natW, natH, state.bgColor)
      contentDimsRef.current = { natW, natH }

      const currentZoom = state.zoom
      applyZoom(cvsL, natW, natH, currentZoom)
      applyZoom(cvsR, natW, natH, currentZoom)

      scheduleHiRes()
      return
    }

    // ── Step 1: Rasterize (cached by imgOld/imgNew identity + dimensions) ──
    const { natW, natH } = getNaturalDimensions(imgOld, imgNew)
    const pw = Math.round(natW * DPR)
    const ph = Math.round(natH * DPR)

    let dOld: ImageData
    let dNew: ImageData
    const rc = rasterCacheRef.current
    if (rc && rc.imgOld === imgOld && rc.imgNew === imgNew && rc.pw === pw && rc.ph === ph) {
      dOld = rc.dOld
      dNew = rc.dNew
    } else {
      dOld = rasterize(imgOld, pw, ph)
      dNew = rasterize(imgNew, pw, ph)
      rasterCacheRef.current = { imgOld, imgNew, pw, ph, dOld, dNew }
      // Raster changed → invalidate mask cache
      maskCacheRef.current = null
    }

    // ── Step 2: Build diff mask (cached by thresh) ──
    let mask: Uint8Array
    const mc = maskCacheRef.current
    if (mc && mc.thresh === state.thresh) {
      mask = mc.mask
    } else {
      // Reuse mask buffer if same size
      const bufSize = pw * ph
      if (!maskBufferRef.current || maskBufferRef.current.length !== bufSize) {
        maskBufferRef.current = new Uint8Array(bufSize)
      }
      mask = buildDiffMask(dOld.data, dNew.data, bufSize, state.thresh, maskBufferRef.current)
      maskCacheRef.current = { thresh: state.thresh, mask }
    }

    // ── Step 3: Apply colours (always runs — depends on fade/overlay/bgColor) ──
    contentDimsRef.current = { natW, natH }

    if (state.viewMode === 'diff') {
      const cvs = canvasRef?.current
      if (!cvs) return
      const ctx = cvs.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      setCanvasBacking(cvs, pw, ph)

      if (!outputBufferRef.current || outputBufferRef.current.width !== pw || outputBufferRef.current.height !== ph) {
        outputBufferRef.current = new ImageData(pw, ph)
      }
      const out = applyDiffColors(dOld.data, dNew.data, mask, state.fade, pw, ph, state.bgColor, outputBufferRef.current)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.putImageData(out, 0, 0)

      applyZoom(cvs, natW, natH, state.zoom)
    } else if (state.viewMode === 'overlay') {
      const cvs = canvasRef?.current
      if (!cvs) return
      const ctx = cvs.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      setCanvasBacking(cvs, pw, ph)

      if (!outputBufferRef.current || outputBufferRef.current.width !== pw || outputBufferRef.current.height !== ph) {
        outputBufferRef.current = new ImageData(pw, ph)
      }
      const out = applyOverlayColors(dOld.data, dNew.data, mask, state.overlay, pw, ph, state.bgColor, outputBufferRef.current)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.putImageData(out, 0, 0)

      applyZoom(cvs, natW, natH, state.zoom)
    } else if (state.viewMode === 'side') {
      // Annotated side-by-side
      const cvsL = canvasLRef?.current
      const cvsR = canvasRRef?.current
      if (!cvsL || !cvsR) return
      const ctxL = cvsL.getContext('2d', { willReadFrequently: true })
      const ctxR = cvsR.getContext('2d', { willReadFrequently: true })
      if (!ctxL || !ctxR) return
      setCanvasBacking(cvsL, pw, ph)
      setCanvasBacking(cvsR, pw, ph)

      if (!outputBufferLRef.current || outputBufferLRef.current.width !== pw || outputBufferLRef.current.height !== ph) {
        outputBufferLRef.current = new ImageData(pw, ph)
      }
      if (!outputBufferRRef.current || outputBufferRRef.current.width !== pw || outputBufferRRef.current.height !== ph) {
        outputBufferRRef.current = new ImageData(pw, ph)
      }
      const outL = applySideAnnotatedColors(dOld.data, dNew.data, pw, ph, true, state.fade, state.thresh, state.bgColor, outputBufferLRef.current, mask)
      const outR = applySideAnnotatedColors(dOld.data, dNew.data, pw, ph, false, state.fade, state.thresh, state.bgColor, outputBufferRRef.current, mask)
      ctxL.setTransform(1, 0, 0, 1, 0, 0)
      ctxL.putImageData(outL, 0, 0)
      ctxR.setTransform(1, 0, 0, 1, 0, 0)
      ctxR.putImageData(outR, 0, 0)

      applyZoom(cvsL, natW, natH, state.zoom)
      applyZoom(cvsR, natW, natH, state.zoom)
    }

    consumePendingScroll(pendingScrollRef)

    scheduleHiRes()
  }, [canvasRef, canvasLRef, canvasRRef, imagesRef, contentDimsRef, pendingScrollRef, scheduleHiRes])

  // ─── Effect B: Parameter rendering (lightweight — rAF-coalesced) ───

  const fade = useDiffStore((s) => s.fade)
  const thresh = useDiffStore((s) => s.thresh)
  const overlay = useDiffStore((s) => s.overlay)
  const bgColor = useDiffStore((s) => s.bgColor)
  const viewMode = useDiffStore((s) => s.viewMode)
  const rawMode = useDiffStore((s) => s.rawMode)

  const [scheduleParamRender] = useRafScheduler(renderFrame)

  useEffect(() => {
    // Skip if images haven't loaded yet (Effect A will call renderFrame)
    if (!imagesRef.current) return
    scheduleParamRender()
  }, [fade, thresh, overlay, bgColor, viewMode, rawMode, scheduleParamRender, imagesRef])

  return { renderFrame, invalidateCaches }
}
