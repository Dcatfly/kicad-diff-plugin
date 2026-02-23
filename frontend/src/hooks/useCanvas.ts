// ─── Canvas rendering + pan/zoom orchestration ───

import { useEffect, useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import { loadFilePair } from './useImageLoader'
import { renderDiff, renderOverlay, renderSide } from '../lib/renderer'
import { usePanZoom, type PendingScroll } from './usePanZoom'

export function useCanvas(
  containerRef: React.RefObject<HTMLElement | null>,
  canvasRef?: React.RefObject<HTMLCanvasElement | null>,
  canvasLRef?: React.RefObject<HTMLCanvasElement | null>,
  canvasRRef?: React.RefObject<HTMLCanvasElement | null>,
  leftPanelRef?: React.RefObject<HTMLElement | null>,
  rightPanelRef?: React.RefObject<HTMLElement | null>,
) {
  const renderTokenRef = useRef(0)
  const pendingScrollRef = useRef<PendingScroll | null>(null)

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

  useEffect(() => {
    if (!activeFileKey || !file) return

    const token = ++renderTokenRef.current

    let cancelled = false

    const doRender = async () => {
      setLoading(true, '')

      try {
        const { imgOld, imgNew } = await loadFilePair(file.oldSvg, file.newSvg)
        if (cancelled || token !== renderTokenRef.current) return

        if (viewMode === 'diff') {
          const cvs = canvasRef?.current
          if (!cvs) return
          const ctx = cvs.getContext('2d', { willReadFrequently: true })
          if (!ctx) return
          renderDiff(cvs, ctx, imgOld, imgNew, zoom, fade, thresh)
        } else if (viewMode === 'overlay') {
          const cvs = canvasRef?.current
          if (!cvs) return
          const ctx = cvs.getContext('2d')
          if (!ctx) return
          renderOverlay(cvs, ctx, imgOld, imgNew, zoom, overlay)
        } else if (viewMode === 'side') {
          const cvsL = canvasLRef?.current
          const cvsR = canvasRRef?.current
          if (!cvsL || !cvsR) return
          const ctxL = cvsL.getContext('2d', { willReadFrequently: true })
          const ctxR = cvsR.getContext('2d', { willReadFrequently: true })
          if (!ctxL || !ctxR) return
          renderSide(cvsL, ctxL, cvsR, ctxR, imgOld, imgNew, zoom, fade, thresh, rawMode)
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
  }, [activeFileKey, file, viewMode, rawMode, zoom, fade, thresh, overlay, canvasRef, canvasLRef, canvasRRef, setLoading])
}
