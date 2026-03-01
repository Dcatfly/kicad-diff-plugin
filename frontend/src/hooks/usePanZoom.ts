// ─── Wheel zoom (with anchor) + drag pan ───
// Uses CSS transform: translate() instead of native scroll for GPU-friendly compositing.

import { useEffect, useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'
import {
  ZOOM_MIN, ZOOM_MAX,
  ZOOM_STEP_SMALL, ZOOM_STEP_MEDIUM, ZOOM_STEP_LARGE,
  ZOOM_TIER_MEDIUM, ZOOM_TIER_LARGE,
} from '../lib/constants'

export interface PanState { x: number; y: number }

/** Clamp pan so the canvas can't be dragged past its edges. */
export function clampPan(
  pan: PanState,
  dims: { natW: number; natH: number } | null,
  zoom: number,
  containerEl: HTMLElement | null,
): PanState {
  if (!dims || !containerEl) return pan
  const scale = zoom / 100
  const contentW = dims.natW * scale
  const contentH = dims.natH * scale
  const maxX = Math.max(0, contentW - containerEl.clientWidth)
  const maxY = Math.max(0, contentH - containerEl.clientHeight)
  return {
    x: Math.max(0, Math.min(maxX, pan.x)),
    y: Math.max(0, Math.min(maxY, pan.y)),
  }
}

export function usePanZoom(
  containerRef: React.RefObject<HTMLElement | null>,
  panRef: React.MutableRefObject<PanState>,
  pendingPanRef: React.MutableRefObject<PanState | null>,
  contentDimsRef: React.RefObject<{ natW: number; natH: number } | null>,
  applyPan: () => void,
  leftPanelRef?: React.RefObject<HTMLElement | null>,
  rightPanelRef?: React.RefObject<HTMLElement | null>,
) {
  const panStartRef = useRef({ x: 0, y: 0 })
  const savedPanRef = useRef({ x: 0, y: 0 })
  const isDraggingRef = useRef(false)

  // ─── Wheel zoom (with anchor) ───
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleZoom = (e: WheelEvent) => {
      e.preventDefault()
      const state = useDiffStore.getState()
      const currentZoom = state.zoom
      const dims = contentDimsRef.current

      const step = currentZoom < ZOOM_TIER_MEDIUM ? ZOOM_STEP_SMALL : currentZoom < ZOOM_TIER_LARGE ? ZOOM_STEP_MEDIUM : ZOOM_STEP_LARGE
      const delta = e.deltaY > 0 ? -step : step
      const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, currentZoom + delta))
      if (newZoom === currentZoom) return

      // Determine the anchor element (may be a side panel in side mode)
      let anchorEl: HTMLElement = container
      if (state.viewMode === 'side' && leftPanelRef?.current) {
        const target = e.target as HTMLElement
        anchorEl = (target.closest('.side-panel') as HTMLElement) || leftPanelRef.current
      }

      const rect = anchorEl.getBoundingClientRect()
      const contentX = panRef.current.x + (e.clientX - rect.left)
      const contentY = panRef.current.y + (e.clientY - rect.top)
      const mouseOffX = e.clientX - rect.left
      const mouseOffY = e.clientY - rect.top
      const ratio = newZoom / currentZoom

      pendingPanRef.current = clampPan(
        { x: contentX * ratio - mouseOffX, y: contentY * ratio - mouseOffY },
        dims,
        newZoom,
        anchorEl,
      )

      useDiffStore.getState().setZoom(newZoom)
    }

    container.addEventListener('wheel', handleZoom, { passive: false })
    return () => container.removeEventListener('wheel', handleZoom)
  }, [containerRef, leftPanelRef, rightPanelRef, panRef, pendingPanRef, contentDimsRef])

  // ─── Drag pan ───
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      isDraggingRef.current = true
      panStartRef.current = { x: e.clientX, y: e.clientY }
      savedPanRef.current = { x: panRef.current.x, y: panRef.current.y }
      container.style.cursor = 'grabbing'
    }

    container.addEventListener('mousedown', onMouseDown)

    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const dx = e.clientX - panStartRef.current.x
      const dy = e.clientY - panStartRef.current.y
      const state = useDiffStore.getState()

      // In side mode, clamp against the left panel (both share the same pan)
      const clampEl = (state.viewMode === 'side' && leftPanelRef?.current)
        ? leftPanelRef.current
        : container

      const newPan = clampPan(
        { x: savedPanRef.current.x - dx, y: savedPanRef.current.y - dy },
        contentDimsRef.current,
        state.zoom,
        clampEl,
      )
      panRef.current = newPan
      applyPan()
    }

    const onMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false
        container.style.cursor = ''
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      container.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [containerRef, leftPanelRef, panRef, contentDimsRef, applyPan])

  // ─── ResizeObserver: clamp pan when container size changes ───
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const ro = new ResizeObserver(() => {
      const state = useDiffStore.getState()
      const clampEl = (state.viewMode === 'side' && leftPanelRef?.current)
        ? leftPanelRef.current
        : container

      panRef.current = clampPan(panRef.current, contentDimsRef.current, state.zoom, clampEl)
      applyPan()
    })

    ro.observe(container)
    if (leftPanelRef?.current) ro.observe(leftPanelRef.current)

    return () => ro.disconnect()
  }, [containerRef, leftPanelRef, panRef, contentDimsRef, applyPan])
}
