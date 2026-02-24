import { useRef } from 'react'
import { useCanvas } from '../hooks/useCanvas'
import LoadingOverlay from './LoadingOverlay'

export default function DiffCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const { hiResRef } = useCanvas(containerRef, canvasRef)

  return (
    <div
      ref={containerRef}
      className="relative flex-1 overflow-auto bg-bg-canvas"
    >
      <canvas ref={canvasRef} />
      <canvas
        ref={hiResRef}
        className="absolute pointer-events-none"
        style={{ display: 'none' }}
      />
      <LoadingOverlay />
    </div>
  )
}
