interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  suffix?: string
  onChange: (value: number) => void
}

export default function Slider({ label, value, min, max, suffix = '', onChange }: SliderProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-secondary whitespace-nowrap">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24"
      />
      <span className="text-xs text-text-secondary w-10 text-right tabular-nums">
        {value}{suffix}
      </span>
    </div>
  )
}
