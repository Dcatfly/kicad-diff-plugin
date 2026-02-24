// ─── Wheel zoom (with anchor) + drag pan ───

import { useEffect, useRef } from 'react'
import { useDiffStore } from '../stores/useDiffStore'

export interface PendingScroll {
  targets: HTMLElement[]
  scrollLeft: number
  scrollTop: number
}

export function usePanZoom(
  containerRef: React.RefObject<HTMLElement | null>,
  pendingScrollRef: React.RefObject<PendingScroll | null>,
  leftPanelRef?: React.RefObject<HTMLElement | null>,
  rightPanelRef?: React.RefObject<HTMLElement | null>,
) {
  const panStartRef = useRef({ x: 0, y: 0 })
  const scrollStartRef = useRef({ x: 0, y: 0 })
  const activePanTargetRef = useRef<HTMLElement | null>(null)

  // Wheel zoom
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleZoom = (e: WheelEvent) => {
      e.preventDefault()
      const state = useDiffStore.getState()
      const currentZoom = state.zoom
      const mode = state.viewMode

      const step = currentZoom < 100 ? 10 : currentZoom < 300 ? 20 : 50
      const delta = e.deltaY > 0 ? -step : step
      const newZoom = Math.max(10, Math.min(800, currentZoom + delta))
      if (newZoom === currentZoom) return

      if (mode === 'side' && leftPanelRef?.current && rightPanelRef?.current) {
        const leftPanel = leftPanelRef.current
        const rightPanel = rightPanelRef.current
        const target = e.target as HTMLElement
        const anchorPanel = target.closest('.side-panel') as HTMLElement || leftPanel
        const rect = anchorPanel.getBoundingClientRect()
        const contentX = anchorPanel.scrollLeft + (e.clientX - rect.left)
        const contentY = anchorPanel.scrollTop + (e.clientY - rect.top)
        const mouseOffX = e.clientX - rect.left
        const mouseOffY = e.clientY - rect.top
        const ratio = newZoom / currentZoom

        pendingScrollRef.current = {
          targets: [leftPanel, rightPanel],
          scrollLeft: contentX * ratio - mouseOffX,
          scrollTop: contentY * ratio - mouseOffY,
        }
      } else {
        const rect = container.getBoundingClientRect()
        const contentX = container.scrollLeft + (e.clientX - rect.left)
        const contentY = container.scrollTop + (e.clientY - rect.top)
        const mouseOffX = e.clientX - rect.left
        const mouseOffY = e.clientY - rect.top
        const ratio = newZoom / currentZoom

        pendingScrollRef.current = {
          targets: [container],
          scrollLeft: contentX * ratio - mouseOffX,
          scrollTop: contentY * ratio - mouseOffY,
        }
      }

      useDiffStore.getState().setZoom(newZoom)
    }

    container.addEventListener('wheel', handleZoom, { passive: false })
    return () => container.removeEventListener('wheel', handleZoom)
  }, [containerRef, leftPanelRef, rightPanelRef, pendingScrollRef])

  // Scroll sync between side panels (covers scrollbar drag, keyboard, etc.)
  useEffect(() => {
    const leftPanel = leftPanelRef?.current
    const rightPanel = rightPanelRef?.current
    if (!leftPanel || !rightPanel) return

    let syncing = false

    const syncFrom = (source: HTMLElement, target: HTMLElement) => {
      if (syncing) return
      syncing = true
      target.scrollLeft = source.scrollLeft
      target.scrollTop = source.scrollTop
      syncing = false
    }

    const onLeftScroll = () => syncFrom(leftPanel, rightPanel)
    const onRightScroll = () => syncFrom(rightPanel, leftPanel)

    leftPanel.addEventListener('scroll', onLeftScroll, { passive: true })
    rightPanel.addEventListener('scroll', onRightScroll, { passive: true })
    return () => {
      leftPanel.removeEventListener('scroll', onLeftScroll)
      rightPanel.removeEventListener('scroll', onRightScroll)
    }
  }, [leftPanelRef, rightPanelRef])

  // Drag pan
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const hasSidePanels = !!(leftPanelRef?.current && rightPanelRef?.current)
    const targets: HTMLElement[] = hasSidePanels
      ? [leftPanelRef!.current!, rightPanelRef!.current!]
      : [container]

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = e.currentTarget as HTMLElement
      activePanTargetRef.current = target
      panStartRef.current = { x: e.clientX, y: e.clientY }
      scrollStartRef.current = { x: target.scrollLeft, y: target.scrollTop }
      target.style.cursor = 'grabbing'
    }

    for (const t of targets) {
      t.addEventListener('mousedown', onMouseDown)
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!activePanTargetRef.current) return
      const dx = e.clientX - panStartRef.current.x
      const dy = e.clientY - panStartRef.current.y
      const sl = scrollStartRef.current.x - dx
      const st = scrollStartRef.current.y - dy

      const leftPanel = leftPanelRef?.current
      const rightPanel = rightPanelRef?.current
      if (leftPanel && rightPanel && hasSidePanels) {
        leftPanel.scrollLeft = sl
        leftPanel.scrollTop = st
        rightPanel.scrollLeft = sl
        rightPanel.scrollTop = st
        return
      }
      activePanTargetRef.current.scrollLeft = sl
      activePanTargetRef.current.scrollTop = st
    }

    const onMouseUp = () => {
      if (activePanTargetRef.current) {
        activePanTargetRef.current.style.cursor = ''
      }
      activePanTargetRef.current = null
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      for (const t of targets) {
        t.removeEventListener('mousedown', onMouseDown)
      }
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [containerRef, leftPanelRef, rightPanelRef])
}
