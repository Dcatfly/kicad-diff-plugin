import { useCallback, useRef } from 'react'
import { useRafScheduler } from '../lib/scheduling'

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  suffix?: string
  disabled?: boolean
  onChange: (value: number) => void
}

export default function Slider({ label, value, min, max, suffix = '', disabled, onChange }: SliderProps) {
  const latestRef = useRef(value)

  const [scheduleFlush] = useRafScheduler(() => {
    onChange(latestRef.current)
  })

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    latestRef.current = Number(e.target.value)
    scheduleFlush()
  }, [scheduleFlush])

  return (
    <div className={`flex items-center gap-2${disabled ? ' opacity-40 pointer-events-none' : ''}`}>
      <span className="text-xs text-text-secondary whitespace-nowrap">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={handleChange}
        disabled={disabled}
        className="w-24"
      />
      <span className="text-xs text-text-secondary w-10 text-right tabular-nums">
        {value}{suffix}
      </span>
    </div>
  )
}
