// ─── GPU render pipeline ───
// Uses GLRenderer (WebGL) for all pixel-level diff/overlay/side rendering.
// Slider drags only update uniforms + one draw call (<0.5ms per frame).

import { useCallback, useEffect, useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import type { ImageSource } from '../lib/renderer'
import {
  DPR,
  getNaturalDimensions,
  applyZoom,
} from '../lib/renderer'
import { GLRenderer, ensureGL } from '../lib/glRenderer'
import { useRafScheduler } from '../lib/scheduling'

export interface UseRenderPipelineOptions {
  canvasRef?: React.RefObject<HTMLCanvasElement | null>
  canvasLRef?: React.RefObject<HTMLCanvasElement | null>
  canvasRRef?: React.RefObject<HTMLCanvasElement | null>
  imagesRef: React.RefObject<{ imgOld: ImageSource; imgNew: ImageSource } | null>
  contentDimsRef: React.MutableRefObject<{ natW: number; natH: number } | null>
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
  scheduleHiRes,
}: UseRenderPipelineOptions): UseRenderPipelineReturn {
  // GLRenderer instances (one per canvas)
  const glRef = useRef<GLRenderer | null>(null)
  const glLRef = useRef<GLRenderer | null>(null)
  const glRRef = useRef<GLRenderer | null>(null)

  const invalidateCaches = useCallback(() => {
    glRef.current?.invalidateTextures()
    glLRef.current?.invalidateTextures()
    glRRef.current?.invalidateTextures()
  }, [])

  // ─── Render function ───

  const renderFrame = useCallback(() => {
    const images = imagesRef.current
    if (!images) return

    const state = useDiffStore.getState()
    const { imgOld, imgNew } = images
    const { natW, natH } = getNaturalDimensions(imgOld, imgNew)
    const pw = Math.round(natW * DPR)
    const ph = Math.round(natH * DPR)

    contentDimsRef.current = { natW, natH }

    if (state.viewMode === 'side') {
      const cvsL = canvasLRef?.current
      const cvsR = canvasRRef?.current
      if (!cvsL || !cvsR) return

      const rendL = ensureGL(glLRef, cvsL)
      const rendR = ensureGL(glRRef, cvsR)

      if (state.rawMode) {
        rendL.uploadSingle(imgOld, pw, ph)
        rendR.uploadSingle(imgNew, pw, ph)
      } else {
        rendL.uploadPair(imgOld, imgNew, pw, ph)
        rendR.uploadPair(imgOld, imgNew, pw, ph)
      }

      rendL.setSize(pw, ph)
      rendR.setSize(pw, ph)
      rendL.resetViewport()
      rendR.resetViewport()

      if (state.rawMode) {
        rendL.renderRaw(state.bgColor)
        rendR.renderRaw(state.bgColor)
      } else {
        rendL.renderSideAnnotated(state.thresh, state.fade, state.bgColor, true)
        rendR.renderSideAnnotated(state.thresh, state.fade, state.bgColor, false)
      }

      applyZoom(cvsL, natW, natH, state.zoom)
      applyZoom(cvsR, natW, natH, state.zoom)
    } else {
      // Diff or overlay mode (single canvas)
      const cvs = canvasRef?.current
      if (!cvs) return

      const rend = ensureGL(glRef, cvs)
      rend.uploadPair(imgOld, imgNew, pw, ph)
      rend.setSize(pw, ph)
      rend.resetViewport()

      if (state.viewMode === 'diff') {
        rend.renderDiff(state.thresh, state.fade, state.bgColor)
      } else {
        rend.renderOverlay(state.thresh, state.overlay, state.bgColor)
      }

      applyZoom(cvs, natW, natH, state.zoom)
    }

    scheduleHiRes()
  }, [canvasRef, canvasLRef, canvasRRef, imagesRef, contentDimsRef, scheduleHiRes])

  // ─── Effect B: Parameter rendering (lightweight — rAF-coalesced) ───
  // Subscribe to render-relevant store fields directly (no reactive selectors)
  // to avoid re-rendering the host component on every slider drag.

  const [scheduleParamRender] = useRafScheduler(renderFrame)

  useEffect(() => {
    let prev = useDiffStore.getState()

    return useDiffStore.subscribe((state) => {
      const changed =
        state.fade !== prev.fade ||
        state.thresh !== prev.thresh ||
        state.overlay !== prev.overlay ||
        state.bgColor !== prev.bgColor ||
        state.viewMode !== prev.viewMode ||
        state.rawMode !== prev.rawMode
      prev = state
      if (!changed || !imagesRef.current) return
      scheduleParamRender()
    })
  }, [scheduleParamRender, imagesRef])

  // ─── Cleanup: dispose GLRenderers on unmount ───

  useEffect(() => {
    return () => {
      glRef.current?.dispose()
      glLRef.current?.dispose()
      glRRef.current?.dispose()
      glRef.current = null
      glLRef.current = null
      glRRef.current = null
    }
  }, [])

  return { renderFrame, invalidateCaches }
}
